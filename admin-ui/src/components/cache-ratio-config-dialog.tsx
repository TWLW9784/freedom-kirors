import { useEffect, useState } from 'react'
import { Database } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useCacheRatioConfig, useSetCacheRatioConfig } from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { CacheRatioConfig } from '@/api/credentials'

/**
 * 全局自定义缓存比例设置面板。
 *
 * 控制下发给下游的 cache_creation_input_tokens / cache_read_input_tokens 口径：
 * - off：真实前缀命中模拟（历史默认，最准确）
 * - override：忽略真实命中，直接按固定比例把 total 拆成 read/creation/input
 * - scale：在真实命中基础上对 read/creation 分别乘系数
 *
 * 改动运行时即时生效并持久化 config.json，无需重启。单客户端 Key 可另设覆盖。
 */
const MODE_OPTIONS = [
  { value: 'off', label: '关闭（真实命中模拟）' },
  { value: 'override', label: '固定比例覆盖' },
  { value: 'scale', label: '系数缩放' },
]

export function CacheRatioConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: config, isLoading } = useCacheRatioConfig()
  const { mutate: save, isPending: saving } = useSetCacheRatioConfig()

  const [mode, setMode] = useState('off')
  const [readRatio, setReadRatio] = useState('0')
  const [creationRatio, setCreationRatio] = useState('0')

  useEffect(() => {
    if (open && config) {
      setMode(config.mode || 'off')
      setReadRatio(String(config.readRatio ?? 0))
      setCreationRatio(String(config.creationRatio ?? 0))
    }
  }, [open, config])

  const handleSave = () => {
    const read = parseFloat(readRatio)
    const creation = parseFloat(creationRatio)
    if (mode !== 'off') {
      if (Number.isNaN(read) || read < 0) {
        toast.error('缓存读取比例必须是 ≥0 的数字')
        return
      }
      if (Number.isNaN(creation) || creation < 0) {
        toast.error('缓存写入比例必须是 ≥0 的数字')
        return
      }
      if (mode === 'override' && read + creation > 1) {
        toast.error('固定比例覆盖模式下，读取比例 + 写入比例必须 ≤ 1')
        return
      }
    }
    const patch: Partial<CacheRatioConfig> = {
      mode,
      readRatio: Number.isNaN(read) ? 0 : read,
      creationRatio: Number.isNaN(creation) ? 0 : creation,
    }
    save(patch, {
      onSuccess: () => {
        toast.success('缓存比例策略已更新，运行时即时生效')
        onOpenChange(false)
      },
      onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
    })
  }

  const hint =
    mode === 'override'
      ? '按固定比例把每次请求的 total token 拆分：读取比例、写入比例分别是占 total 的份额（两者之和 ≤ 1），剩余计入 input。与真实命中脱钩。'
      : mode === 'scale'
        ? '在真实前缀命中的基础上，对 cache_read / cache_creation 分别乘系数（1.0 不变、>1 放大、<1 缩小），真实为 0 仍为 0。'
        : '沿用真实前缀命中模拟，下游看到的缓存占比与实际命中一致（最准确，推荐）。'

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            全局自定义缓存比例
          </DialogTitle>
          <DialogDescription>
            控制下发给下游的 cache_creation / cache_read token 口径。改动运行时即时生效并持久化，无需重启。
            单个客户端 Key 可另设覆盖，优先于此全局默认。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">模式</label>
              <Select value={mode} onValueChange={setMode} disabled={saving}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
            </div>

            {mode !== 'off' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    缓存读取{mode === 'override' ? '比例' : '系数'}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    step={mode === 'override' ? 0.05 : 0.1}
                    value={readRatio}
                    onChange={(e) => setReadRatio(e.target.value)}
                    disabled={saving}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    缓存写入{mode === 'override' ? '比例' : '系数'}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    step={mode === 'override' ? 0.05 : 0.1}
                    value={creationRatio}
                    onChange={(e) => setCreationRatio(e.target.value)}
                    disabled={saving}
                    className="h-9"
                  />
                </div>
              </div>
            )}
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
