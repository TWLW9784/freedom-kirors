use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 全局配置持久化锁：串行化所有「load 最新 → 改字段 → 原子 save」序列。
/// 多个 admin 操作并发持久化时（如同时改并发配置与节流配置），若各自
/// load 全量、改各自切片、save，会后写覆盖先写丢更新。此锁覆盖整段 load+save，
/// 保证持久化排队执行、每次都在最新文件基础上改。
static CONFIG_PERSIST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TlsBackend {
    Rustls,
    NativeTls,
}

impl Default for TlsBackend {
    fn default() -> Self {
        Self::Rustls
    }
}

/// 用户自定义的单条 prompt 过滤规则。
///
/// `kind` 取值：
/// - `"regex"`：在整个 prompt 上做正则查找替换（`replace` 为空 = 删除匹配）。
/// - `"lines-containing"` / `"contains"`：移除包含 `pattern` 子串的整行（大小写不敏感）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFilterRule {
    /// 唯一标识（可选）
    #[serde(default)]
    pub id: String,
    /// 人类可读名称（可选）
    #[serde(default)]
    pub name: String,
    /// 规则类型："regex" 或 "lines-containing"/"contains"
    #[serde(rename = "type", default)]
    pub kind: String,
    /// 匹配模式（regex 正则或子串）
    #[serde(rename = "match", default)]
    pub pattern: String,
    /// 替换串（仅 regex 生效；空 = 删除匹配）
    #[serde(default)]
    pub replace: String,
    /// 是否启用
    #[serde(default)]
    pub enabled: bool,
}

/// KNA 应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_host")]
    pub host: String,

    #[serde(default = "default_port")]
    pub port: u16,

    /// OAuth 回调公网地址（远程部署时配置）。
    ///
    /// 留空：Social 登录在服务端本机启动临时回调端口（`http://127.0.0.1:{port}`），
    /// 仅本机浏览器可达。
    /// 配置后（如 `https://example.com/api/admin/auth/callback`）：OAuth `redirect_uri`
    /// 改用此地址，浏览器授权后落到 `{callbackBaseUrl}/oauth/callback`，
    /// 由本服务的公网回调路由接收 `code` 并自动完成登录，适配 Docker / VPS / Render 等远程部署。
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_base_url: Option<String>,

    #[serde(default = "default_region")]
    pub region: String,

    /// Auth Region（用于 Token 刷新），未配置时回退到 region
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_region: Option<String>,

    /// API Region（用于 API 请求），未配置时回退到 region
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_region: Option<String>,

    #[serde(default = "default_kiro_version")]
    pub kiro_version: String,

    #[serde(default)]
    pub machine_id: Option<String>,

    #[serde(default)]
    pub api_key: Option<String>,

    #[serde(default = "default_system_version")]
    pub system_version: String,

    #[serde(default = "default_node_version")]
    pub node_version: String,

    #[serde(default = "default_tls_backend")]
    pub tls_backend: TlsBackend,

    /// 外部 count_tokens API 地址（可选）
    #[serde(default)]
    pub count_tokens_api_url: Option<String>,

    /// count_tokens API 密钥（可选）
    #[serde(default)]
    pub count_tokens_api_key: Option<String>,

    /// count_tokens API 认证类型（可选，"x-api-key" 或 "bearer"，默认 "x-api-key"）
    #[serde(default = "default_count_tokens_auth_type")]
    pub count_tokens_auth_type: String,

    /// HTTP 代理地址（可选）
    /// 支持格式: http://host:port, https://host:port, socks5://host:port
    #[serde(default)]
    pub proxy_url: Option<String>,

    /// 代理认证用户名（可选）
    #[serde(default)]
    pub proxy_username: Option<String>,

    /// 代理认证密码（可选）
    #[serde(default)]
    pub proxy_password: Option<String>,

    /// Admin API 密钥（可选，启用 Admin API 功能）
    #[serde(default)]
    pub admin_api_key: Option<String>,

    /// 上一次成功更新前正在运行的版本号，用于在前端展示「回退到 vX.Y.Z」按钮。
    /// 实际回退动作通过 `<exe>.backup` 文件完成，无需访问网络。
    #[serde(default)]
    pub update_previous_version: Option<String>,

    /// GitHub Personal Access Token（可选）。设置后 GitHub Releases 接口会带上
    /// `Authorization: Bearer <token>`，把限流从匿名 60/h 提到认证 5000/h。
    /// 仅需 `public_repo` 读取权限即可。
    #[serde(default)]
    pub github_token: Option<String>,

    /// 上一次成功完成在线更新的时间（RFC3339）。前端用于显示「上次更新于 …」。
    #[serde(default)]
    pub update_last_applied_at: Option<String>,

    /// 是否启用无人值守自动更新。开启后服务会在每天的 `update_auto_apply_time`
    /// 时刻检查 GitHub Releases，发现新版本即自动下载二进制并替换重启。
    #[serde(default)]
    pub update_auto_apply: bool,

    /// 自动更新的每日触发时间（本地时区，`HH:MM` 24 小时制）。
    /// 默认 03:00 凌晨执行，对在线服务影响最小。
    #[serde(default = "default_update_auto_apply_time")]
    pub update_auto_apply_time: String,

    /// 负载均衡模式（"priority" 或 "balanced"）
    #[serde(default = "default_load_balancing_mode")]
    pub load_balancing_mode: String,

    /// 账号级 429 风控触发时是否对当前凭据进入冷却并故障转移（默认 true）。
    ///
    /// 关闭后：429 + suspicious activity 仍按普通瞬态错误重试，不切换凭据。
    /// 开启后：识别到 suspicious activity 字符串时，把当前凭据冷却 `account_throttle_cooldown_secs` 秒，
    /// 立即切换到下一个可用凭据。
    #[serde(default = "default_account_throttle_failover")]
    pub account_throttle_failover: bool,

    /// 账号级风控冷却时长（秒，默认 1800 = 30 分钟）。
    #[serde(default = "default_account_throttle_cooldown_secs")]
    pub account_throttle_cooldown_secs: u64,

    /// 同一 Kiro 官方账号/profile 同时允许的上游请求数。
    ///
    /// Kiro 官方的 SERVICE_REQUEST_RATE_EXCEEDED 通常按官方账号/profile 维度限流；
    /// 同一 profile 下导入多个 token 并不能提升限额，反而会叠加触发 429。
    /// 默认 1：同一官方账号串行发起，多个不同 profile 仍可并行。
    #[serde(default = "default_kiro_account_max_in_flight")]
    pub kiro_account_max_in_flight: usize,

    /// 同一 Kiro 官方账号/profile 两次请求发起之间的最小间隔（毫秒）。
    ///
    /// 默认 1800ms，减少短时间突刺；设为 0 可关闭间隔限速。
    #[serde(default = "default_kiro_account_min_interval_ms")]
    pub kiro_account_min_interval_ms: u64,

    /// 按账号档位的默认最大并发（凭据未显式设置 `maxInFlight` 时回退到此）。
    ///
    /// 索引含义：企业/IdC、Pro/Pro+、Free/social。企业账号官方限额最高，默认放最大。
    /// 凭据级 `maxInFlight` 优先于此；自适应降并发会在运行时进一步压低实际并发。
    #[serde(default = "default_tier_max_in_flight_enterprise")]
    pub tier_max_in_flight_enterprise: usize,
    #[serde(default = "default_tier_max_in_flight_pro")]
    pub tier_max_in_flight_pro: usize,
    #[serde(default = "default_tier_max_in_flight_basic")]
    pub tier_max_in_flight_basic: usize,

    /// 按账号档位的默认最小请求间隔（毫秒）。企业账号间隔最短以提升吞吐。
    #[serde(default = "default_tier_min_interval_enterprise")]
    pub tier_min_interval_ms_enterprise: u64,
    #[serde(default = "default_tier_min_interval_pro")]
    pub tier_min_interval_ms_pro: u64,
    #[serde(default = "default_tier_min_interval_basic")]
    pub tier_min_interval_ms_basic: u64,

    /// 是否启用自适应降并发（429 时压低该 profile 的并发上限，持续成功后逐步回升）。
    #[serde(default = "default_adaptive_concurrency_enabled")]
    pub adaptive_concurrency_enabled: bool,

    /// RPM 限速模式是否使用「突发滑动窗口」而非「固定最小间隔」。
    ///
    /// - `false`（默认）：固定最小间隔，两次请求至少隔 `min_interval_ms`，严格匀速、天然削峰。
    /// - `true`（Kiro-Go 风格）：60 秒滑动窗口令牌桶，窗口内未满 `60000/min_interval_ms` 个即放行，
    ///   允许瞬时突发。更灵活但可能打出速率尖峰，更易触发上游 429。
    #[serde(default = "default_rpm_burst_enabled")]
    pub rpm_burst_enabled: bool,

    /// 是否开启非流式响应的 thinking 块提取（默认 true）
    ///
    /// 启用后，非流式响应中的 `<thinking>...</thinking>` 标签会被解析为
    /// 独立的 `{"type": "thinking", ...}` 内容块,与流式响应行为一致。
    #[serde(default = "default_extract_thinking")]
    pub extract_thinking: bool,

    /// 默认端点名称（凭据未显式指定 endpoint 时使用，默认 "ide"）
    #[serde(default = "default_endpoint")]
    pub default_endpoint: String,

    /// 是否启用请求链路追踪（写 traces.db）。默认 true。
    ///
    /// 关闭后：不再写入 trace 记录、不走 TraceSink，但 `GET /api/admin/traces`
    /// 仍可查询历史已存记录。适合隐私敏感或磁盘紧张的场景。
    #[serde(default = "default_trace_enabled")]
    pub trace_enabled: bool,

    /// 请求链路追踪记录保留天数（默认 7）。后台任务每天清理超期记录。
    #[serde(default = "default_trace_retention_days")]
    pub trace_retention_days: u32,

    /// 请求用量日志（usage_log.*.jsonl + 聚合桶）保留天数（默认 31）。
    #[serde(default = "default_usage_log_retention_days")]
    pub usage_log_retention_days: u32,

    /// 是否检测 Claude Code CLI 内置 system prompt 并替换为精简后端提示词。
    /// 默认 false（不改动上游内容）。开启后可显著省 token 并降低提示词注入面。
    #[serde(default)]
    pub filter_claude_code: bool,

    /// 是否剥离 system prompt 中的环境噪声行（gitStatus、近期提交、知识截止、
    /// `# Environment` / `# auto memory` 段落、`<fast_mode_info>` 等）。默认 false。
    #[serde(default)]
    pub filter_env_noise: bool,

    /// 是否移除 `--- SYSTEM PROMPT ---` / `--- END SYSTEM PROMPT ---` 边界标记行。默认 false。
    #[serde(default)]
    pub filter_strip_boundaries: bool,

    /// 用户自定义 prompt 过滤规则（regex 替换 或 行级包含过滤）。默认空。
    /// 在内置过滤之后、按数组顺序逐条应用，仅对 `enabled=true` 的规则生效。
    #[serde(default)]
    pub prompt_filter_rules: Vec<PromptFilterRule>,

    /// 端点特定的配置
    ///
    /// 键为端点名（如 "ide" / "cli"），值为该端点自由定义的参数对象。
    /// 未在此表出现的端点沿用实现内置默认值。
    #[serde(default)]
    pub endpoints: HashMap<String, serde_json::Value>,

    /// 配置文件路径（运行时元数据，不写入 JSON）
    #[serde(skip)]
    config_path: Option<PathBuf>,
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    8080
}

fn default_region() -> String {
    "us-east-1".to_string()
}

fn default_kiro_version() -> String {
    "2.3.0".to_string()
}

fn default_system_version() -> String {
    "macos".to_string()
}

fn default_node_version() -> String {
    "22.22.0".to_string()
}

fn default_count_tokens_auth_type() -> String {
    "x-api-key".to_string()
}

fn default_tls_backend() -> TlsBackend {
    TlsBackend::Rustls
}

fn default_load_balancing_mode() -> String {
    "priority".to_string()
}

fn default_account_throttle_failover() -> bool {
    true
}

fn default_account_throttle_cooldown_secs() -> u64 {
    30 * 60
}

fn default_kiro_account_max_in_flight() -> usize {
    1
}

fn default_kiro_account_min_interval_ms() -> u64 {
    1800
}

// 按档默认并发（激进档）：企业 10 / Pro·Pro+ 4 / Free·social 2
fn default_tier_max_in_flight_enterprise() -> usize {
    10
}
fn default_tier_max_in_flight_pro() -> usize {
    4
}
fn default_tier_max_in_flight_basic() -> usize {
    2
}

// 按档默认间隔：企业账号间隔最短以提升吞吐，其余保持较高以压低 429 风险
fn default_tier_min_interval_enterprise() -> u64 {
    300
}
fn default_tier_min_interval_pro() -> u64 {
    800
}
fn default_tier_min_interval_basic() -> u64 {
    1800
}

fn default_adaptive_concurrency_enabled() -> bool {
    true
}

fn default_rpm_burst_enabled() -> bool {
    false
}

fn default_update_auto_apply_time() -> String {
    "03:00".to_string()
}

fn default_extract_thinking() -> bool {
    true
}

fn default_endpoint() -> String {
    crate::kiro::endpoint::ide::IDE_ENDPOINT_NAME.to_string()
}

fn default_trace_enabled() -> bool {
    true
}

fn default_trace_retention_days() -> u32 {
    7
}

fn default_usage_log_retention_days() -> u32 {
    31
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
            callback_base_url: None,
            region: default_region(),
            auth_region: None,
            api_region: None,
            kiro_version: default_kiro_version(),
            machine_id: None,
            api_key: None,
            system_version: default_system_version(),
            node_version: default_node_version(),
            tls_backend: default_tls_backend(),
            count_tokens_api_url: None,
            count_tokens_api_key: None,
            count_tokens_auth_type: default_count_tokens_auth_type(),
            proxy_url: None,
            proxy_username: None,
            proxy_password: None,
            admin_api_key: None,
            update_previous_version: None,
            github_token: None,
            update_last_applied_at: None,
            update_auto_apply: false,
            update_auto_apply_time: default_update_auto_apply_time(),
            load_balancing_mode: default_load_balancing_mode(),
            account_throttle_failover: default_account_throttle_failover(),
            account_throttle_cooldown_secs: default_account_throttle_cooldown_secs(),
            kiro_account_max_in_flight: default_kiro_account_max_in_flight(),
            kiro_account_min_interval_ms: default_kiro_account_min_interval_ms(),
            tier_max_in_flight_enterprise: default_tier_max_in_flight_enterprise(),
            tier_max_in_flight_pro: default_tier_max_in_flight_pro(),
            tier_max_in_flight_basic: default_tier_max_in_flight_basic(),
            tier_min_interval_ms_enterprise: default_tier_min_interval_enterprise(),
            tier_min_interval_ms_pro: default_tier_min_interval_pro(),
            tier_min_interval_ms_basic: default_tier_min_interval_basic(),
            adaptive_concurrency_enabled: default_adaptive_concurrency_enabled(),
            rpm_burst_enabled: default_rpm_burst_enabled(),
            extract_thinking: default_extract_thinking(),
            default_endpoint: default_endpoint(),
            trace_enabled: default_trace_enabled(),
            trace_retention_days: default_trace_retention_days(),
            usage_log_retention_days: default_usage_log_retention_days(),
            filter_claude_code: false,
            filter_env_noise: false,
            filter_strip_boundaries: false,
            prompt_filter_rules: Vec::new(),
            endpoints: HashMap::new(),
            config_path: None,
        }
    }
}

impl Config {
    /// 获取默认配置文件路径
    pub fn default_config_path() -> &'static str {
        "config.json"
    }

    /// 获取有效的 Auth Region（用于 Token 刷新）
    /// 优先使用 auth_region，未配置时回退到 region
    pub fn effective_auth_region(&self) -> &str {
        self.auth_region.as_deref().unwrap_or(&self.region)
    }

    /// 获取有效的 API Region（用于 API 请求）
    /// 优先使用 api_region，未配置时回退到 region
    pub fn effective_api_region(&self) -> &str {
        self.api_region.as_deref().unwrap_or(&self.region)
    }

    /// 从文件加载配置
    pub fn load<P: AsRef<Path>>(path: P) -> anyhow::Result<Self> {
        let path = path.as_ref();
        if !path.exists() {
            // 配置文件不存在，返回默认配置
            let mut config = Self::default();
            config.config_path = Some(path.to_path_buf());
            return Ok(config);
        }

        let content = fs::read_to_string(path)?;
        let mut config: Config = serde_json::from_str(&content)?;
        config.config_path = Some(path.to_path_buf());

        // 用户手工把字符串字段清空（如 `"updateAutoApplyTime": ""`）时，serde 默认值不会
        // 介入；这里把"看起来像空"的关键字段回退到默认值，避免后续业务用到
        // 空字符串导致难以诊断的错误。
        if config.update_auto_apply_time.trim().is_empty() {
            config.update_auto_apply_time = default_update_auto_apply_time();
        }

        Ok(config)
    }

    /// 获取配置文件路径（如果有）
    pub fn config_path(&self) -> Option<&Path> {
        self.config_path.as_deref()
    }

    /// 将当前配置写回原始配置文件
    pub fn save(&self) -> anyhow::Result<()> {
        let path = self
            .config_path
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("配置文件路径未知，无法保存配置"))?;

        let content = serde_json::to_string_pretty(self).context("序列化配置失败")?;
        // 原子写：先写同目录临时文件再 rename 覆盖，避免写到一半遇崩溃/磁盘满
        // 导致 config.json 被截断损坏（credentials 路径、githubToken、callbackBaseUrl 等全丢）。
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, content)
            .with_context(|| format!("写入临时配置文件失败: {}", tmp.display()))?;
        fs::rename(&tmp, path).with_context(|| {
            // rename 失败时尽量清理临时文件，不报错。
            let _ = fs::remove_file(&tmp);
            format!("原子替换配置文件失败: {}", path.display())
        })?;
        Ok(())
    }

    /// 在全局持久化锁下原子地「load 最新 → updater 改字段 → save」。
    /// 5 个配置持久化点统一走此函数，消除 load-modify-save 竞态（后写覆盖先写丢更新）。
    /// 锁在重新 load 之前获取，保证每个 updater 都看到前一个写入的结果。
    pub fn persist_update(
        config_path: &Path,
        updater: impl FnOnce(&mut Config),
    ) -> anyhow::Result<()> {
        let _guard = CONFIG_PERSIST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut config = Config::load(config_path)
            .with_context(|| format!("重新加载配置失败: {}", config_path.display()))?;
        updater(&mut config);
        config
            .save()
            .with_context(|| format!("持久化配置失败: {}", config_path.display()))?;
        Ok(())
    }
}
