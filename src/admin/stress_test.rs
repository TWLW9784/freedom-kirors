//! 凭证压力测试模块
//!
//! 提供批量压力测试功能，支持：
//! - 多凭证并发测试（复用 AdminService::test_credential_model 真实上游调用）
//! - 实时进度与性能统计（P50/P95/P99/Max）
//! - 运行中可停止
//!
//! 进度通过全局会话注册表暴露，由 `/stress-test/{id}/status` 轮询读取。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::Instant;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::admin::service::AdminService;
use crate::admin::types::TestCredentialModelRequest;

/// 全局会话注册表：session_id -> 会话状态
static SESSIONS: LazyLock<RwLock<HashMap<String, Arc<SessionState>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// 最多保留的历史会话数（防止内存无限增长）
const MAX_SESSIONS: usize = 20;

/// 测试策略
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestStrategy {
    /// 所有凭证的请求混合后按全局并发数同时发出（真实压力）
    Concurrent,
    /// 逐个凭证测试，每个凭证内部使用并发数（排查问题）
    Sequential,
}

/// 测试配置
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StressTestConfig {
    /// 选中的凭证 ID 列表
    pub credential_ids: Vec<i64>,
    /// 测试模型
    pub model: String,
    /// 并发数
    pub concurrency: usize,
    /// 每个凭证的请求数
    pub requests_per_credential: usize,
    /// max_tokens
    #[serde(default = "default_max_tokens")]
    pub max_tokens: i32,
    /// 测试策略
    pub strategy: TestStrategy,
}

fn default_max_tokens() -> i32 {
    4
}

/// 单凭证累加器（运行期使用原子量 + 延迟列表）
struct CredAccum {
    total: AtomicUsize,
    success: AtomicUsize,
    failed: AtomicUsize,
    status_429: AtomicUsize,
    status_500: AtomicUsize,
    latencies_ms: Mutex<Vec<f64>>,
}

impl CredAccum {
    fn new() -> Self {
        Self {
            total: AtomicUsize::new(0),
            success: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            status_429: AtomicUsize::new(0),
            status_500: AtomicUsize::new(0),
            latencies_ms: Mutex::new(Vec::new()),
        }
    }

    fn record(&self, ok: bool, status: Option<u16>, elapsed_ms: f64) {
        self.total.fetch_add(1, Ordering::Relaxed);
        if ok {
            self.success.fetch_add(1, Ordering::Relaxed);
        } else {
            self.failed.fetch_add(1, Ordering::Relaxed);
        }
        match status {
            Some(429) => {
                self.status_429.fetch_add(1, Ordering::Relaxed);
            }
            Some(s) if (500..600).contains(&s) => {
                self.status_500.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
        if let Ok(mut v) = self.latencies_ms.lock() {
            v.push(elapsed_ms);
        }
    }
}

/// 会话运行状态（内部可变，跨任务共享）
struct SessionState {
    id: String,
    model: String,
    strategy: TestStrategy,
    concurrency: usize,
    requests_per_credential: usize,
    started_at: Instant,
    total_requests: usize,
    completed: AtomicUsize,
    running: AtomicBool,
    finished: AtomicBool,
    /// 固定 key（创建时确定），值通过内部可变性更新
    accums: HashMap<i64, CredAccum>,
    /// 排序后的凭证顺序（用于稳定输出）
    cred_order: Vec<i64>,
}

/// 单凭证测试结果（对外 JSON）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialTestResult {
    pub credential_id: i64,
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub status_429: usize,
    pub status_500: usize,
    pub latency_p50: f64,
    pub latency_p95: f64,
    pub latency_p99: f64,
    pub latency_max: f64,
}

/// 会话状态快照（对外 JSON，供前端轮询）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StressTestStatus {
    pub session_id: String,
    pub model: String,
    pub strategy: TestStrategy,
    pub concurrency: usize,
    pub running: bool,
    pub finished: bool,
    pub total_requests: usize,
    pub completed_requests: usize,
    pub progress: f64,
    pub elapsed_ms: u128,
    pub rps: f64,
    pub results: Vec<CredentialTestResult>,
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = (p / 100.0) * ((sorted.len() - 1) as f64);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let frac = rank - lo as f64;
        sorted[lo] + (sorted[hi] - sorted[lo]) * frac
    }
}

impl SessionState {
    fn snapshot(&self) -> StressTestStatus {
        let completed = self.completed.load(Ordering::Relaxed);
        let elapsed = self.started_at.elapsed();
        let elapsed_ms = elapsed.as_millis();
        let elapsed_secs = elapsed.as_secs_f64();
        let rps = if elapsed_secs > 0.0 {
            completed as f64 / elapsed_secs
        } else {
            0.0
        };

        let mut results = Vec::with_capacity(self.cred_order.len());
        for &cred_id in &self.cred_order {
            if let Some(acc) = self.accums.get(&cred_id) {
                let mut lat = acc
                    .latencies_ms
                    .lock()
                    .map(|v| v.clone())
                    .unwrap_or_default();
                lat.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                results.push(CredentialTestResult {
                    credential_id: cred_id,
                    total: acc.total.load(Ordering::Relaxed),
                    success: acc.success.load(Ordering::Relaxed),
                    failed: acc.failed.load(Ordering::Relaxed),
                    status_429: acc.status_429.load(Ordering::Relaxed),
                    status_500: acc.status_500.load(Ordering::Relaxed),
                    latency_p50: percentile(&lat, 50.0),
                    latency_p95: percentile(&lat, 95.0),
                    latency_p99: percentile(&lat, 99.0),
                    latency_max: lat.last().copied().unwrap_or(0.0),
                });
            }
        }

        let progress = if self.total_requests > 0 {
            (completed as f64 / self.total_requests as f64) * 100.0
        } else {
            100.0
        };

        StressTestStatus {
            session_id: self.id.clone(),
            model: self.model.clone(),
            strategy: self.strategy,
            concurrency: self.concurrency,
            running: self.running.load(Ordering::Relaxed),
            finished: self.finished.load(Ordering::Relaxed),
            total_requests: self.total_requests,
            completed_requests: completed,
            progress,
            elapsed_ms,
            rps,
            results,
        }
    }
}

/// 启动一次压力测试，返回 (session_id, total_requests)。
pub fn start_session(config: StressTestConfig, service: Arc<AdminService>) -> (String, usize) {
    let id = Uuid::new_v4().to_string();
    let concurrency = config.concurrency.clamp(1, 256);
    let rpc = config.requests_per_credential.max(1);
    let model = if config.model.trim().is_empty() {
        "claude-opus-4.8".to_string()
    } else {
        config.model.trim().to_string()
    };
    let max_tokens = config.max_tokens.clamp(1, 4096);

    let mut cred_order: Vec<i64> = config.credential_ids.clone();
    cred_order.sort_unstable();
    cred_order.dedup();

    let total_requests = cred_order.len() * rpc;

    let mut accums = HashMap::new();
    for &id in &cred_order {
        accums.insert(id, CredAccum::new());
    }

    let state = Arc::new(SessionState {
        id: id.clone(),
        model: model.clone(),
        strategy: config.strategy,
        concurrency,
        requests_per_credential: rpc,
        started_at: Instant::now(),
        total_requests,
        completed: AtomicUsize::new(0),
        running: AtomicBool::new(true),
        finished: AtomicBool::new(false),
        accums,
        cred_order: cred_order.clone(),
    });

    {
        let mut reg = SESSIONS.write().unwrap();
        // 清理过旧的已结束会话
        if reg.len() >= MAX_SESSIONS {
            let stale: Vec<String> = reg
                .iter()
                .filter(|(_, s)| s.finished.load(Ordering::Relaxed))
                .map(|(k, _)| k.clone())
                .collect();
            for k in stale.into_iter().take(reg.len().saturating_sub(MAX_SESSIONS) + 1) {
                reg.remove(&k);
            }
        }
        reg.insert(id.clone(), state.clone());
    }

    let strategy = config.strategy;
    tokio::spawn(async move {
        run_session(state, service, model, max_tokens, rpc, concurrency, strategy).await;
    });

    (id, total_requests)
}

async fn run_session(
    state: Arc<SessionState>,
    service: Arc<AdminService>,
    model: String,
    max_tokens: i32,
    rpc: usize,
    concurrency: usize,
    strategy: TestStrategy,
) {
    let run_one = |cred_id: i64| {
        let service = service.clone();
        let state = state.clone();
        let model = model.clone();
        async move {
            if !state.running.load(Ordering::Relaxed) {
                return;
            }
            let req = TestCredentialModelRequest {
                model: model.clone(),
                prompt: "ping".to_string(),
                max_tokens,
            };
            let resp = service.test_credential_model(cred_id as u64, req).await;
            let (ok, status, elapsed_ms) = match resp {
                Ok(r) => (r.ok, r.status, r.elapsed_ms as f64),
                Err(_) => (false, None, 0.0),
            };
            if let Some(acc) = state.accums.get(&cred_id) {
                acc.record(ok, status, elapsed_ms);
            }
            state.completed.fetch_add(1, Ordering::Relaxed);
        }
    };

    match strategy {
        TestStrategy::Concurrent => {
            // 所有凭证的请求混合，按全局并发数发出
            let mut tasks: Vec<i64> = Vec::with_capacity(state.cred_order.len() * rpc);
            for _ in 0..rpc {
                for &cred_id in &state.cred_order {
                    tasks.push(cred_id);
                }
            }
            futures::stream::iter(tasks.into_iter().map(run_one))
                .buffer_unordered(concurrency)
                .collect::<Vec<()>>()
                .await;
        }
        TestStrategy::Sequential => {
            // 逐个凭证，每个凭证内部使用并发数
            for &cred_id in &state.cred_order {
                if !state.running.load(Ordering::Relaxed) {
                    break;
                }
                let reqs: Vec<i64> = std::iter::repeat(cred_id).take(rpc).collect();
                futures::stream::iter(reqs.into_iter().map(&run_one))
                    .buffer_unordered(concurrency)
                    .collect::<Vec<()>>()
                    .await;
            }
        }
    }

    state.running.store(false, Ordering::Relaxed);
    state.finished.store(true, Ordering::Relaxed);
}

/// 读取会话状态快照。
pub fn get_status(session_id: &str) -> Option<StressTestStatus> {
    let reg = SESSIONS.read().unwrap();
    reg.get(session_id).map(|s| s.snapshot())
}

/// 请求停止会话；返回是否找到会话。
pub fn stop_session(session_id: &str) -> bool {
    let reg = SESSIONS.read().unwrap();
    if let Some(s) = reg.get(session_id) {
        s.running.store(false, Ordering::Relaxed);
        true
    } else {
        false
    }
}
