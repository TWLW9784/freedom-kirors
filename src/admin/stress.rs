//! 压测探针共享类型：`stress_probe` 的返回结构与失败分类。
//!
//! 单独放在这里是为了让 `admin::service` 和 `admin::stress_test` 都能引用同一份定义，
//! 且不污染 admin 的公开 API 表面。

/// 压测探针的失败/成功分类。
///
/// 区分三类明显不同的原因，避免像旧版那样把 "非 2xx" 一律叫 failed 而丢失上下文：
/// - `Setup`：前置准备失败（token 刷新、端点未知、序列化错误等）→ 上游未被访问；
/// - `Network`：`send().await` 直接失败（超时、DNS、连接拒绝、TLS 错误等）→ 请求可能已到网络但无响应头；
/// - `Http`：上游返回了 HTTP 响应头（无论 2xx/4xx/5xx），带上可选的 `Retry-After`。
#[derive(Debug, Clone)]
pub enum StressOutcome {
    /// 收到 HTTP 响应头（无论 status）。
    Http {
        /// 上游 `Retry-After` 头解析出的秒数（若存在）。
        retry_after_secs: Option<f64>,
    },
    /// `send()` 网络层失败（超时/连接错误/TLS）。
    Network(String),
    /// 前置准备失败，未打到上游。
    Setup(String),
}

/// 压测探针单次结果。
///
/// `status` 严格语义：`Some(_)` 表示实际收到 HTTP 响应头；`None` 表示未收到响应头
/// （前置失败或网络错误）。这个区分让统计能剔除"未上游"样本，避免延迟被 0 拉低。
#[derive(Debug, Clone)]
pub struct StressProbeResult {
    /// HTTP 状态码（仅当收到响应头时非空）。
    pub status: Option<u16>,
    /// `send().await` 耗时（毫秒）— 严格 TTFB，不含前置准备与响应体读取。
    pub elapsed_ms: f64,
    /// 结果分类，见 [`StressOutcome`]。
    pub outcome: StressOutcome,
}

impl StressProbeResult {
    /// 是否成功（HTTP 2xx）。
    pub fn is_success(&self) -> bool {
        matches!(self.status, Some(s) if (200..300).contains(&s))
    }
}
