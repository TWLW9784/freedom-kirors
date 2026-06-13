import { useState } from 'react'
import { Gauge, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { useLimiterSnapshots } from '@/hooks/use-traces'
import type { LimiterSnapshot } from '@/types/api'

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
        title="自适应限流器实时监控"
      >
        <Activity className="h-4 w-4" />
      </Button>
      <LimiterMonitorDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/**
 * 自适应限流器实时监控面板。
 *
 * 展示每个 account key（profile/email/credential 维度）的:
 * - 当前并发 / 自适应 limit / 配置基准 / 探测 cap
 * - 延迟梯度（rtt_min/rtt_current，越低越拥塞）与 RTT
 * - 累计成功 / 429 / 软错误计数
 *
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
            自适应限流器实时监控
          </DialogTitle>
          <DialogDescription>
            每个官方账号/profile 的闭环并发控制状态。limit 会随延迟梯度与 429
            自动收敛（AIMD），maxInFlight 仅作基准，可向上探测真实容量。每 3 秒刷新。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : !snapshots || snapshots.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            暂无限流器状态（尚未有请求经过任何账号）
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto py-1">
            {snapshots.map((s) => (
              <LimiterRow key={s.key} snapshot={s} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function LimiterRow({ snapshot: s }: { snapshot: LimiterSnapshot }) {
  const gradientPct = s.gradient != null ? Math.round(s.gradient * 100) : null
  return (
    <div className="rounded-md border border-border/60 bg-secondary/30 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate font-mono text-[12px] text-foreground" title={s.key}>
          {s.key}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs">
          <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-semibold tabular-nums">{s.currentLimit}</span>
          <span className="text-muted-foreground">limit</span>
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
        <Metric label="当前并发" value={`${s.inFlight}`} />
        <Metric label="基准/探测cap" value={`${s.configured} / ${s.probeCap}`} />
        <Metric
          label="延迟梯度"
          value={gradientPct != null ? `${gradientPct}%` : '—'}
          tone={gradientTone(s.gradient)}
        />
        <Metric label="RTT(now/min)" value={formatRtt(s.rttCurrentMs, s.rttMinMs)} />
        <Metric label="成功" value={`${s.successCount}`} tone="ok" />
        <Metric label="429" value={`${s.throttleCount}`} tone={s.throttleCount > 0 ? 'warn' : undefined} />
        <Metric label="软错误" value={`${s.softErrorCount}`} tone={s.softErrorCount > 0 ? 'warn' : undefined} />
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
  tone?: 'ok' | 'warn' | 'bad'
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
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${toneClass}`}>{value}</span>
    </div>
  )
}

function gradientTone(gradient: number | null): 'ok' | 'warn' | 'bad' | undefined {
  if (gradient == null) return undefined
  if (gradient >= 0.9) return 'ok'
  if (gradient >= 0.72) return 'warn'
  return 'bad'
}

function formatRtt(current: number | null, min: number | null): string {
  const fmt = (v: number | null) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`)
  return `${fmt(current)} / ${fmt(min)}`
}
