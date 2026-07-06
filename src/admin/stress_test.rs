//! 凭证压力测试模块
//!
//! 提供两类压力测试，明确区分：
//! - **并发测试（Concurrency）**：在给定并发数下尽可能快地打满请求，衡量峰值吞吐与延迟分布。
//!   - 子策略 Concurrent：所有凭证请求混合后按全局并发数同时发出（真实压力）。
//!   - 子策略 Sequential：逐个凭证测试，每个凭证内部使用并发数（排查问题）。
//! - **RPM 速率测试（Rpm）**：按固定的「每分钟请求数」节奏匀速发出请求，持续指定时长，
//!   衡量在稳定速率下的成功率/延迟/限流情况（贴近真实业务 QPS 而非峰值打爆）。
//!
//! 两种模式都复用 `AdminService::stress_probe` 做真实上游 TTFB 探针，统计 P50/P95/P99/Max，
//! 运行中可停止；进度通过全局会话注册表暴露，由 `/stress-test/{id}/status` 轮询读取。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::admin::service::AdminService;
use crate::admin::stress::{StressOutcome, StressProbeResult};

/// 全局会话注册表：session_id -> 会话状态
static SESSIONS: LazyLock<RwLock<HashMap<String, Arc<SessionState>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// 最多保留的历史会话数（防止内存无限增长）
const MAX_SESSIONS: usize = 20;

/// RPM 模式下同时在途请求的安全上限（防止上游慢响应导致请求无限堆积）
const RPM_MAX_INFLIGHT: usize = 2048;

/// 测试模式（顶层区分：并发测试 vs RPM 速率测试）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestMode {
    /// 并发测试：按并发数尽快打满固定请求量，衡量峰值吞吐
    Concurrency,
    /// RPM 速率测试：按固定每分钟请求数匀速发出，持续指定时长
    Rpm,
}

impl Default for TestMode {
    fn default() -> Self {
        TestMode::Concurrency
    }
}

/// 并发测试的子策略
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestStrategy {
    /// 所有凭证的请求混合后按全局并发数同时发出（真实压力）
    Concurrent,
    /// 逐个凭证测试，每个凭证内部使用并发数（排查问题）
    Sequential,
}

impl Default for TestStrategy {
    fn default() -> Self {
        TestStrategy::Concurrent
    }
}

/// 测试配置
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StressTestConfig {
    /// 选中的凭证 ID 列表
    pub credential_ids: Vec<i64>,
    /// 测试模型
    pub model: String,
    /// max_tokens
    #[serde(default = "default_max_tokens")]
    pub max_tokens: i32,

    /// 测试模式（默认并发测试，向后兼容旧前端）
    #[serde(default)]
    pub mode: TestMode,

    // ===== 并发测试参数 =====
    /// 并发数（并发测试模式使用）
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    /// 每个凭证的请求数（并发测试模式使用）
    #[serde(default = "default_rpc")]
    pub requests_per_credential: usize,
    /// 并发测试子策略（默认 Concurrent）
    #[serde(default)]
    pub strategy: TestStrategy,

    // ===== RPM 速率测试参数 =====
    /// 目标每分钟请求数（RPM 模式使用）
    #[serde(default = "default_target_rpm")]
    pub target_rpm: usize,
    /// 持续时长（秒，RPM 模式使用）
    #[serde(default = "default_duration_secs")]
    pub duration_secs: usize,
}

fn default_max_tokens() -> i32 {
    4
}
fn default_concurrency() -> usize {
    8
}
fn default_rpc() -> usize {
    50
}
fn default_target_rpm() -> usize {
    60
}
fn default_duration_secs() -> usize {
    60
}

/// 单凭证累加器（运行期使用原子量 + 延迟列表）
struct CredAccum {
    total: AtomicUsize,
    success: AtomicUsize,
    failed: AtomicUsize,
    status_429: AtomicUsize,
    status_500: AtomicUsize,
    status_4xx_other: AtomicUsize,
    network_errors: AtomicUsize,
    setup_errors: AtomicUsize,
    retry_after_count: AtomicUsize,
    status_counts: Mutex<HashMap<u16, usize>>,
    retry_after_secs: Mutex<Vec<f64>>,
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
            status_4xx_other: AtomicUsize::new(0),
            network_errors: AtomicUsize::new(0),
            setup_errors: AtomicUsize::new(0),
            retry_after_count: AtomicUsize::new(0),
            status_counts: Mutex::new(HashMap::new()),
            retry_after_secs: Mutex::new(Vec::new()),
            latencies_ms: Mutex::new(Vec::new()),
        }
    }

    fn record(&self, probe: &StressProbeResult) {
        self.total.fetch_add(1, Ordering::Relaxed);
        if probe.is_success() {
            self.success.fetch_add(1, Ordering::Relaxed);
        } else {
            self.failed.fetch_add(1, Ordering::Relaxed);
        }
        match probe.status {
            Some(429) => {
                self.status_429.fetch_add(1, Ordering::Relaxed);
            }
            Some(s) if (400..500).contains(&s) => {
                self.status_4xx_other.fetch_add(1, Ordering::Relaxed);
            }
            Some(s) if (500..600).contains(&s) => {
                self.status_500.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
        match &probe.outcome {
            StressOutcome::Http { retry_after_secs } => {
                if let Some(status) = probe.status {
                    if let Ok(mut m) = self.status_counts.lock() {
                        *m.entry(status).or_insert(0) += 1;
                    }
                }
                if let Some(v) = retry_after_secs {
                    self.retry_after_count.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut xs) = self.retry_after_secs.lock() {
                        xs.push(*v);
                    }
                }
                if let Ok(mut v) = self.latencies_ms.lock() {
                    v.push(probe.elapsed_ms);
                }
            }
            StressOutcome::Network(err) => {
                let _ = err.len();
                self.network_errors.fetch_add(1, Ordering::Relaxed);
            }
            StressOutcome::Setup(err) => {
                let _ = err.len();
                self.setup_errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// 会话运行状态（内部可变，跨任务共享）
struct SessionState {
    id: String,
    model: String,
    mode: TestMode,
    strategy: TestStrategy,
    concurrency: usize,
    requests_per_credential: usize,
    target_rpm: usize,
    duration_secs: usize,
    started_at: Instant,
    total_requests: usize,
    completed: AtomicUsize,
    /// 已派发（发起）的请求数，RPM 模式用于观测节奏是否跟得上
    dispatched: AtomicUsize,
    /// 当前在途请求数
    inflight: AtomicUsize,
    running: AtomicBool,
    finished: AtomicBool,
    /// 固定 key（创建时确定），值通过内部可变性更新
    accums: HashMap<i64, CredAccum>,
    /// 排序后的凭证顺序（用于稳定输出）
    cred_order: Vec<i64>,
    /// 压测专用 HTTP client 缓存（按凭据缓存，避免每请求重建 rustls/client）。
    clients: Mutex<HashMap<i64, reqwest::Client>>,
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
    pub status_4xx_other: usize,
    pub network_errors: usize,
    pub setup_errors: usize,
    pub retry_after_count: usize,
    pub retry_after_max: Option<f64>,
    pub latency_samples: usize,
    pub status_counts: HashMap<u16, usize>,
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
    pub mode: TestMode,
    pub strategy: TestStrategy,
    pub concurrency: usize,
    /// RPM 模式：目标每分钟请求数
    pub target_rpm: usize,
    /// RPM 模式：持续时长（秒）
    pub duration_secs: usize,
    pub running: bool,
    pub finished: bool,
    pub total_requests: usize,
    pub completed_requests: usize,
    /// 已派发请求数（RPM 模式观测节奏）
    pub dispatched_requests: usize,
    /// 当前在途请求数
    pub inflight_requests: usize,
    pub progress: f64,
    pub elapsed_ms: u128,
    /// 实时吞吐（已完成请求 / 已用秒数）
    pub rps: f64,
    /// 实时每分钟完成数（= rps * 60），RPM 模式用于对照目标
    pub actual_rpm: f64,
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
                let retry_after_max = acc
                    .retry_after_secs
                    .lock()
                    .map(|v| {
                        v.iter().copied().fold(None, |max, x| match max {
                            Some(m) if m >= x => Some(m),
                            _ => Some(x),
                        })
                    })
                    .unwrap_or(None);
                let status_counts = acc
                    .status_counts
                    .lock()
                    .map(|m| m.clone())
                    .unwrap_or_default();
                results.push(CredentialTestResult {
                    credential_id: cred_id,
                    total: acc.total.load(Ordering::Relaxed),
                    success: acc.success.load(Ordering::Relaxed),
                    failed: acc.failed.load(Ordering::Relaxed),
                    status_429: acc.status_429.load(Ordering::Relaxed),
                    status_500: acc.status_500.load(Ordering::Relaxed),
                    status_4xx_other: acc.status_4xx_other.load(Ordering::Relaxed),
                    network_errors: acc.network_errors.load(Ordering::Relaxed),
                    setup_errors: acc.setup_errors.load(Ordering::Relaxed),
                    retry_after_count: acc.retry_after_count.load(Ordering::Relaxed),
                    retry_after_max,
                    latency_samples: lat.len(),
                    status_counts,
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
            mode: self.mode,
            strategy: self.strategy,
            concurrency: self.concurrency,
            target_rpm: self.target_rpm,
            duration_secs: self.duration_secs,
            running: self.running.load(Ordering::Relaxed),
            finished: self.finished.load(Ordering::Relaxed),
            total_requests: self.total_requests,
            completed_requests: completed,
            dispatched_requests: self.dispatched.load(Ordering::Relaxed),
            inflight_requests: self.inflight.load(Ordering::Relaxed),
            progress,
            elapsed_ms,
            rps,
            actual_rpm: rps * 60.0,
            results,
        }
    }
}

/// 启动一次压力测试，返回 (session_id, total_requests)。
pub fn start_session(config: StressTestConfig, service: Arc<AdminService>) -> (String, usize) {
    let id = Uuid::new_v4().to_string();
    let mode = config.mode;
    let model = if config.model.trim().is_empty() {
        "claude-opus-4.8".to_string()
    } else {
        config.model.trim().to_string()
    };
    let max_tokens = config.max_tokens.clamp(1, 4096);

    let mut cred_order: Vec<i64> = config.credential_ids.clone();
    cred_order.sort_unstable();
    cred_order.dedup();

    let concurrency = config.concurrency.clamp(1, 256);
    let rpc = config.requests_per_credential.max(1);
    let target_rpm = config.target_rpm.clamp(1, 600_000);
    let duration_secs = config.duration_secs.clamp(1, 3600);

    // 总请求量：并发模式 = 凭证数 * 每凭证请求数；RPM 模式 = 目标速率按时长换算
    let total_requests = match mode {
        TestMode::Concurrency => cred_order.len() * rpc,
        TestMode::Rpm => ((target_rpm as f64) * (duration_secs as f64) / 60.0).round() as usize,
    }
    .max(1);

    let mut accums = HashMap::new();
    for &cid in &cred_order {
        accums.insert(cid, CredAccum::new());
    }

    let state = Arc::new(SessionState {
        id: id.clone(),
        model: model.clone(),
        mode,
        strategy: config.strategy,
        concurrency,
        requests_per_credential: rpc,
        target_rpm,
        duration_secs,
        started_at: Instant::now(),
        total_requests,
        completed: AtomicUsize::new(0),
        dispatched: AtomicUsize::new(0),
        inflight: AtomicUsize::new(0),
        running: AtomicBool::new(true),
        finished: AtomicBool::new(false),
        accums,
        cred_order: cred_order.clone(),
        clients: Mutex::new(HashMap::new()),
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
            for k in stale
                .into_iter()
                .take(reg.len().saturating_sub(MAX_SESSIONS) + 1)
            {
                reg.remove(&k);
            }
        }
        reg.insert(id.clone(), state.clone());
    }

    tokio::spawn(async move {
        run_session(state, service, model, max_tokens).await;
    });

    (id, total_requests)
}

/// 执行一次真实上游请求并记录统计。
async fn run_one_request(
    state: &Arc<SessionState>,
    service: &Arc<AdminService>,
    model: &str,
    max_tokens: i32,
    cred_id: i64,
) {
    if !state.running.load(Ordering::Relaxed) {
        return;
    }
    // `max_tokens` 在 Kiro 原生流式协议中无等价字段；保留入参仅为 API 向后兼容。
    // 压测器现在测的是 HTTP TTFB 并立即断流，不读取生成 body，因此不会让输出长度污染并发/RPM 统计。
    let _ = max_tokens;

    let client = match state.clients.lock() {
        Ok(mut clients) => {
            if let Some(client) = clients.get(&cred_id) {
                client.clone()
            } else {
                match service.stress_build_client_for(cred_id as u64) {
                    Ok(client) => {
                        clients.insert(cred_id, client.clone());
                        client
                    }
                    Err(e) => {
                        if let Some(acc) = state.accums.get(&cred_id) {
                            acc.record(&StressProbeResult {
                                status: None,
                                elapsed_ms: 0.0,
                                outcome: StressOutcome::Setup(e.to_string()),
                            });
                        }
                        state.completed.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                }
            }
        }
        Err(_) => {
            if let Some(acc) = state.accums.get(&cred_id) {
                acc.record(&StressProbeResult {
                    status: None,
                    elapsed_ms: 0.0,
                    outcome: StressOutcome::Setup("client cache poisoned".to_string()),
                });
            }
            state.completed.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };

    state.inflight.fetch_add(1, Ordering::Relaxed);
    let probe = service.stress_probe(cred_id as u64, model, &client).await;
    if let Some(acc) = state.accums.get(&cred_id) {
        acc.record(&probe);
    }
    state.completed.fetch_add(1, Ordering::Relaxed);
    state.inflight.fetch_sub(1, Ordering::Relaxed);
}

async fn run_session(
    state: Arc<SessionState>,
    service: Arc<AdminService>,
    model: String,
    max_tokens: i32,
) {
    match state.mode {
        TestMode::Concurrency => {
            run_concurrency_mode(&state, &service, &model, max_tokens).await;
        }
        TestMode::Rpm => {
            run_rpm_mode(&state, &service, &model, max_tokens).await;
        }
    }

    // 等待在途请求收尾（最多再等 30 秒，避免卡死）
    let drain_deadline = Instant::now() + Duration::from_secs(30);
    while state.inflight.load(Ordering::Relaxed) > 0 && Instant::now() < drain_deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    state.running.store(false, Ordering::Relaxed);
    state.finished.store(true, Ordering::Relaxed);
}

/// 并发测试模式：按并发数尽快打满固定请求量。
async fn run_concurrency_mode(
    state: &Arc<SessionState>,
    service: &Arc<AdminService>,
    model: &str,
    max_tokens: i32,
) {
    let rpc = state.requests_per_credential;
    let concurrency = state.concurrency;

    let run_one = |cred_id: i64| {
        let service = service.clone();
        let state = state.clone();
        let model = model.to_string();
        async move {
            run_one_request(&state, &service, &model, max_tokens, cred_id).await;
        }
    };

    match state.strategy {
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
}

/// RPM 速率测试模式：按固定每分钟请求数匀速派发，持续指定时长。
///
/// 派发与执行解耦：定时器按节奏 `spawn` 请求任务（不阻塞节奏），
/// 凭证按轮询方式均摊；在途请求设安全上限，超过则跳过本拍（记为节奏落后）。
async fn run_rpm_mode(
    state: &Arc<SessionState>,
    service: &Arc<AdminService>,
    model: &str,
    max_tokens: i32,
) {
    let target_rpm = state.target_rpm.max(1);
    // 每请求间隔（毫秒）：60_000 / rpm
    let interval_ms = (60_000.0 / target_rpm as f64).max(0.001);
    let total = state.total_requests;
    let deadline = state.started_at + Duration::from_secs(state.duration_secs as u64);

    let creds = state.cred_order.clone();
    if creds.is_empty() {
        return;
    }

    let mut next_at = Instant::now();
    let mut dispatched = 0usize;
    let mut rr = 0usize;

    while dispatched < total && Instant::now() < deadline {
        if !state.running.load(Ordering::Relaxed) {
            break;
        }

        // 等到下一拍
        let now = Instant::now();
        if next_at > now {
            tokio::time::sleep(next_at - now).await;
        }
        if !state.running.load(Ordering::Relaxed) {
            break;
        }

        // 在途上限保护：超限则本拍不发（仍推进节奏，记为已派发以保持时长内总量节奏）
        if state.inflight.load(Ordering::Relaxed) < RPM_MAX_INFLIGHT {
            let cred_id = creds[rr % creds.len()];
            rr = rr.wrapping_add(1);
            dispatched += 1;
            state.dispatched.fetch_add(1, Ordering::Relaxed);

            let service = service.clone();
            let state2 = state.clone();
            let model = model.to_string();
            tokio::spawn(async move {
                run_one_request(&state2, &service, &model, max_tokens, cred_id).await;
            });
        }

        // 推进到下一拍（用累加避免漂移）
        next_at += Duration::from_secs_f64(interval_ms / 1000.0);
    }
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
