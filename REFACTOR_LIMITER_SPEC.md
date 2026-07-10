# 自适应并发限流器重构规格（冻结契约 v1）

> 本文件是本次重构的唯一事实源。后端与前端子代理都以此为准，不得擅自扩展/改名字段。
> 目标：修复「延迟误降速」「闲置账号卡死」「configured 语义重载导致监控矛盾」三大缺陷。

## 一、控制律（后端 src/kiro/rate_limit.rs）

### 状态字段（Inner 重构）
- `baseline: usize`  —— 配置起步并发（原 configured），来自 maxInFlight ∩ 档位默认。
- `floor: usize`     —— 退避硬下限（默认 1）。
- `ceiling: usize`   —— 探测硬上限（原 probe_cap，`max(baseline*4, baseline+32)`，clamp 到 HARD_CAP=512）。
- `limit: f64`       —— 当前自适应目标并发。
- `in_flight: usize`
- 滑动窗口错误率：`recent_outcomes: VecDeque<(Instant, Outcome)>`，Outcome ∈ {Throttle, Success}，窗口 = 最近 60s。
- `rtt_min: Option<f64>` / `rtt_current: Option<f64>` —— **仅用于展示**，不再驱动降速。
- 计时：`last_backoff_at: Option<Instant>`、`last_grow_at: Instant`。
- 累计计数：`success_count/throttle_count/soft_error_count: u64`（展示用）。

### 降速（乘性 MD）——只信硬信号
1. **429/风控**：`on_throttle(observed_in_flight)`。用滑动窗口 429 率触发，不是单次就砍：
   - 记录本次 Throttle 到窗口。
   - 若窗口内 429 率 ≥ `THROTTLE_RATE_TRIP`(0.10) 且窗口样本数 ≥ `MIN_SAMPLES`(5)，执行乘性退避 `limit *= THROTTLE_BACKOFF`(0.70)，clamp 到 [floor, ceiling]，置 last_backoff_at。
   - 拥塞点封顶：`limit = min(limit, max(floor, (min(observed, limit))*0.70))`。
   - 单次 429 但未达率阈值：只记录，不砍（吸收瞬时抖动）。
2. **账号级软错误**：`on_account_soft_error()`（上游 5xx/524 —— 明确来自上游服务端）：`limit *= SOFT_BACKOFF`(0.80)，clamp[floor,ceiling]，置 last_backoff_at。
3. **链路错误**：`note_link_error()`（timeout/connect —— 代理/网络层）：**不动账号 limit**，仅累加 soft_error_count 供展示（可选：链路级熔断留 TODO，本次不实现）。

### 提速 / 延迟闸门
- `on_success(rtt)`：更新 rtt_ewma（展示）；记录 Success 到窗口；累加 success_count。
- **延迟只作提速闸门，永不主动降速**：
  - 计算 gradient = rtt_min/rtt_current（clamp 0.05..1.5）。
  - 若在退避静默期内（now-last_backoff_at < `BACKOFF_QUIET`(12s)）→ 不动。
  - 若 gradient 可用且 < `GRADIENT_GROW_THRESHOLD`(0.90) → **hold，不提速也不降速**。
  - 若 gradient ≥ 0.90 且 now-last_grow ≥ `GROW_INTERVAL`(8s) → 加性提速：`limit += grow_step`，其中 `grow_step = max(1.0, limit*GROW_FRAC)`(GROW_FRAC=0.10，让大号回血快)，clamp ≤ ceiling，更新 last_grow_at。
  - gradient 无样本 → 允许按时间提速（同上，视作健康）。

### 时间驱动自愈（解死锁）——核心新增
- 新方法 `maybe_recover()`：在 `acquire` 拿名额前调用（也可周期调）。
  - 条件：now-last_backoff_at ≥ `RECOVER_COOLDOWN`(15s) 且 now-last_grow ≥ `GROW_INTERVAL`(8s) 且 limit < baseline。
  - 动作：`limit += max(1.0, limit*GROW_FRAC)`，clamp ≤ baseline（自愈只回爬到 baseline，超过 baseline 的探测仍由 on_success 驱动），更新 last_grow_at，notify_waiters。
  - **不依赖任何成功样本** —— 闲置被打到 1 的账号也能随时间爬回 baseline。

### target()
- `self.limit.round().clamp(floor as f64, ceiling as f64) as usize`

### set_configured(baseline)
- 语义：admin 改 maxInFlight。若值未变 → no-op（保持不撤销退避）。
- 变化时：更新 baseline、重算 ceiling；上调时 limit 至少抬到新 baseline；恒 clamp limit ≤ ceiling。

## 二、快照契约（LimiterSnapshot —— 前后端冻结）

后端 `snapshot(key)` 产出、`#[serde(rename_all="camelCase")]`；前端 types/api.ts 完全对应：

```
key: string
inFlight: usize            // 当前在途
baseline: usize            // 起步基准（原 configured）
currentLimit: usize        // 当前自适应上限
floor: usize               // 退避下限（通常 1）
ceiling: usize             // 探测上限（原 probeCap）
state: string              // 见下方状态机，后端直接算好下发
throttleRate: f64          // 滑动窗口 429 率 0.0-1.0
rttCurrentMs: number|null  // 仅展示
rttMinMs: number|null      // 仅展示
successCount: u64
throttleCount: u64
softErrorCount: u64
lastBackoffAgoMs: number|null  // 距上次退避毫秒，null=从未退避
```

### state 状态机（后端计算，前端直接显示，杜绝前端用累计计数瞎猜）
- `"idle"`        —— 无流量（success+throttle+soft+inflight 全 0）。
- `"backing_off"` —— currentLimit < baseline 且在退避静默期内（now-last_backoff < BACKOFF_QUIET）。
- `"recovering"`  —— currentLimit < baseline 且已过静默期（正在时间/成功驱动回爬）。
- `"holding"`     —— currentLimit ≥ baseline 且 gradient<0.90（延迟闸门压着不提速）。
- `"probing"`     —— currentLimit > baseline（正在探测超过基准的真实容量）。
- `"healthy"`     —— currentLimit == baseline 且 gradient≥0.90 或无梯度样本。

## 三、后端信号接线（provider.rs / token_manager.rs 包装）
- 429 / 风控响应 → `on_throttle(observed_in_flight)`（observed 取该账号当时 in_flight）。
- 上游 5xx/524（服务端错误）→ `on_account_soft_error()`。
- reqwest timeout / connect / read error（链路层）→ `note_link_error()`（**不砍账号 limit**）。
- 成功 → `on_success(upstream_rtt)`（rtt 仍取 TTFB：execute().await 返回时打点，不含 body）。
- acquire 名额前 → `maybe_recover()`。

## 四、前端（admin-ui/src/components/limiter-monitor-dialog.tsx）
- 状态徽章/文案**直接读 snapshot.state**，不再用 throttleCount>0 推断（根除"永久已降速"）。
- 可伸缩范围显示 `floor ~ ceiling`；「上限」显示 currentLimit。三者语义独立，不再矛盾。
- 新增展示：滑动窗口 429 率(throttleRate)、距上次退避时间(lastBackoffAgoMs)、软错误数。
- state → 文案/emoji/色调映射：
  - idle 💤 灰 / healthy ✅ 绿 / probing 🚀 绿 / holding ⏳ 琥珀 /
    backing_off ⚠️ 红「被限流，降速保护中」/ recovering ↗️ 琥珀「限流后恢复中」。
- 累计计数(被限流/软错误)着色：仅当 state∈{backing_off} 时红，否则灰（历史发生过但已恢复）。

## 五、验收
- 后端：`cargo test`（含新增单测：单次429不砍/达率才砍/闲置maybe_recover回爬/延迟低不降速/链路错误不动limit/state 各分支）全过；`cargo build --release` 通过。
- 前端：`npm run build` 通过，无 TS 错误。
- 集成：最终 `npm run build` → `cargo build --release`（嵌入 dist）→ systemctl restart → 拉 /api/admin/limiter/snapshots 核对新字段与 state。
- 留二进制回滚点。**未经我最终集成，子代理不得重启线上服务。**
