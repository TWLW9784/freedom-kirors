import { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { Play, Square, Download, TrendingUp, AlertCircle, Gauge, Zap } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { useCredentials } from '@/hooks/use-credentials'
import { storage } from '@/lib/storage'

type TestMode = 'concurrency' | 'rpm'

interface StressTestConfig {
  credentialIds: number[]
  model: string
  maxTokens: number
  mode: TestMode
  // 并发测试参数
  concurrency: number
  requestsPerCredential: number
  strategy: 'concurrent' | 'sequential'
  // RPM 速率测试参数
  targetRpm: number
  durationSecs: number
}

interface CredentialResult {
  credentialId: number
  total: number
  success: number
  failed: number
  status429: number
  status500: number
  latencyP50: number
  latencyP95: number
  latencyP99: number
  latencyMax: number
}

interface StressTestStatus {
  sessionId: string
  model: string
  mode: TestMode
  strategy: string
  concurrency: number
  targetRpm: number
  durationSecs: number
  running: boolean
  finished: boolean
  totalRequests: number
  completedRequests: number
  dispatchedRequests: number
  inflightRequests: number
  progress: number
  elapsedMs: number
  rps: number
  actualRpm: number
  results: CredentialResult[]
}

function authHeaders(): Record<string, string> {
  const key = storage.getApiKey() || ''
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
  }
}

export function StressTestPage() {
  const { data: credentialsData } = useCredentials()
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [config, setConfig] = useState<StressTestConfig>({
    credentialIds: [],
    model: 'claude-opus-4.8',
    maxTokens: 4,
    mode: 'concurrency',
    concurrency: 8,
    requestsPerCredential: 50,
    strategy: 'concurrent',
    targetRpm: 60,
    durationSecs: 60,
  })
  const [testing, setTesting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [completedReqs, setCompletedReqs] = useState(0)
  const [totalReqs, setTotalReqs] = useState(0)
  const [rps, setRps] = useState(0)
  const [actualRpm, setActualRpm] = useState(0)
  const [inflight, setInflight] = useState(0)
  const [results, setResults] = useState<CredentialResult[]>([])
  const sessionIdRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const handleSelectAll = () => {
    const allIds = credentialsData?.credentials.map(c => c.id) || []
    setSelectedIds(allIds)
  }

  const applyStatus = (status: StressTestStatus) => {
    setProgress(status.progress)
    setCompletedReqs(status.completedRequests)
    setTotalReqs(status.totalRequests)
    setRps(status.rps)
    setActualRpm(status.actualRpm)
    setInflight(status.inflightRequests)
    setResults(status.results)
  }

  const pollStatus = async (sessionId: string) => {
    try {
      const resp = await fetch(`/api/admin/stress-test/${sessionId}/status`, {
        headers: authHeaders(),
      })
      if (!resp.ok) return
      const status: StressTestStatus = await resp.json()
      applyStatus(status)
      if (status.finished) {
        stopPolling()
        setTesting(false)
        toast.success(`压力测试完成 (${status.completedRequests}/${status.totalRequests})`)
      }
    } catch {
      // 网络抖动时忽略单次轮询失败
    }
  }

  const estimatedTotal = config.mode === 'rpm'
    ? Math.max(1, Math.round((config.targetRpm * config.durationSecs) / 60))
    : selectedIds.length * config.requestsPerCredential

  const handleStart = async () => {
    if (selectedIds.length === 0) {
      toast.error('请至少选择一个凭证')
      return
    }

    setTesting(true)
    setProgress(0)
    setResults([])
    setCompletedReqs(0)
    setTotalReqs(estimatedTotal)
    setRps(0)
    setActualRpm(0)
    setInflight(0)

    const testConfig = { ...config, credentialIds: selectedIds }

    try {
      const resp = await fetch('/api/admin/stress-test/start', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(testConfig),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      sessionIdRef.current = data.sessionId
      if (typeof data.totalRequests === 'number') setTotalReqs(data.totalRequests)

      stopPolling()
      pollRef.current = setInterval(() => {
        if (sessionIdRef.current) pollStatus(sessionIdRef.current)
      }, 1000)
    } catch (error) {
      toast.error('测试启动失败: ' + (error as Error).message)
      setTesting(false)
    }
  }

  const handleStop = async () => {
    const sessionId = sessionIdRef.current
    if (!sessionId) {
      setTesting(false)
      return
    }
    try {
      await fetch(`/api/admin/stress-test/${sessionId}/stop`, {
        method: 'POST',
        headers: authHeaders(),
      })
      toast.info('已请求停止测试')
    } catch {
      toast.error('停止请求失败')
    }
  }

  const handleExport = () => {
    if (results.length === 0) return
    const report = {
      model: config.model,
      mode: config.mode,
      maxTokens: config.maxTokens,
      ...(config.mode === 'concurrency'
        ? {
            strategy: config.strategy,
            concurrency: config.concurrency,
            requestsPerCredential: config.requestsPerCredential,
          }
        : {
            targetRpm: config.targetRpm,
            durationSecs: config.durationSecs,
            actualRpm,
          }),
      totalRequests: totalReqs,
      completedRequests: completedReqs,
      rps,
      successRate,
      generatedAt: new Date().toISOString(),
      results,
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `stress-test-${config.mode}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const successRate = results.length > 0
    ? (results.reduce((sum, r) => sum + r.success, 0) / Math.max(1, results.reduce((sum, r) => sum + r.total, 0))) * 100
    : 0

  const avgLatency = results.length > 0
    ? results.reduce((sum, r) => sum + r.latencyP50, 0) / results.length
    : 0

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">凭证压力测试</h2>
        <p className="text-sm text-muted-foreground mt-1">
          批量测试凭证性能和稳定性（真实上游调用，会消耗额度）
        </p>
      </div>

      {/* 测试配置 */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">测试配置</h3>

        <div className="space-y-4">
          {/* 测试模式（顶层区分：并发 vs RPM） */}
          <div>
            <label className="text-sm font-medium mb-2 block">测试类型</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                disabled={testing}
                onClick={() => setConfig({ ...config, mode: 'concurrency' })}
                className={`flex items-start gap-3 rounded-lg border p-3 text-left transition disabled:opacity-60 ${
                  config.mode === 'concurrency' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent/50'
                }`}
              >
                <Zap className="w-5 h-5 mt-0.5 text-amber-500 shrink-0" />
                <span>
                  <span className="block font-medium">并发测试</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    固定请求量按并发数尽快打满，衡量峰值吞吐与延迟分布
                  </span>
                </span>
              </button>
              <button
                type="button"
                disabled={testing}
                onClick={() => setConfig({ ...config, mode: 'rpm' })}
                className={`flex items-start gap-3 rounded-lg border p-3 text-left transition disabled:opacity-60 ${
                  config.mode === 'rpm' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent/50'
                }`}
              >
                <Gauge className="w-5 h-5 mt-0.5 text-blue-500 shrink-0" />
                <span>
                  <span className="block font-medium">RPM 速率测试</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    按固定每分钟请求数匀速发出，持续指定时长，衡量稳定速率下的表现
                  </span>
                </span>
              </button>
            </div>
          </div>

          {/* 选择凭证 */}
          <div>
            <label className="text-sm font-medium mb-2 block">选择凭证</label>
            <div className="flex gap-2 mb-2">
              <Button size="sm" variant="outline" onClick={handleSelectAll} disabled={testing}>
                全选 ({credentialsData?.credentials.length || 0})
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSelectedIds([])} disabled={testing}>
                清空
              </Button>
            </div>
            <div className="border rounded-md p-3 max-h-48 overflow-y-auto">
              {credentialsData?.credentials.map(cred => (
                <label key={cred.id} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-accent/50 px-2 rounded">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(cred.id)}
                    disabled={testing}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds([...selectedIds, cred.id])
                      } else {
                        setSelectedIds(selectedIds.filter(id => id !== cred.id))
                      }
                    }}
                    className="rounded"
                  />
                  <span className="text-sm">#{cred.id} {cred.email || cred.maskedApiKey || `凭证 ${cred.id}`}</span>
                  {cred.disabled && <Badge variant="secondary" className="text-xs">禁用</Badge>}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              已选择 {selectedIds.length} 个凭证
            </p>
          </div>

          {/* 公共参数：模型 + max_tokens */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">模型</label>
              <select
                value={config.model}
                onChange={(e) => setConfig({ ...config, model: e.target.value })}
                className="w-full border rounded px-3 py-2 text-sm"
                disabled={testing}
              >
                <option value="claude-opus-4.8">claude-opus-4.8</option>
                <option value="claude-sonnet-4">claude-sonnet-4</option>
                <option value="claude-3-5-sonnet-v2">claude-3-5-sonnet-v2</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">max_tokens</label>
              <select
                value={config.maxTokens}
                onChange={(e) => setConfig({ ...config, maxTokens: parseInt(e.target.value) })}
                className="w-full border rounded px-3 py-2 text-sm"
                disabled={testing}
              >
                <option value={4}>4 (快速)</option>
                <option value={16}>16</option>
                <option value={64}>64</option>
              </select>
            </div>
          </div>

          {/* 并发测试参数 */}
          {config.mode === 'concurrency' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">并发数</label>
                  <input
                    type="number"
                    value={config.concurrency}
                    onChange={(e) => setConfig({ ...config, concurrency: parseInt(e.target.value) || 1 })}
                    min={1}
                    max={256}
                    className="w-full border rounded px-3 py-2 text-sm"
                    disabled={testing}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">每凭证请求数</label>
                  <input
                    type="number"
                    value={config.requestsPerCredential}
                    onChange={(e) => setConfig({ ...config, requestsPerCredential: parseInt(e.target.value) || 1 })}
                    min={1}
                    max={1000}
                    className="w-full border rounded px-3 py-2 text-sm"
                    disabled={testing}
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">并发子策略</label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={config.strategy === 'concurrent' ? 'default' : 'outline'}
                    onClick={() => setConfig({ ...config, strategy: 'concurrent' })}
                    disabled={testing}
                  >
                    混合并发
                  </Button>
                  <Button
                    size="sm"
                    variant={config.strategy === 'sequential' ? 'default' : 'outline'}
                    onClick={() => setConfig({ ...config, strategy: 'sequential' })}
                    disabled={testing}
                  >
                    逐凭证
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  混合并发：所有凭证请求混合后按并发数同时发出 | 逐凭证：逐个凭证测试，便于排查单号问题
                </p>
              </div>
            </>
          )}

          {/* RPM 速率测试参数 */}
          {config.mode === 'rpm' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">目标 RPM（每分钟请求数）</label>
                  <input
                    type="number"
                    value={config.targetRpm}
                    onChange={(e) => setConfig({ ...config, targetRpm: parseInt(e.target.value) || 1 })}
                    min={1}
                    max={600000}
                    className="w-full border rounded px-3 py-2 text-sm"
                    disabled={testing}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">持续时长（秒）</label>
                  <input
                    type="number"
                    value={config.durationSecs}
                    onChange={(e) => setConfig({ ...config, durationSecs: parseInt(e.target.value) || 1 })}
                    min={1}
                    max={3600}
                    className="w-full border rounded px-3 py-2 text-sm"
                    disabled={testing}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                匀速派发：约每 {(60000 / Math.max(1, config.targetRpm)).toFixed(0)} ms 一个请求，凭证轮询均摊；
                预计总请求 ≈ <span className="font-medium">{estimatedTotal}</span> 个
              </p>
            </>
          )}

          {/* 控制按钮 */}
          <div className="flex gap-2 pt-2">
            {!testing ? (
              <Button onClick={handleStart} disabled={selectedIds.length === 0}>
                <Play className="w-4 h-4 mr-2" />
                开始测试
              </Button>
            ) : (
              <Button onClick={handleStop} variant="destructive">
                <Square className="w-4 h-4 mr-2" />
                停止测试
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* 测试进度 */}
      {(testing || completedReqs > 0) && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4">测试进度</h3>
          <Progress value={progress} className="mb-2" />
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>{progress.toFixed(1)}% 完成 ({completedReqs} / {totalReqs} 请求)</span>
            <span>实时 RPS: {rps.toFixed(1)}</span>
            {config.mode === 'rpm' && (
              <>
                <span>实际 RPM: {actualRpm.toFixed(0)} / 目标 {config.targetRpm}</span>
                <span>在途: {inflight}</span>
              </>
            )}
          </div>
        </Card>
      )}

      {/* 测试结果 */}
      {results.length > 0 && (
        <>
          {/* 全局统计 */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">总成功率</p>
                  <p className="text-2xl font-bold">{successRate.toFixed(1)}%</p>
                </div>
                <TrendingUp className="w-8 h-8 text-green-500" />
              </div>
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    {config.mode === 'rpm' ? '实际 RPM' : '平均延迟 (P50)'}
                  </p>
                  <p className="text-2xl font-bold">
                    {config.mode === 'rpm' ? actualRpm.toFixed(0) : `${avgLatency.toFixed(0)}ms`}
                  </p>
                </div>
                {config.mode === 'rpm'
                  ? <Gauge className="w-8 h-8 text-blue-500" />
                  : <AlertCircle className="w-8 h-8 text-blue-500" />}
              </div>
            </Card>

            <Card className="p-4">
              <div>
                <p className="text-sm text-muted-foreground">总请求数</p>
                <p className="text-2xl font-bold">
                  {results.reduce((sum, r) => sum + r.total, 0)}
                </p>
              </div>
            </Card>

            <Card className="p-4">
              <div>
                <p className="text-sm text-muted-foreground">429 限流</p>
                <p className="text-2xl font-bold text-orange-500">
                  {results.reduce((sum, r) => sum + r.status429, 0)}
                </p>
              </div>
            </Card>
          </div>

          {/* 凭证详细结果 */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">凭证测试结果</h3>
              <Button size="sm" variant="outline" onClick={handleExport}>
                <Download className="w-4 h-4 mr-2" />
                导出报告
              </Button>
            </div>

            <div className="space-y-3">
              {results.map(result => {
                const cred = credentialsData?.credentials.find(c => c.id === result.credentialId)
                const credSuccessRate = result.total > 0 ? (result.success / result.total) * 100 : 0

                return (
                  <Card key={result.credentialId} className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">
                            #{result.credentialId} {cred?.email || cred?.maskedApiKey || `凭证 ${result.credentialId}`}
                          </span>
                          <Badge variant={credSuccessRate >= 95 ? 'default' : credSuccessRate >= 80 ? 'secondary' : 'destructive'}>
                            {credSuccessRate.toFixed(1)}% 成功
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          {result.success} 成功 / {result.failed} 失败 / {result.total} 总计
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">P50:</span>
                        <span className="ml-2 font-medium">{result.latencyP50.toFixed(0)}ms</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">P95:</span>
                        <span className="ml-2 font-medium">{result.latencyP95.toFixed(0)}ms</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">P99:</span>
                        <span className="ml-2 font-medium">{result.latencyP99.toFixed(0)}ms</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Max:</span>
                        <span className="ml-2 font-medium">{result.latencyMax.toFixed(0)}ms</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">429:</span>
                        <span className="ml-2 font-medium text-orange-500">{result.status429}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">5xx:</span>
                        <span className="ml-2 font-medium text-red-500">{result.status500}</span>
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
