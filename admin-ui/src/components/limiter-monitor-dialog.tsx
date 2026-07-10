import { useState } from 'react'
import { Activity, HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import { useLimiterSnapshots } from '@/hooks/use-traces'
import type { LimiterSnapshot, LimiterState } from '@/types/api'

/**
 * 自包含状态的限流监控入口按钮（常驻图标，所有屏宽都显示）。
 */
export function LimiterMonitorButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title="并发调度监控"
      >
        <Activity className="h-4 w-4" />
      </Button>
      <LimiterMonitorDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/**
 * 自适应限流器实时监控面板（人话版）。
 *
 * 底层仍是 profile/email/credential 维度的闭环并发控制：limit 随延迟与 429
 * 自动收敛（AIMD），健康时向真实容量探测。这里把工程指标翻译成易懂的状态。
 * 纯读取，每 3 秒刷新，不触发任何上游请求。
 */
export function LimiterMonitorDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: snapshots, isLoading } = useLimiterSnapshots(open)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            并发调度监控
          </DialogTitle>
          <DialogDescription>
            系统会根据上游响应快慢自动调整「同时能发多少个请求」：上游变慢或被限流就<b>自动减速</b>保护账号，
            一切顺畅就<b>慢慢提速</b>压榨真实容量。下面是每个账号通道的实时状态，每 3 秒刷新。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : !snapshots || snapshots.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            暂无数据（还没有请求经过任何账号）
          </div>
        ) : (
          <TooltipProvider delayDuration={150}>
            <div className="max-h-[60vh] space-y-2.5 overflow-y-auto py-1">
              {snapshots.map((s) => (
                <LimiterRow key={s.key} snapshot={s} />
              ))}
            </div>
          </TooltipProvider>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 把内部 key 翻译成友好通道名。 */
function friendlyKey(key: string): { name: string; sub: string } {
  if (key.startsWith('profile:')) {
    const arn = key.slice('profile:'.length)
    // 从 ARN 里抠出区域，如 us-east-1
    const m = arn.match(/codewhisperer:([a-z0-9-]+):/)
    const region = m?.[1]
    return { name: region ? `账号通道 · ${region}` : '账号通道', sub: arn }
  }
  if (key.startsWith('email:')) {
    return { name: `客户端密钥 · ${key.slice('email:'.length)}`, sub: key }
  }
  return { name: key, sub: key }
}

type Tone = 'ok' | 'warn' | 'bad' | 'idle'

type Health = {
  label: string
  emoji: string
  tone: Tone
  desc: string
}

/**
 * 直接读后端下发的 state 状态机，前端不再用累计计数瞎猜（根除“永久已降速”）。
 * 映射严格按规格：idle💤灰 / healthy✅绿 / probing🚀绿 / holding⏳琥珀 /
 * backing_off⚠️红「被限流，降速保护中」/ recovering↗️琥珀「限流后恢复中」。
 */
function healthOf(state: LimiterState): Health {
  switch (state) {
    case 'idle':
      return {
        emoji: '💤', label: '空闲（暂无流量）', tone: 'idle',
        desc: '近期没有请求经过这个通道，保持基准并发待命。',
      }
    case 'backing_off':
      return {
        emoji: '⚠️', label: '被限流，降速保护中', tone: 'bad',
        desc: '近期触发过限流或明显变慢，系统已把并发压到起步值以下，正处于退避静默期保护上游。',
      }
    case 'recovering':
      return {
        emoji: '↗️', label: '限流后恢复中', tone: 'warn',
        desc: '之前被限流压低了并发，静默期已过，系统正随时间/成功逐步把并发提回基准。',
      }
    case 'holding':
      return {
        emoji: '⏳', label: '稳住并发（上游偏慢）', tone: 'warn',
        desc: '响应比最快时慢了一些（延迟闸门压着），系统暂不提速以免压垮上游。',
      }
    case 'probing':
      return {
        emoji: '🚀', label: '探测更高并发', tone: 'ok',
        desc: '上游很通畅，系统正在向上探测超过基准的真实容量。',
      }
    case 'healthy':
    default:
      return {
        emoji: '✅', label: '健康', tone: 'ok',
        desc: '上游响应正常，并发维持在基准附近，可随时向上探测。',
      }
  }
}

function toneText(tone: Tone): string {
  switch (tone) {
    case 'ok': return 'text-emerald-600'
    case 'warn': return 'text-amber-600'
    case 'bad': return 'text-red-600'
    default: return 'text-muted-foreground'
  }
}

function LimiterRow({ snapshot: s }: { snapshot: LimiterSnapshot }) {
  const { name, sub } = friendlyKey(s.key)
  const h = healthOf(s.state)
  const limit = Math.max(s.currentLimit, 1)
  const usagePct = Math.min(100, Math.round((s.inFlight / limit) * 100))
  // 累计计数是生涯累计值：仅当当前 state==backing_off 时标红（正处于降速保护），
  // 否则中性调色——表示“历史发生过但已恢复”，避免健康通道被永久标红。
  const active = s.state === 'backing_off'
  const throttleTone: Tone | undefined = s.throttleCount > 0 ? (active ? 'bad' : 'warn') : undefined
  const softErrTone: Tone | undefined = s.softErrorCount > 0 ? (active ? 'bad' : 'warn') : undefined

  return (
    <div className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2.5">
      {/* 头部：通道名 + 状态徽章 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground" title={sub}>
            {name}
          </div>
          <div className={`mt-0.5 text-xs font-medium ${toneText(h.tone)}`}>
            {h.emoji} {h.label}
          </div>
        </div>
        <Hint text={h.desc}>
          <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
            正忙 {s.inFlight} / 上限 {s.currentLimit}
          </span>
        </Hint>
      </div>

      {/* 并发占用进度条 */}
      <div className="mt-2">
        <Progress value={usagePct} className="h-1.5" />
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <Hint text="当前同时在处理的请求数 ÷ 系统现在允许的并发上限。">
            <span className="inline-flex items-center gap-1">
              并发占用 {usagePct}%
              <HelpCircle className="h-3 w-3 opacity-50" />
            </span>
          </Hint>
          <Hint text={`系统起步并发为 ${s.baseline}，被限流/变慢时最低可收缩到 ${s.floor}，健康时最高向上探测到 ${s.ceiling}。当前自动调到 ${s.currentLimit}。`}>
            <span className="inline-flex items-center gap-1">
              可伸缩范围 {s.floor} ~ {s.ceiling}
              <HelpCircle className="h-3 w-3 opacity-50" />
            </span>
          </Hint>
        </div>
      </div>

      {/* 细节指标（人话） */}
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
        <Hint text="上游当前响应速度 / 历史最快速度。当前越接近最快，说明上游越通畅。">
          <Metric
            label="上游响应"
            value={formatRtt(s.rttCurrentMs, s.rttMinMs)}
            tone={h.tone === 'idle' ? undefined : h.tone}
          />
        </Hint>
        <Hint text="成功完成的请求数（生涯累计）。">
          <Metric label="成功" value={`${s.successCount}`} tone={s.successCount > 0 ? 'ok' : undefined} />
        </Hint>
        <Hint text="最近 60 秒滑动窗口内被限流（429）的比例。达到阈值才触发自动降速，吸收瞬时抖动。">
          <Metric label="近期 429 率" value={formatPct(s.throttleRate)} tone={s.throttleRate > 0 ? (active ? 'bad' : 'warn') : undefined} />
        </Hint>
        <Hint text="距离上一次触发降速退避的时间。“—”表示从未退避过。">
          <Metric label="上次退避" value={formatAgo(s.lastBackoffAgoMs)} tone={active ? 'bad' : undefined} />
        </Hint>
        <Hint text="被上游限流（429）的累计次数。达率才触发降速；变灰表示历史发生过但当前已恢复。">
          <Metric label="被限流" value={`${s.throttleCount}`} tone={throttleTone} />
        </Hint>
        <Hint text="软错误（上游 5xx/524 服务端错误）累计次数。会触发自动降速；变灰表示历史发生过但当前已恢复。">
          <Metric label="软错误" value={`${s.softErrorCount}`} tone={softErrTone} />
        </Hint>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: Tone
}) {
  const toneClass =
    tone === 'ok'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'bad'
          ? 'text-red-600'
          : 'text-foreground'
  return (
    <div className="flex flex-col">
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        {label}
        <HelpCircle className="h-3 w-3 opacity-40" />
      </span>
      <span className={`font-medium tabular-nums ${toneClass}`}>{value}</span>
    </div>
  )
}

function Hint({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-xs leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  )
}

function formatRtt(current: number | null, min: number | null): string {
  const fmt = (v: number | null) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`)
  if (current == null && min == null) return '暂无样本'
  return `${fmt(current)} / 最快 ${fmt(min)}`
}

/** 滑动窗口 429 率 0.0-1.0 → 百分比。 */
function formatPct(rate: number): string {
  if (rate == null || Number.isNaN(rate)) return '—'
  if (rate <= 0) return '0%'
  const pct = rate * 100
  return pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`
}

/** 距上次退避毫秒 → "Xs前"/"Xm前"/"—"。 */
function formatAgo(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 0) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s前`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m前`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h前`
}
