//! 同一 Kiro 官方账号/profile 的自适应并发限流器。
//!
//! 这是面向所有凭据的闭环控制器，而不是针对某个账号的固定阈值：
//! - 初始目标来自 `Config::effective_max_in_flight` / 凭据 `maxInFlight`；
//! - `maxInFlight` 作为基准值与 UI 操作入口，不再是硬上限，控制器允许向上探测真实容量；
//! - 成功请求上报 RTT，用延迟梯度 `rtt_min / rtt_current` 判断是否开始排队；
//! - 429/账号风控走乘性退避；timeout/524/read error/5xx 等软错误也走强退避；
//! - 平稳成功时 AIMD 加性增长，自动收敛到“刚好不排队/不报错”的并发。
//!
//! 采用 `Mutex<state> + Notify` 自管 in-flight 计数（而非 tokio `Semaphore`），
//! 这样「缩容」对已持有的请求不强行打断、仅让新请求等待，已持有者释放后自然收敛。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::Notify;

/// 单 key 并发硬上限，防止探测失控。
const HARD_CAP: usize = 512;
/// 配置值可被自适应探测突破的倍数。
const PROBE_MULTIPLIER: usize = 4;
/// 配置值之外至少允许探测的额外并发。
const MIN_PROBE_HEADROOM: usize = 32;
/// RTT 指数滑动平均权重，越大越重视新样本。
const RTT_EWMA_ALPHA: f64 = 0.20;
/// 近期最优 RTT 会缓慢上浮，避免永久锚定历史极低值。
const RTT_MIN_DECAY_ALPHA: f64 = 0.02;
/// 延迟梯度低于此值，说明排队/拥塞已经明显。
const GRADIENT_DROP_THRESHOLD: f64 = 0.72;
/// 延迟梯度高于此值且无软错误时，允许加性探测。
const GRADIENT_GROW_THRESHOLD: f64 = 0.90;
/// 加性增长最短间隔。
const GROW_INTERVAL: Duration = Duration::from_secs(8);
/// 乘性退避后保护期，避免刚缩容立刻又探测。
const BACKOFF_QUIET_PERIOD: Duration = Duration::from_secs(12);
/// 每多少个成功样本至少评估一次控制律。
const SUCCESS_EVAL_EVERY: u64 = 4;

/// 单个 account key 限流器的可观测快照（供 admin 面板展示）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimiterSnapshot {
    /// account key（profile:/email:/credential: 前缀）。
    pub key: String,
    /// 当前在途上游请求数。
    pub in_flight: usize,
    /// 配置基准并发（maxInFlight ∩ 档位默认）。
    pub configured: usize,
    /// 自适应当前允许并发（四舍五入后）。
    pub current_limit: usize,
    /// 探测硬 cap。
    pub probe_cap: usize,
    /// 近期最优 RTT（毫秒）。
    pub rtt_min_ms: Option<f64>,
    /// 当前 RTT EWMA（毫秒）。
    pub rtt_current_ms: Option<f64>,
    /// 延迟梯度 rtt_min/rtt_current（0-1，越低越拥塞）。
    pub gradient: Option<f64>,
    /// 累计成功样本数。
    pub success_count: u64,
    /// 累计 429/风控次数。
    pub throttle_count: u64,
    /// 累计软错误（timeout/524/5xx）次数。
    pub soft_error_count: u64,
}

struct Inner {
    /// 当前正在占用该 key 的上游请求数。
    in_flight: usize,
    /// 配置目标并发（凭据级覆盖 ?? 档位默认）。作为基准/初值，不再是硬上限。
    configured: usize,
    /// 自适应当前目标并发。
    limit: f64,
    /// 允许探测的硬 cap：`max(configured * PROBE_MULTIPLIER, configured + MIN_PROBE_HEADROOM)`。
    probe_cap: usize,
    /// 最近一次发起请求的时间，用于最小间隔限速。
    last_start: Option<Instant>,
    /// 近期最优 RTT（秒）。
    rtt_min: Option<f64>,
    /// 当前 RTT EWMA（秒）。
    rtt_current: Option<f64>,
    /// 成功样本数。
    success_count: u64,
    /// 自上次调整以来的连续成功数。
    success_since_adjust: u64,
    /// 429/风控次数。
    throttle_count: u64,
    /// timeout/524/read error/5xx 等软错误次数。
    soft_error_count: u64,
    /// 最近一次加性增长时间。
    last_grow_at: Instant,
    /// 最近一次乘性退避时间。
    last_backoff_at: Option<Instant>,
}

impl Inner {
    fn target(&self) -> usize {
        self.limit.round().clamp(1.0, self.probe_cap as f64) as usize
    }

    fn gradient(&self) -> Option<f64> {
        match (self.rtt_min, self.rtt_current) {
            (Some(min), Some(cur)) if cur > 0.0 => Some((min / cur).clamp(0.05, 1.5)),
            _ => None,
        }
    }

    fn recompute_probe_cap(configured: usize) -> usize {
        let c = configured.clamp(1, HARD_CAP);
        c.saturating_mul(PROBE_MULTIPLIER)
            .max(c.saturating_add(MIN_PROBE_HEADROOM))
            .clamp(1, HARD_CAP)
    }

    fn backoff(&mut self, factor: f64, floor: f64) {
        self.limit = (self.limit * factor)
            .floor()
            .max(floor)
            .min(self.probe_cap as f64);
        self.success_since_adjust = 0;
        self.last_backoff_at = Some(Instant::now());
    }
}

/// 单个 account key 的自适应限流器。
pub struct AdaptiveLimiter {
    inner: Mutex<Inner>,
    notify: Notify,
}

impl AdaptiveLimiter {
    fn new(configured: usize) -> Self {
        let c = configured.clamp(1, HARD_CAP);
        let now = Instant::now();
        Self {
            inner: Mutex::new(Inner {
                in_flight: 0,
                configured: c,
                limit: c as f64,
                probe_cap: Inner::recompute_probe_cap(c),
                last_start: None,
                rtt_min: None,
                rtt_current: None,
                success_count: 0,
                success_since_adjust: 0,
                throttle_count: 0,
                soft_error_count: 0,
                last_grow_at: now,
                last_backoff_at: None,
            }),
            notify: Notify::new(),
        }
    }

    /// 同步配置目标并发（运行时改配置/改凭据 maxInFlight 时调用）。
    ///
    /// ⚠️ 关键：每个请求经 `get_or_update` 都会调到这里。若配置值未变，必须是 no-op，
    /// 否则会把 `on_throttle`/延迟梯度刚压低的 `limit` 又顶回基准，导致自适应退避
    /// 被每个新请求无条件撤销（实测表现为 429 不断但并发死钉在 maxInFlight）。
    /// 只有 admin 真正改了 maxInFlight（configured 发生变化）时才调整 `limit`。
    fn set_configured(&self, configured: usize) {
        let c = configured.clamp(1, HARD_CAP);
        let mut g = self.inner.lock();
        if c == g.configured {
            // 常规请求路径：配置未变，不触碰自适应 limit。
            return;
        }
        let raised = c > g.configured;
        let old_cap = g.probe_cap;
        g.configured = c;
        g.probe_cap = Inner::recompute_probe_cap(c);
        // 仅在 admin 上调配置时把当前 limit 至少抬到新基准；下调配置时不强行砍到基准，
        // 但限制在新的 probe_cap 内，让“允许突破 maxInFlight”仍受安全 cap 约束。
        if raised && g.limit < c as f64 {
            g.limit = c as f64;
        }
        if g.limit > g.probe_cap as f64 {
            g.limit = g.probe_cap as f64;
        }
        let wake = g.probe_cap > old_cap || g.target() > g.in_flight;
        drop(g);
        if wake {
            self.notify.notify_waiters();
        }
    }

    /// 获取一个并发名额；超过当前 target 时异步等待。
    /// 获得名额后按 `min_interval` 做最小间隔限速，再返回 RAII permit。
    async fn acquire(self: &Arc<Self>, min_interval: Duration) -> LimiterPermit {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        loop {
            // 先登记 waiter，避免 check 与 await 之间丢失唤醒。
            notified.as_mut().enable();
            {
                let mut g = self.inner.lock();
                if g.in_flight < g.target() {
                    g.in_flight += 1;
                    break;
                }
            }
            notified.as_mut().await;
            notified.set(self.notify.notified());
        }

        let permit = LimiterPermit {
            limiter: Arc::clone(self),
        };

        // 最小间隔限速：同一 key 两次发起至少间隔 min_interval。
        if !min_interval.is_zero() {
            let wait = {
                let mut g = self.inner.lock();
                let now = Instant::now();
                match g.last_start {
                    Some(prev) => {
                        let elapsed = now.saturating_duration_since(prev);
                        if elapsed < min_interval {
                            min_interval - elapsed
                        } else {
                            g.last_start = Some(now);
                            Duration::ZERO
                        }
                    }
                    None => {
                        g.last_start = Some(now);
                        Duration::ZERO
                    }
                }
            };
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
                self.inner.lock().last_start = Some(Instant::now());
            }
        }

        permit
    }

    /// 观测到 429 / 账号风控：以「触发 429 时的并发」为拥塞点，乘性退避到其下方。
    pub fn on_throttle(&self, observed_in_flight: u64) {
        let mut g = self.inner.lock();
        g.throttle_count += 1;
        // 拥塞点取「触发时并发」与当前 limit 的较小值；observed 缺失(0)时退回当前 limit。
        // 乘性退避（×0.70）必须真正生效，下限固定为 1，不能用 observed-1 当下限——
        // 否则触发 429 时 observed≈limit 会把退避抵消成每次仅 -1，收敛极慢。
        let congestion_point = if observed_in_flight > 0 {
            (observed_in_flight as f64).min(g.limit)
        } else {
            g.limit
        };
        g.backoff(0.70, 1.0);
        // 额外保证退避后的 limit 不高于拥塞点的 0.70（即便此前 limit 已更低也无妨）。
        let capped = (congestion_point * 0.70).floor().max(1.0);
        if capped < g.limit {
            g.limit = capped;
        }
    }

    /// 观测到 timeout / 524 / read error / 5xx：软错误退避。
    pub fn on_soft_error(&self) {
        let mut g = self.inner.lock();
        g.soft_error_count += 1;
        // 软错误通常是已经压过拐点；比 429 稍保守，但足够快地离开雪崩区。
        g.backoff(0.80, 1.0);
    }

    /// 一次成功：上报端到端 RTT，并基于延迟梯度 + AIMD 调整 limit。
    pub fn on_success(&self, rtt: Duration) {
        let mut g = self.inner.lock();
        let sample = rtt.as_secs_f64().max(0.001);

        g.rtt_current = Some(match g.rtt_current {
            Some(cur) => cur * (1.0 - RTT_EWMA_ALPHA) + sample * RTT_EWMA_ALPHA,
            None => sample,
        });
        g.rtt_min = Some(match g.rtt_min {
            Some(min) if sample < min => sample,
            Some(min) => min * (1.0 - RTT_MIN_DECAY_ALPHA) + sample * RTT_MIN_DECAY_ALPHA,
            None => sample,
        });
        g.success_count += 1;
        g.success_since_adjust += 1;

        if g.success_since_adjust < SUCCESS_EVAL_EVERY {
            return;
        }

        let now = Instant::now();
        if let Some(last) = g.last_backoff_at {
            if now.duration_since(last) < BACKOFF_QUIET_PERIOD {
                return;
            }
        }

        let gradient = match g.gradient() {
            Some(v) => v,
            None => return,
        };

        if gradient < GRADIENT_DROP_THRESHOLD {
            // 延迟明显劣化：按梯度比例乘性缩容，至少乘 0.75，避免一次样本砍太狠。
            let factor = gradient.clamp(0.55, 0.85);
            g.backoff(factor, 1.0);
            return;
        }

        if gradient >= GRADIENT_GROW_THRESHOLD
            && now.duration_since(g.last_grow_at) >= GROW_INTERVAL
        {
            let old = g.target();
            g.limit = (g.limit + 1.0).min(g.probe_cap as f64);
            g.success_since_adjust = 0;
            g.last_grow_at = now;
            let new = g.target();
            drop(g);
            if new > old {
                self.notify.notify_one();
            }
        }
    }

    /// 导出可观测快照（不发任何上游请求，仅读内部状态）。
    pub fn snapshot(&self, key: String) -> LimiterSnapshot {
        let g = self.inner.lock();
        LimiterSnapshot {
            key,
            in_flight: g.in_flight,
            configured: g.configured,
            current_limit: g.target(),
            probe_cap: g.probe_cap,
            rtt_min_ms: g.rtt_min.map(|v| v * 1000.0),
            rtt_current_ms: g.rtt_current.map(|v| v * 1000.0),
            gradient: g.gradient(),
            success_count: g.success_count,
            throttle_count: g.throttle_count,
            soft_error_count: g.soft_error_count,
        }
    }
}

/// 持有期间占用一个并发名额，drop 时归还并唤醒等待者。
pub struct LimiterPermit {
    limiter: Arc<AdaptiveLimiter>,
}

impl Drop for LimiterPermit {
    fn drop(&mut self) {
        {
            let mut g = self.limiter.inner.lock();
            g.in_flight = g.in_flight.saturating_sub(1);
        }
        self.limiter.notify.notify_one();
    }
}

/// 按 account key 维护自适应限流器的注册表。
pub struct AccountRateLimiters {
    map: Mutex<HashMap<String, Arc<AdaptiveLimiter>>>,
}

impl Default for AccountRateLimiters {
    fn default() -> Self {
        Self::new()
    }
}

impl AccountRateLimiters {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    /// 取得（或新建）某 key 的限流器，并把配置目标同步为最新值。
    pub fn get_or_update(&self, key: &str, configured: usize) -> Arc<AdaptiveLimiter> {
        let mut m = self.map.lock();
        match m.get(key) {
            Some(l) => {
                l.set_configured(configured);
                Arc::clone(l)
            }
            None => {
                let l = Arc::new(AdaptiveLimiter::new(configured));
                m.insert(key.to_string(), Arc::clone(&l));
                l
            }
        }
    }

    /// 取已存在的限流器（用于上报，不新建）。
    pub fn get(&self, key: &str) -> Option<Arc<AdaptiveLimiter>> {
        self.map.lock().get(key).map(Arc::clone)
    }

    /// 导出所有 account key 的可观测快照（按 current_limit 降序）。
    pub fn snapshots(&self) -> Vec<LimiterSnapshot> {
        let mut out: Vec<LimiterSnapshot> = self
            .map
            .lock()
            .iter()
            .map(|(key, limiter)| limiter.snapshot(key.clone()))
            .collect();
        out.sort_by(|a, b| b.current_limit.cmp(&a.current_limit));
        out
    }
}

/// 便捷入口：取得限流器并获取一个名额。
pub async fn acquire_permit(
    limiters: &AccountRateLimiters,
    key: &str,
    configured: usize,
    min_interval: Duration,
) -> LimiterPermit {
    let limiter = limiters.get_or_update(key, configured);
    limiter.acquire(min_interval).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_is_baseline_not_hard_cap() {
        let l = AdaptiveLimiter::new(10);
        {
            let mut g = l.inner.lock();
            g.last_grow_at = Instant::now() - GROW_INTERVAL;
        }
        for _ in 0..80 {
            l.on_success(Duration::from_millis(100));
            l.inner.lock().last_grow_at = Instant::now() - GROW_INTERVAL;
        }
        let g = l.inner.lock();
        assert!(g.target() > 10);
        assert!(g.target() <= g.probe_cap);
    }

    #[test]
    fn repeated_set_configured_same_value_does_not_undo_backoff() {
        // 复现生产 bug：每个请求都会 set_configured(同值)，不能把退避顶回去。
        let l = AdaptiveLimiter::new(32);
        l.on_throttle(32);
        let after_backoff = l.inner.lock().target();
        assert!(after_backoff <= 23);
        for _ in 0..10 {
            l.set_configured(32);
        }
        assert_eq!(
            l.inner.lock().target(),
            after_backoff,
            "set_configured 同值不应恢复 limit"
        );
    }

    #[test]
    fn throttle_drops_limit() {
        let l = AdaptiveLimiter::new(32);
        l.on_throttle(32);
        // 32 触发 429 → 应退避到 32*0.70 = 22 附近，而不是仅 -1
        assert!(
            l.inner.lock().target() <= 23,
            "limit={}",
            l.inner.lock().target()
        );
    }

    #[test]
    fn repeated_throttle_converges_fast() {
        let l = AdaptiveLimiter::new(32);
        for _ in 0..6 {
            let obs = l.inner.lock().target() as u64;
            l.on_throttle(obs);
        }
        // 连续 6 次 429 应快速收敛到个位数附近
        assert!(
            l.inner.lock().target() <= 6,
            "limit={}",
            l.inner.lock().target()
        );
    }

    #[test]
    fn soft_error_backs_off() {
        let l = AdaptiveLimiter::new(20);
        l.on_soft_error();
        assert!(l.inner.lock().target() < 20);
    }

    #[test]
    fn high_latency_gradient_drops() {
        let l = AdaptiveLimiter::new(20);
        for _ in 0..12 {
            l.on_success(Duration::from_millis(100));
        }
        let before = l.inner.lock().target();
        for _ in 0..8 {
            l.on_success(Duration::from_millis(400));
        }
        assert!(l.inner.lock().target() < before);
    }

    #[tokio::test]
    async fn acquire_blocks_beyond_target_and_releases() {
        let l = Arc::new(AdaptiveLimiter::new(1));
        let p1 = l.acquire(Duration::ZERO).await;
        assert_eq!(l.inner.lock().in_flight, 1);
        let l2 = Arc::clone(&l);
        let handle = tokio::spawn(async move { l2.acquire(Duration::ZERO).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!handle.is_finished());
        drop(p1);
        let _p2 = handle.await.unwrap();
        assert_eq!(l.inner.lock().in_flight, 1);
    }
}
