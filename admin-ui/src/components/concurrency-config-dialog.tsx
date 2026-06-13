import { useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { useConcurrencyConfig, useSetConcurrencyConfig } from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { ConcurrencyConfig } from '@/api/credentials'

/**
 * 全局档位并发设置面板。
 *
 * 凭据未单独设置 maxInFlight 时，按账号档位（企业 / Pro·Pro+ / Free·social）回退到此默认。
 * 改动运行时即时生效并持久化 config.json，无需重启。单凭据覆盖优先于这里的档位默认。
 */
interface TierRow {
  key: 'enterprise' | 'pro' | 'basic'
  label: string
  hint: string
  mifField: keyof ConcurrencyConfig
  intField: keyof ConcurrencyConfig
}

const TIER_ROWS: TierRow[] = [
  {
    key: 'enterprise',
    label: '企业 / IdC',
    hint: '官方限额最高',
    mifField: 'tierMaxInFlightEnterprise',
    intField: 'tierMinIntervalMsEnterprise',
  },
  {
    key: 'pro',
    label: 'Pro / Pro+',
    hint: '订阅居中',
    mifField: 'tierMaxInFlightPro',
    intField: 'tierMinIntervalMsPro',
  },
  {
    key: 'basic',
    label: 'Free / Google / Github',
    hint: '限额最低',
    mifField: 'tierMaxInFlightBasic',
    intField: 'tierMinIntervalMsBasic',
  },
]

type DraftMap = Record<string, string>

function configToDraft(c: ConcurrencyConfig): DraftMap {
  return {
    tierMaxInFlightEnterprise: String(c.tierMaxInFlightEnterprise),
    tierMaxInFlightPro: String(c.tierMaxInFlightPro),
    tierMaxInFlightBasic: String(c.tierMaxInFlightBasic),
    tierMinIntervalMsEnterprise: String(c.tierMinIntervalMsEnterprise),
    tierMinIntervalMsPro: String(c.tierMinIntervalMsPro),
    tierMinIntervalMsBasic: String(c.tierMinIntervalMsBasic),
  }
}

export function ConcurrencyConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: config, isLoading } = useConcurrencyConfig()
  const { mutate: save, isPending: saving } = useSetConcurrencyConfig()

  const [draft, setDraft] = useState<DraftMap>({})
  const [adaptive, setAdaptive] = useState(true)

  // 打开对话框 / 数据到达时，用服务端值初始化草稿
  useEffect(() => {
    if (open && config) {
      setDraft(configToDraft(config))
      setAdaptive(config.adaptiveConcurrencyEnabled)
    }
  }, [open, config])

  const setField = (field: string, value: string) =>
    setDraft((prev) => ({ ...prev, [field]: value }))

  const handleSave = () => {
    // 校验：并发 1..=256，间隔 0..=60000
    const patch: Partial<ConcurrencyConfig> = { adaptiveConcurrencyEnabled: adaptive }
    for (const row of TIER_ROWS) {
      const mif = parseInt(draft[row.mifField] ?? '', 10)
      const int = parseInt(draft[row.intField] ?? '', 10)
      if (Number.isNaN(mif) || mif < 1 || mif > 256) {
        toast.error(`${row.label} 的并发上限必须是 1-256 的整数`)
        return
      }
      if (Number.isNaN(int) || int < 0 || int > 60000) {
        toast.error(`${row.label} 的最小间隔必须是 0-60000 毫秒`)
        return
      }
      ;(patch as Record<string, number>)[row.mifField] = mif
      ;(patch as Record<string, number>)[row.intField] = int
    }
    save(patch, {
      onSuccess: () => {
        toast.success('档位并发配置已更新，运行时即时生效')
        onOpenChange(false)
      },
      onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            全局并发档位默认
          </DialogTitle>
          <DialogDescription>
            凭据未单独设置并发上限时，按账号档位回退到此默认。改动运行时即时生效并持久化，无需重启。
            单个凭据卡片上的「并发上限」优先于这里。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-[11px] font-medium text-muted-foreground">
              <span>账号档位</span>
              <span className="w-20 text-center">并发上限</span>
              <span className="w-24 text-center">间隔(ms)</span>
            </div>
            {TIER_ROWS.map((row) => (
              <div
                key={row.key}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{row.label}</div>
                  <div className="text-[11px] text-muted-foreground">{row.hint}</div>
                </div>
                <Input
                  type="number"
                  min={1}
                  max={256}
                  value={draft[row.mifField] ?? ''}
                  onChange={(e) => setField(row.mifField, e.target.value)}
                  disabled={saving}
                  className="h-8 w-20 text-center text-sm"
                />
                <Input
                  type="number"
                  min={0}
                  max={60000}
                  step={100}
                  value={draft[row.intField] ?? ''}
                  onChange={(e) => setField(row.intField, e.target.value)}
                  disabled={saving}
                  className="h-8 w-24 text-center text-sm"
                />
              </div>
            ))}

            <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-3 py-2">
              <div className="text-xs">
                <div className="font-medium text-foreground">自适应降并发</div>
                <div className="leading-snug text-muted-foreground">
                  触发 429 时自动压低该 profile 并发，持续成功后逐步回升
                </div>
              </div>
              <Switch checked={adaptive} disabled={saving} onCheckedChange={setAdaptive} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || isLoading}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
