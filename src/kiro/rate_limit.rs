//! 同一 Kiro 官方账号/profile 的自适应并发限流器。
//!
//! 这是面向所有凭据的闭环控制器，而不是针对某个账号的固定阈值：
//! - 起步并发（baseline）来自 `Config::effective_max_in_flight` / 凭据 `maxInFlight`；
//! - baseline 作为基准值与 UI 操作入口，不再是硬上限，控制器允许向上探测真实容量（至 ceiling）；
//! - **只信硬信号降速**：429/风控用滑动窗口错误率触发乘性退避，上游 5xx/524 走软退避；
//! - **延迟仅作提速闸门，永不主动降速**：RTT 只用于展示与「是否允许加性提速」的判断；
//! - **时间驱动自愈**：闲置或被打到 floor 的账号，随时间无条件回爬到 baseline，解死锁；
//! - 链路层错误（timeout/connect/read）只记录展示计数，不动账号 limit。
//!
//! 采用 `Mutex<state> + Notify` 自管 in-flight 计数（而非 tokio `Semaphore`），
//! 这样「缩容」对已持有的请求不强行打断、仅让新请求等待，已持有者释放后自然收敛。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::Notify;

/// 单 key 并发硬上限，防止探测失控。
const HARD_CAP: usize = 512;
/// baseline 可被自适应探测突破的倍数（用于计算 ceiling）。
const PROBE_MULTIPLIER: usize = 4;
/// baseline 之外至少允许探测的额外并发（用于计算 ceiling）。
const MIN_PROBE_HEADROOM: usize = 32;
/// 退避硬下限。
const FLOOR: usize = 1;
/// RTT 指数滑动平均权重，越大越重视新样本（仅展示 + 提速闸门）。
const RTT_EWMA_ALPHA: f64 = 0.20;
/// 近期最优 RTT 会缓慢上浮，避免永久锚定历史极低值。
const RTT_MIN_DECAY_ALPHA: f64 = 0.02;
/// 滑动窗口 429 率触发退避的阈值。
const THROTTLE_RATE_TRIP: f64 = 0.10;
/// 触发退避所需的窗口最小样本数（吸收瞬时抖动）。
const MIN_SAMPLES: usize = 5;
/// 429/风控命中率阈值后的乘性退避因子。
const THROTTLE_BACKOFF: f64 = 0.70;
/// 上游 5xx/524 软错误的乘性退避因子。
const SOFT_BACKOFF: f64 = 0.80;
/// 乘性退避后保护期，避免刚缩容立刻又探测。
const BACKOFF_QUIET: Duration = Duration::from_secs(12);
/// 延迟梯度高于此值（或无样本）时才允许加性提速。
const GRADIENT_GROW_THRESHOLD: f64 = 0.90;
/// 加性增长最短间隔。
const GROW_INTERVAL: Duration = Duration::from_secs(8);
/// 加性增长步长比例（让大号回血快）。
const GROW_FRAC: f64 = 0.10;
/// 时间驱动自愈的冷却期：距上次退避至少这么久才开始无条件回爬。
const RECOVER_COOLDOWN: Duration = Duration::from_secs(15);
/// 滑动窗口时长：统计最近该时段内的 429/Success 结果。
const OUTCOME_WINDOW: Duration = Duration::from_secs(60);

/// 滑动窗口内的单次结果。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Throttle,
    Success,
}

/// 单个 account key 限流器的可观测快照（供 admin 面板展示）。
///
/// 字段名与前端 `types/api.ts` 冻结契约严格对应（camelCase）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimiterSnapshot {
    /// account key（profile:/email:/credential: 前缀）。
    pub key: String,
    /// 当前在途上游请求数。
    pub in_flight: usize,
    /// 起步基准并发（原 configured；maxInFlight ∩ 档位默认）。
    pub baseline: usize,
    /// 自适应当前允许并发（四舍五入后）。
    pub current_limit: usize,
    /// 退避硬下限（通常 1）。
    pub floor: usize,
    /// 探测硬上限（原 probeCap）。
    pub ceiling: usize,
    /// 状态机（后端直接算好下发，前端直接显示）。
    pub state: String,
    /// 滑动窗口 429 率（0.0-1.0）。
    pub throttle_rate: f64,
    /// 当前 RTT EWMA（毫秒，仅展示）。
    pub rtt_current_ms: Option<f64>,
    /// 近期最优 RTT（毫秒，仅展示）。
    pub rtt_min_ms: Option<f64>,
    /// 累计成功样本数。
    pub success_count: u64,
    /// 累计 429/风控次数。
    pub throttle_count: u64,
    /// 累计软错误（上游 5xx/524 + 链路层）次数。
    pub soft_error_count: u64,
    /// 距上次退避毫秒，null=从未退避。
    pub last_backoff_ago_ms: Option<u64>,
}

struct Inner {
    /// 当前正在占用该 key 的上游请求数。
    in_flight: usize,
    /// 起步基准并发（凭据级覆盖 ?? 档位默认）。作为基准/初值，不再是硬上限。
    baseline: usize,
    /// 退避硬下限。
    floor: usize,
    /// 探测硬上限：`max(baseline*PROBE_MULTIPLIER, baseline+MIN_PROBE_HEADROOM)` clamp HARD_CAP。
    ceiling: usize,
    /// 自适应当前目标并发。
    limit: f64,
    /// 最近一次发起请求的时间，用于最小间隔限速。
    last_start: Option<Instant>,
    /// 最近 60 秒内的请求发起时间点，用于「突发滑动窗口」RPM 限速（仅 rpm_burst 模式使用）。
    recent_starts: VecDeque<Instant>,
    /// 滑动窗口错误率：最近 OUTCOME_WINDOW 内的 (时刻, 结果)。
    recent_outcomes: VecDeque<(Instant, Outcome)>,
    /// 近期最优 RTT（秒，仅展示 + 提速闸门）。
    rtt_min: Option<f64>,
    /// 当前 RTT EWMA（秒，仅展示 + 提速闸门）。
    rtt_current: Option<f64>,
    /// 成功样本数。
    success_count: u64,
    /// 429/风控次数。
    throttle_count: u64,
    /// 软错误（上游 5xx/524 + 链路层 timeout/connect/read）次数。
    soft_error_count: u64,
    /// 最近一次加性增长/自愈时间。
    last_grow_at: Instant,
    /// 最近一次乘性退避时间。
    last_backoff_at: Option<Instant>,
}

impl Inner {
    /// 当前目标并发：round 后 clamp 到 [floor, ceiling]。
    fn target(&self) -> usize {
        self.limit
            .round()
            .clamp(self.floor as f64, self.ceiling as f64) as usize
    }

    /// 延迟梯度 rtt_min/rtt_current，clamp 0.05..1.5；无样本返回 None。
    fn gradient(&self) -> Option<f64> {
        match (self.rtt_min, self.rtt_current) {
            (Some(min), Some(cur)) if cur > 0.0 => Some((min / cur).clamp(0.05, 1.5)),
            _ => None,
        }
    }

    /// 探测硬上限计算。
    fn recompute_ceiling(baseline: usize) -> usize {
        let b = baseline.clamp(1, HARD_CAP);
        b.saturating_mul(PROBE_MULTIPLIER)
            .max(b.saturating_add(MIN_PROBE_HEADROOM))
            .clamp(1, HARD_CAP)
    }

    /// 记录一次结果到滑动窗口并顺带裁剪过期项。
    fn push_outcome(&mut self, now: Instant, outcome: Outcome) {
        self.recent_outcomes.push_back((now, outcome));
        self.prune_outcomes(now);
    }

    /// 裁剪滑动窗口内超过 OUTCOME_WINDOW 的过期项。
    fn prune_outcomes(&mut self, now: Instant) {
        while let Some(&(t, _)) = self.recent_outcomes.front() {
            if now.saturating_duration_since(t) >= OUTCOME_WINDOW {
                self.recent_outcomes.pop_front();
            } else {
                break;
            }
        }
    }

    /// 统计窗口内 (429 次数, 总样本数)（只读，不裁剪，按 now 过滤）。
    fn window_counts(&self, now: Instant) -> (usize, usize) {
        let mut throttles = 0usize;
        let mut total = 0usize;
        for &(t, o) in self.recent_outcomes.iter() {
            if now.saturating_duration_since(t) < OUTCOME_WINDOW {
                total += 1;
                if o == Outcome::Throttle {
                    throttles += 1;
                }
            }
        }
        (throttles, total)
    }

    /// 滑动窗口 429 率（0.0-1.0）。
    fn throttle_rate(&self, now: Instant) -> f64 {
        let (thr, total) = self.window_counts(now);
        if total > 0 {
            thr as f64 / total as f64
        } else {
            0.0
        }
    }

    /// 是否处于退避静默期。
    fn in_backoff_quiet(&self, now: Instant) -> bool {
        match self.last_backoff_at {
            Some(t) => now.saturating_duration_since(t) < BACKOFF_QUIET,
            None => false,
        }
    }

    /// 计算状态机（后端下发，前端直接显示）。
    fn state(&self, now: Instant) -> &'static str {
        // 无任何流量 → idle。
        if self.in_flight == 0
            && self.success_count == 0
            && self.throttle_count == 0
            && self.soft_error_count == 0
        {
            return "idle";
        }

        let current = self.target();
        let baseline = self.baseline;
        let gradient = self.gradient();

        if current < baseline {
            if self.in_backoff_quiet(now) {
                return "backing_off";
            }
            return "recovering";
        }

        // current >= baseline
        // 延迟闸门压着不提速时（有梯度样本且 < 阈值）→ holding，优先于 probing。
        if let Some(g) = gradient {
            if g < GRADIENT_GROW_THRESHOLD {
                return "holding";
            }
        }

        if current > baseline {
            return "probing";
        }

        // current == baseline 且 gradient≥0.90 或无梯度样本。
        "healthy"
    }
}

/// 单个 account key 的自适应限流器。
pub struct AdaptiveLimiter {
    inner: Mutex<Inner>,
    notify: Notify,
}

impl AdaptiveLimiter {
    fn new(baseline: usize) -> Self {
        let b = baseline.clamp(1, HARD_CAP);
        let now = Instant::now();
        Self {
            inner: Mutex::new(Inner {
                in_flight: 0,
                baseline: b,
                floor: FLOOR,
                ceiling: Inner::recompute_ceiling(b),
                limit: b as f64,
                last_start: None,
                recent_starts: VecDeque::new(),
                recent_outcomes: VecDeque::new(),
                rtt_min: None,
                rtt_current: None,
                success_count: 0,
                throttle_count: 0,
                soft_error_count: 0,
                last_grow_at: now,
                last_backoff_at: None,
            }),
            notify: Notify::new(),
        }
    }

    /// 同步 baseline（运行时改配置/改凭据 maxInFlight 时调用）。
    ///
    /// ⚠️ 关键：每个请求经 `get_or_update` 都会调到这里。若值未变，必须是 no-op，
    /// 否则会把退避/延迟闸门刚压低的 `limit` 又顶回基准，导致自适应退避被每个新请求
    /// 无条件撤销。只有 admin 真正改了 maxInFlight（baseline 发生变化）时才调整 `limit`。
    fn set_configured(&self, baseline: usize) {
        let b = baseline.clamp(1, HARD_CAP);
        let mut g = self.inner.lock();
        if b == g.baseline {
            // 常规请求路径：配置未变，不触碰自适应 limit。
            return;
        }
        let raised = b > g.baseline;
        let old_ceiling = g.ceiling;
        g.baseline = b;
        g.ceiling = Inner::recompute_ceiling(b);
        // 上调配置时把当前 limit 至少抬到新基准；下调不强砍到基准，但恒 clamp 到新 ceiling。
        if raised && g.limit < b as f64 {
            g.limit = b as f64;
        }
        if g.limit > g.ceiling as f64 {
            g.limit = g.ceiling as f64;
        }
        let wake = g.ceiling > old_ceiling || g.target() > g.in_flight;
        drop(g);
        if wake {
            self.notify.notify_waiters();
        }
    }

    /// 时间驱动自愈：在 `acquire` 拿名额前调用（也可周期调）。
    ///
    /// 不依赖任何成功样本 —— 闲置被打到 floor 的账号也能随时间爬回 baseline。
    /// 自愈只回爬到 baseline，超过 baseline 的探测仍由 `on_success` 驱动。
    pub fn maybe_recover(&self) {
        let mut g = self.inner.lock();
        let now = Instant::now();
        let backoff_ok = match g.last_backoff_at {
            Some(t) => now.saturating_duration_since(t) >= RECOVER_COOLDOWN,
            None => true,
        };
        let grow_ok = now.saturating_duration_since(g.last_grow_at) >= GROW_INTERVAL;
        let below_baseline = g.limit < g.baseline as f64;
        if !(backoff_ok && grow_ok && below_baseline) {
            return;
        }
        let step = (g.limit * GROW_FRAC).max(1.0);
        g.limit = (g.limit + step).min(g.baseline as f64);
        g.last_grow_at = now;
        drop(g);
        self.notify.notify_waiters();
    }

    /// 获取一个并发名额；超过当前 target 时异步等待。
    /// 获得名额后按限速策略节流，再返回 RAII permit。
    ///
    /// `min_interval`：同一 key 两次发起的最小间隔。
    /// `rpm_burst`：false=固定间隔（匀速削峰）；true=60s 滑动窗口令牌桶（允许突发）。
    async fn acquire(self: &Arc<Self>, min_interval: Duration, rpm_burst: bool) -> LimiterPermit {
        // 拿名额前先做时间驱动自愈，避免闲置账号被永久钉死在低 limit。
        self.maybe_recover();

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
            // 等待期间也尝试自愈，防止 limit 卡在 in_flight 之下形成死锁。
            self.maybe_recover();
        }

        let permit = LimiterPermit {
            limiter: Arc::clone(self),
        };

        if min_interval.is_zero() {
            return permit;
        }

        if rpm_burst {
            // 突发滑动窗口：60s 窗口内最多 `60000/min_interval_ms` 个。
            const WINDOW: Duration = Duration::from_secs(60);
            let cap = (WINDOW.as_millis() as u64 / min_interval.as_millis().max(1) as u64).max(1)
                as usize;
            loop {
                let wait = {
                    let mut g = self.inner.lock();
                    let now = Instant::now();
                    while let Some(&front) = g.recent_starts.front() {
                        if now.saturating_duration_since(front) >= WINDOW {
                            g.recent_starts.pop_front();
                        } else {
                            break;
                        }
                    }
                    if g.recent_starts.len() < cap {
                        g.recent_starts.push_back(now);
                        Duration::ZERO
                    } else {
                        let front = *g.recent_starts.front().unwrap();
                        WINDOW.saturating_sub(now.saturating_duration_since(front))
                            + Duration::from_millis(1)
                    }
                };
                if wait.is_zero() {
                    break;
                }
                tokio::time::sleep(wait).await;
            }
            return permit;
        }

        // 最小间隔限速：同一 key 两次发起至少间隔 min_interval。锁内「预占」下一个发车点。
        let wait = {
            let mut g = self.inner.lock();
            let now = Instant::now();
            match g.last_start {
                Some(prev) => {
                    let next = prev + min_interval;
                    if now >= next {
                        g.last_start = Some(now);
                        Duration::ZERO
                    } else {
                        g.last_start = Some(next);
                        next - now
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
        }

        permit
    }

    /// 观测到 429 / 账号风控：用滑动窗口 429 率触发乘性退避，**单次不砍**。
    pub fn on_throttle(&self, observed_in_flight: u64) {
        let mut g = self.inner.lock();
        let now = Instant::now();
        g.throttle_count += 1;
        g.push_outcome(now, Outcome::Throttle);

        let (thr, total) = g.window_counts(now);
        let rate = if total > 0 {
            thr as f64 / total as f64
        } else {
            0.0
        };
        // 未达率阈值或样本不足：只记录，不砍（吸收瞬时抖动）。
        if total < MIN_SAMPLES || rate < THROTTLE_RATE_TRIP {
            return;
        }

        let floor = g.floor as f64;
        let ceiling = g.ceiling as f64;
        // 乘性退避。
        g.limit = (g.limit * THROTTLE_BACKOFF).clamp(floor, ceiling);
        // 拥塞点封顶：limit = min(limit, max(floor, min(observed, limit)*0.70))。
        if observed_in_flight > 0 {
            let cp = ((observed_in_flight as f64).min(g.limit) * THROTTLE_BACKOFF).max(floor);
            if cp < g.limit {
                g.limit = cp;
            }
        }
        g.last_backoff_at = Some(now);
    }

    /// 账号级软错误（上游 5xx/524 —— 明确来自上游服务端）：乘性退避。
    pub fn on_account_soft_error(&self) {
        let mut g = self.inner.lock();
        g.soft_error_count += 1;
        let floor = g.floor as f64;
        let ceiling = g.ceiling as f64;
        g.limit = (g.limit * SOFT_BACKOFF).clamp(floor, ceiling);
        g.last_backoff_at = Some(Instant::now());
    }

    /// 链路层错误（timeout/connect/read —— 代理/网络层）：**不动账号 limit**，仅累加展示计数。
    pub fn note_link_error(&self) {
        let mut g = self.inner.lock();
        g.soft_error_count += 1;
        // 刻意不改 limit、不置 last_backoff_at：链路抖动不是官方容量信号。
        // （链路级熔断留 TODO，本次不实现。）
    }

    /// 一次成功：上报 TTFB。延迟只作提速闸门，**永不主动降速**。
    pub fn on_success(&self, rtt: Duration) {
        let mut g = self.inner.lock();
        let now = Instant::now();
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
        g.push_outcome(now, Outcome::Success);

        // 退避静默期内不动。
        if g.in_backoff_quiet(now) {
            return;
        }

        let gradient = g.gradient();
        // 有梯度样本且 < 阈值 → hold，不提速也不降速。
        if let Some(grad) = gradient {
            if grad < GRADIENT_GROW_THRESHOLD {
                return;
            }
        }

        // gradient ≥ 0.90 或无梯度样本（视作健康）→ 按时间加性提速。
        if now.saturating_duration_since(g.last_grow_at) >= GROW_INTERVAL {
            let old = g.target();
            let step = (g.limit * GROW_FRAC).max(1.0);
            g.limit = (g.limit + step).min(g.ceiling as f64);
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
        let now = Instant::now();
        LimiterSnapshot {
            key,
            in_flight: g.in_flight,
            baseline: g.baseline,
            current_limit: g.target(),
            floor: g.floor,
            ceiling: g.ceiling,
            state: g.state(now).to_string(),
            throttle_rate: g.throttle_rate(now),
            rtt_current_ms: g.rtt_current.map(|v| v * 1000.0),
            rtt_min_ms: g.rtt_min.map(|v| v * 1000.0),
            success_count: g.success_count,
            throttle_count: g.throttle_count,
            soft_error_count: g.soft_error_count,
            last_backoff_ago_ms: g
                .last_backoff_at
                .map(|t| now.saturating_duration_since(t).as_millis() as u64),
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

    /// 取得（或新建）某 key 的限流器，并把 baseline 同步为最新值。
    pub fn get_or_update(&self, key: &str, baseline: usize) -> Arc<AdaptiveLimiter> {
        let mut m = self.map.lock();
        match m.get(key) {
            Some(l) => {
                l.set_configured(baseline);
                Arc::clone(l)
            }
            None => {
                let l = Arc::new(AdaptiveLimiter::new(baseline));
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
    baseline: usize,
    min_interval: Duration,
    rpm_burst: bool,
) -> LimiterPermit {
    let limiter = limiters.get_or_update(key, baseline);
    limiter.acquire(min_interval, rpm_burst).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 单次 429 不砍（样本不足 MIN_SAMPLES）。
    #[test]
    fn single_throttle_does_not_cut() {
        let l = AdaptiveLimiter::new(32);
        let before = l.inner.lock().target();
        l.on_throttle(32);
        assert_eq!(
            l.inner.lock().target(),
            before,
            "单次 429 不应触发退避"
        );
        // 计数仍然累加（展示用）。
        assert_eq!(l.inner.lock().throttle_count, 1);
    }

    /// 达到窗口 429 率阈值才砍。
    #[test]
    fn throttle_cuts_only_after_rate_trips() {
        let l = AdaptiveLimiter::new(32);
        // 连续 5 次 429：第 5 次时 total=5、rate=1.0 → 触发退避。
        for _ in 0..5 {
            let obs = l.inner.lock().target() as u64;
            l.on_throttle(obs);
        }
        assert!(
            l.inner.lock().target() < 32,
            "达率后应退避, target={}",
            l.inner.lock().target()
        );
        assert!(l.inner.lock().last_backoff_at.is_some());
    }

    /// 混合样本：4 成功 + 1 次 429（rate=0.2 ≥ 0.10, total=5）→ 触发。
    #[test]
    fn mixed_window_rate_trips() {
        let l = AdaptiveLimiter::new(20);
        for _ in 0..4 {
            l.on_success(Duration::from_millis(50));
        }
        let before = l.inner.lock().target();
        l.on_throttle(20);
        assert!(
            l.inner.lock().target() < before,
            "20% 窗口率应触发退避, target={}",
            l.inner.lock().target()
        );
    }

    /// 重复 429 快速收敛。
    #[test]
    fn repeated_throttle_converges() {
        let l = AdaptiveLimiter::new(32);
        for _ in 0..10 {
            let obs = l.inner.lock().target() as u64;
            l.on_throttle(obs);
        }
        assert!(
            l.inner.lock().target() <= 8,
            "连续 429 应收敛到低位, target={}",
            l.inner.lock().target()
        );
    }

    /// 账号级软错误退避（×0.80）。
    #[test]
    fn account_soft_error_backs_off() {
        let l = AdaptiveLimiter::new(20);
        l.on_account_soft_error();
        assert!(l.inner.lock().target() < 20);
        assert!(l.inner.lock().last_backoff_at.is_some());
        assert_eq!(l.inner.lock().soft_error_count, 1);
    }

    /// 链路错误不动 limit，仅累加计数、不置退避时间。
    #[test]
    fn link_error_does_not_touch_limit() {
        let l = AdaptiveLimiter::new(20);
        let before = l.inner.lock().target();
        l.note_link_error();
        l.note_link_error();
        assert_eq!(l.inner.lock().target(), before, "链路错误不应改 limit");
        assert!(l.inner.lock().last_backoff_at.is_none());
        assert_eq!(l.inner.lock().soft_error_count, 2);
    }

    /// 延迟低（梯度低）也永不主动降速，只 hold。
    #[test]
    fn low_gradient_never_cuts() {
        let l = AdaptiveLimiter::new(20);
        // 先建立低 rtt_min。
        l.on_success(Duration::from_millis(50));
        let before = l.inner.lock().target();
        // 再灌高延迟样本：gradient 会掉到 <0.90，但绝不应降速。
        for _ in 0..20 {
            l.on_success(Duration::from_millis(500));
        }
        assert_eq!(
            l.inner.lock().target(),
            before,
            "高延迟只应 hold, target={}",
            l.inner.lock().target()
        );
        // 确认此时梯度确实 <0.90（验证走的是 hold 分支）。
        assert!(l.inner.lock().gradient().unwrap() < GRADIENT_GROW_THRESHOLD);
    }

    /// 闲置 maybe_recover 时间驱动回爬到 baseline，不依赖成功样本。
    #[test]
    fn maybe_recover_climbs_back_to_baseline() {
        let l = AdaptiveLimiter::new(20);
        // 打到 floor。
        {
            let mut g = l.inner.lock();
            g.limit = 1.0;
        }
        // 反复自愈，每次把计时器回拨以模拟时间流逝，无任何成功样本。
        for _ in 0..60 {
            {
                let mut g = l.inner.lock();
                g.last_grow_at = Instant::now() - GROW_INTERVAL * 2;
                g.last_backoff_at = Some(Instant::now() - RECOVER_COOLDOWN * 2);
            }
            l.maybe_recover();
        }
        assert_eq!(
            l.inner.lock().target(),
            20,
            "自愈应回爬到 baseline, target={}",
            l.inner.lock().target()
        );
    }

    /// 自愈只到 baseline，不越过（超 baseline 的探测归 on_success 管）。
    #[test]
    fn maybe_recover_does_not_exceed_baseline() {
        let l = AdaptiveLimiter::new(10);
        {
            let mut g = l.inner.lock();
            g.limit = 9.5;
            g.last_grow_at = Instant::now() - GROW_INTERVAL * 2;
            g.last_backoff_at = Some(Instant::now() - RECOVER_COOLDOWN * 2);
        }
        l.maybe_recover();
        assert_eq!(l.inner.lock().target(), 10);
    }

    /// 在退避静默期内不自愈。
    #[test]
    fn maybe_recover_respects_cooldown() {
        let l = AdaptiveLimiter::new(20);
        {
            let mut g = l.inner.lock();
            g.limit = 5.0;
            g.last_grow_at = Instant::now() - GROW_INTERVAL * 2;
            g.last_backoff_at = Some(Instant::now()); // 刚退避，未过冷却
        }
        l.maybe_recover();
        assert_eq!(l.inner.lock().target(), 5, "冷却期内不应自愈");
    }

    /// set_configured 同值 no-op，不撤销退避。
    #[test]
    fn set_configured_same_value_is_noop() {
        let l = AdaptiveLimiter::new(32);
        // 造一个退避后的低 limit。
        for _ in 0..5 {
            let obs = l.inner.lock().target() as u64;
            l.on_throttle(obs);
        }
        let after = l.inner.lock().target();
        assert!(after < 32);
        for _ in 0..10 {
            l.set_configured(32);
        }
        assert_eq!(
            l.inner.lock().target(),
            after,
            "同值 set_configured 不应恢复 limit"
        );
    }

    /// set_configured 上调抬升 limit 至新 baseline。
    #[test]
    fn set_configured_raise_lifts_limit() {
        let l = AdaptiveLimiter::new(10);
        {
            let mut g = l.inner.lock();
            g.limit = 3.0;
        }
        l.set_configured(20);
        assert_eq!(l.inner.lock().baseline, 20);
        assert!(l.inner.lock().target() >= 20);
    }

    /// on_success 在健康梯度下按时间加性提速，可越过 baseline 探测。
    #[test]
    fn on_success_grows_beyond_baseline() {
        let l = AdaptiveLimiter::new(10);
        for _ in 0..40 {
            // 低延迟 → gradient ≈ 1.0；回拨计时器允许持续提速。
            l.on_success(Duration::from_millis(50));
            l.inner.lock().last_grow_at = Instant::now() - GROW_INTERVAL * 2;
        }
        let g = l.inner.lock();
        assert!(g.target() > 10, "应探测超过 baseline, target={}", g.target());
        assert!(g.target() <= g.ceiling);
    }

    // ---- state 状态机各分支 ----

    #[test]
    fn state_idle_when_no_traffic() {
        let l = AdaptiveLimiter::new(10);
        assert_eq!(l.snapshot("k".into()).state, "idle");
    }

    #[test]
    fn state_backing_off_recent_cut() {
        let l = AdaptiveLimiter::new(20);
        {
            let mut g = l.inner.lock();
            g.limit = 5.0;
            g.success_count = 3;
            g.last_backoff_at = Some(Instant::now()); // 静默期内
        }
        assert_eq!(l.snapshot("k".into()).state, "backing_off");
    }

    #[test]
    fn state_recovering_after_quiet() {
        let l = AdaptiveLimiter::new(20);
        {
            let mut g = l.inner.lock();
            g.limit = 5.0;
            g.success_count = 3;
            g.last_backoff_at = Some(Instant::now() - BACKOFF_QUIET * 2); // 过静默期
        }
        assert_eq!(l.snapshot("k".into()).state, "recovering");
    }

    #[test]
    fn state_holding_when_gradient_low() {
        let l = AdaptiveLimiter::new(10);
        {
            let mut g = l.inner.lock();
            g.limit = 10.0;
            g.rtt_min = Some(0.05);
            g.rtt_current = Some(0.5); // gradient = 0.1 < 0.90
            g.success_count = 5;
        }
        assert_eq!(l.snapshot("k".into()).state, "holding");
    }

    #[test]
    fn state_probing_above_baseline() {
        let l = AdaptiveLimiter::new(10);
        {
            let mut g = l.inner.lock();
            g.limit = 20.0;
            g.rtt_min = Some(0.05);
            g.rtt_current = Some(0.05); // gradient = 1.0 ≥ 0.90
            g.success_count = 5;
        }
        assert_eq!(l.snapshot("k".into()).state, "probing");
    }

    #[test]
    fn state_healthy_at_baseline() {
        let l = AdaptiveLimiter::new(10);
        {
            let mut g = l.inner.lock();
            g.limit = 10.0;
            g.success_count = 5; // 有流量，非 idle；无梯度样本视作健康
        }
        assert_eq!(l.snapshot("k".into()).state, "healthy");
    }

    #[test]
    fn snapshot_fields_present() {
        let l = AdaptiveLimiter::new(16);
        let s = l.snapshot("profile:x".into());
        assert_eq!(s.baseline, 16);
        assert_eq!(s.floor, 1);
        assert!(s.ceiling >= 16);
        assert_eq!(s.current_limit, 16);
        assert_eq!(s.throttle_rate, 0.0);
        assert!(s.last_backoff_ago_ms.is_none());
    }

    #[tokio::test]
    async fn acquire_blocks_beyond_target_and_releases() {
        let l = Arc::new(AdaptiveLimiter::new(1));
        let p1 = l.acquire(Duration::ZERO, false).await;
        assert_eq!(l.inner.lock().in_flight, 1);
        let l2 = Arc::clone(&l);
        let handle = tokio::spawn(async move { l2.acquire(Duration::ZERO, false).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!handle.is_finished());
        drop(p1);
        let _p2 = handle.await.unwrap();
        assert_eq!(l.inner.lock().in_flight, 1);
    }

    #[tokio::test]
    async fn fixed_interval_reserves_slot_no_burst() {
        let interval = Duration::from_millis(120);
        let l = Arc::new(AdaptiveLimiter::new(8));
        let _p0 = l.acquire(interval, false).await;
        let t_start = std::time::Instant::now();

        let mut handles = Vec::new();
        for _ in 0..3 {
            let l2 = Arc::clone(&l);
            handles.push(tokio::spawn(async move {
                let _p = l2.acquire(interval, false).await;
                std::time::Instant::now()
            }));
        }

        let mut times: Vec<Duration> = Vec::new();
        for h in handles {
            times.push(h.await.unwrap().duration_since(t_start));
        }
        times.sort();
        let slack = Duration::from_millis(40);
        assert!(times[0] >= interval - slack, "first={:?}", times[0]);
        assert!(times[1] >= interval * 2 - slack, "second={:?}", times[1]);
        assert!(times[2] >= interval * 3 - slack, "third={:?}", times[2]);
    }
}
