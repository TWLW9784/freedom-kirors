import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, XCircle, AlertCircle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useCredentials, useAddCredential, useDeleteCredential } from '@/hooks/use-credentials'
import { getCredentialBalance, setCredentialDisabled, getProxyPool } from '@/api/credentials'
import { extractErrorMessage, sha256Hex } from '@/lib/utils'

interface BatchImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface CredentialInput {
  refreshToken?: string
  refresh_token?: string
  accessToken?: string
  access_token?: string
  profileArn?: string
  profile_arn?: string
  expiresAt?: string
  expires_at?: string
  clientId?: string
  client_id?: string
  clientSecret?: string
  client_secret?: string
  region?: string
  authRegion?: string
  auth_region?: string
  apiRegion?: string
  api_region?: string
  priority?: number
  machineId?: string
  machine_id?: string
  kiroApiKey?: string
  kiro_api_key?: string
  authMethod?: string
  auth_method?: string
  provider?: string
  startUrl?: string
  start_url?: string
  endpoint?: string
  email?: string
  proxyUrl?: string
  proxy_url?: string
  proxyUsername?: string
  proxy_username?: string
  proxyPassword?: string
  proxy_password?: string
}

interface VerificationResult {
  index: number
  status: 'pending' | 'checking' | 'verifying' | 'verified' | 'duplicate' | 'failed'
  error?: string
  usage?: string
  email?: string
  credentialId?: number
  rollbackStatus?: 'success' | 'failed' | 'skipped'
  rollbackError?: string
}



export function BatchImportDialog({ open, onOpenChange }: BatchImportDialogProps) {
  const [jsonInput, setJsonInput] = useState('')
  const [importing, setImporting] = useState(false)
  const [allowSameAccount, setAllowSameAccount] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [currentProcessing, setCurrentProcessing] = useState<string>('')
  const [results, setResults] = useState<VerificationResult[]>([])

  const { data: existingCredentials } = useCredentials()
  const { mutateAsync: addCredential } = useAddCredential()
  const { mutateAsync: deleteCredential } = useDeleteCredential()
  const { data: proxyPool } = useQuery({
    queryKey: ['proxy-pool'],
    queryFn: getProxyPool,
    enabled: open,
  })

  const rollbackCredential = async (id: number): Promise<{ success: boolean; error?: string }> => {
    try {
      await setCredentialDisabled(id, true)
    } catch (error) {
      return {
        success: false,
        error: `禁用失败: ${extractErrorMessage(error)}`,
      }
    }

    try {
      await deleteCredential(id)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: `删除失败: ${extractErrorMessage(error)}`,
      }
    }
  }

  const resetForm = () => {
    setJsonInput('')
    setProgress({ current: 0, total: 0 })
    setCurrentProcessing('')
    setResults([])
  }

  const pickString = (...values: Array<string | undefined | null>) => {
    const value = values.find(v => typeof v === 'string' && v.trim())
    return value?.trim()
  }

  const normalizeAuthMethod = (value?: string): 'social' | 'idc' | 'api_key' | undefined => {
    if (!value) return undefined
    const lower = value.trim().toLowerCase().replace(/[-_\s]/g, '')
    if (lower === 'idc' || lower === 'builderid' || lower === 'iam') return 'idc'
    if (lower === 'apikey') return 'api_key'
    if (lower === 'social') return 'social'
    return undefined
  }

  const normalizeExpiresAt = (value?: string) => {
    const raw = value?.trim()
    if (!raw) return undefined
    // KAM/账号管理器常见格式: 2026/06/06 01:59:56
    const slashMatch = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/)
    if (slashMatch) {
      const [, y, m, d, hh, mm, ss] = slashMatch
      return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`
    }
    return raw
  }

  const normalizeCredential = (cred: CredentialInput): CredentialInput => {
    const usageData = (cred as { usageData?: { userInfo?: { email?: string } } }).usageData
    return {
      ...cred,
      refreshToken: pickString(cred.refreshToken, cred.refresh_token),
      accessToken: pickString(cred.accessToken, cred.access_token),
      profileArn: pickString(cred.profileArn, cred.profile_arn),
      expiresAt: normalizeExpiresAt(pickString(cred.expiresAt, cred.expires_at)),
      clientId: pickString(cred.clientId, cred.client_id),
      clientSecret: pickString(cred.clientSecret, cred.client_secret),
      authRegion: pickString(cred.authRegion, cred.auth_region),
      apiRegion: pickString(cred.apiRegion, cred.api_region),
      machineId: pickString(cred.machineId, cred.machine_id),
      kiroApiKey: pickString(cred.kiroApiKey, cred.kiro_api_key),
      authMethod: normalizeAuthMethod(pickString(cred.authMethod, cred.auth_method)),
      provider: pickString(cred.provider),
      startUrl: pickString(cred.startUrl, cred.start_url),
      email: pickString(cred.email, usageData?.userInfo?.email),
      proxyUrl: pickString(cred.proxyUrl, cred.proxy_url),
      proxyUsername: pickString(cred.proxyUsername, cred.proxy_username),
      proxyPassword: pickString(cred.proxyPassword, cred.proxy_password),
    }
  }

  const extractCredentialItems = (parsed: unknown): CredentialInput[] => {
    if (Array.isArray(parsed)) return parsed as CredentialInput[]
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { accounts?: unknown }).accounts)) {
      return (parsed as { accounts: CredentialInput[] }).accounts
    }
    return [parsed as CredentialInput]
  }

  const extractApiKeyLines = (text: string): CredentialInput[] => {
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const tokens = line.split(/[\s,;]+/).map(t => t.trim()).filter(t => t)
        return tokens.find(t => t.startsWith('ksk_')) || ''
      })
      .filter(key => key.startsWith('ksk_'))
      .map((kiroApiKey, index) => ({
        authMethod: 'api_key',
        kiroApiKey,
        email: `api-key-${index + 1}`,
      }))
  }

  const parseImportText = (text: string): CredentialInput[] => {
    try {
      const parsed = JSON.parse(text)
      return extractCredentialItems(parsed).map(normalizeCredential)
    } catch (error) {
      const apiKeys = extractApiKeyLines(text)
      if (apiKeys.length > 0) return apiKeys
      throw error
    }
  }

  const handleFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return

    try {
      const imported: CredentialInput[] = []
      for (const file of files) {
        const text = await file.text()
        imported.push(...parseImportText(text))
      }

      if (imported.length === 0) {
        toast.error('文件中没有可导入的凭据')
        return
      }

      setJsonInput(JSON.stringify(imported, null, 2))
      toast.success(`已从 ${files.length} 个文件读取 ${imported.length} 个凭据，请确认后开始导入`)
    } catch (error) {
      toast.error('读取文件失败: ' + extractErrorMessage(error))
    }
  }

  const handleBatchImport = async () => {
    // 支持 JSON，也支持一行一个 ksk_ API Key 的纯文本
    let credentials: CredentialInput[]
    try {
      credentials = parseImportText(jsonInput).map(normalizeCredential)
    } catch (error) {
      toast.error('格式错误：请上传/粘贴 JSON，或一行一个 ksk_ API Key。' + extractErrorMessage(error))
      return
    }

    if (credentials.length === 0) {
      toast.error('没有可导入的凭据')
      return
    }

    try {
      setImporting(true)
      setProgress({ current: 0, total: credentials.length })

      // 2. 初始化结果
      const initialResults: VerificationResult[] = credentials.map((_, i) => ({
        index: i + 1,
        status: 'pending'
      }))
      setResults(initialResults)

      // 3. 检测重复：OAuth 与 API Key 分别使用对应的 hash 集合
      const existingOauthKeys = new Set(
        existingCredentials?.credentials
          .map(c => c.refreshTokenHash ? `${c.refreshTokenHash}:${(c.profileArn || '').trim()}` : '')
          .filter((key): key is string => Boolean(key)) || []
      )
      const existingApiKeyHashes = new Set(
        existingCredentials?.credentials
          .map(c => c.apiKeyHash)
          .filter((hash): hash is string => Boolean(hash)) || []
      )

      let successCount = 0
      let duplicateCount = 0
      let failCount = 0
      let rollbackSuccessCount = 0
      let rollbackFailedCount = 0
      let rollbackSkippedCount = 0

      // 可用的代理池条目（用于无代理凭据的随机分配）
      const enabledProxies = proxyPool?.proxies.filter(p => p.enabled) ?? []

      // 4. 导入并验活
      for (let i = 0; i < credentials.length; i++) {
        const cred = credentials[i]

        // 若凭据未指定代理且代理池有可用代理，随机分配一个
        if (!cred.proxyUrl?.trim() && enabledProxies.length > 0) {
          const picked = enabledProxies[Math.floor(Math.random() * enabledProxies.length)]
          cred.proxyUrl = picked.url
        }
        const isApiKeyCred = !!(cred.kiroApiKey?.trim()) || cred.authMethod === 'api_key'

        // 更新状态为检查中
        setCurrentProcessing(`正在处理凭据 ${i + 1}/${credentials.length}`)
        setResults(prev => {
          const newResults = [...prev]
          newResults[i] = { ...newResults[i], status: 'checking' }
          return newResults
        })

        // 客户端去重：OAuth 基于 refreshToken hash，API Key 基于 kiroApiKey hash
        let credHash = ''
        if (isApiKeyCred) {
          const apiKey = cred.kiroApiKey?.trim() || ''
          if (!apiKey) {
            setResults(prev => {
              const newResults = [...prev]
              newResults[i] = {
                ...newResults[i],
                status: 'failed',
                error: '缺少 kiroApiKey',
              }
              return newResults
            })
            failCount++
            setProgress({ current: i + 1, total: credentials.length })
            continue
          }
          credHash = await sha256Hex(apiKey)
          if (existingApiKeyHashes.has(credHash)) {
            duplicateCount++
            const existingCred = existingCredentials?.credentials.find(c => c.apiKeyHash === credHash)
            setResults(prev => {
              const newResults = [...prev]
              newResults[i] = {
                ...newResults[i],
                status: 'duplicate',
                error: '该凭据已存在',
                email: existingCred?.email || undefined
              }
              return newResults
            })
            setProgress({ current: i + 1, total: credentials.length })
            continue
          }
        } else {
          const token = cred.refreshToken?.trim() || ''
          if (!token) {
            setResults(prev => {
              const newResults = [...prev]
              newResults[i] = {
                ...newResults[i],
                status: 'failed',
                error: '缺少 refreshToken',
              }
              return newResults
            })
            failCount++
            setProgress({ current: i + 1, total: credentials.length })
            continue
          }
          credHash = await sha256Hex(token)
          const profileKey = cred.profileArn?.trim() || ''
          const duplicateKey = `${credHash}:${profileKey}`
          if (existingOauthKeys.has(duplicateKey)) {
            duplicateCount++
            const existingCred = existingCredentials?.credentials.find(c => c.refreshTokenHash === credHash && ((c.profileArn || '').trim() === profileKey))
            setResults(prev => {
              const newResults = [...prev]
              newResults[i] = {
                ...newResults[i],
                status: 'duplicate',
                error: '该凭据已存在',
                email: existingCred?.email || undefined
              }
              return newResults
            })
            setProgress({ current: i + 1, total: credentials.length })
            continue
          }
        }

        // 更新状态为验活中
        setResults(prev => {
          const newResults = [...prev]
          newResults[i] = { ...newResults[i], status: 'verifying' }
          return newResults
        })

        let addedCredId: number | null = null

        try {
          // 添加凭据
          if (isApiKeyCred) {
            // API Key 凭据
            const addedCred = await addCredential({
              authMethod: 'api_key',
              kiroApiKey: cred.kiroApiKey?.trim(),
              provider: cred.provider?.trim() || undefined,
              startUrl: cred.startUrl?.trim() || undefined,
              priority: cred.priority || 0,
              authRegion: cred.authRegion?.trim() || cred.region?.trim() || undefined,
              apiRegion: cred.apiRegion?.trim() || undefined,
              machineId: cred.machineId?.trim() || undefined,
              endpoint: cred.endpoint?.trim() || undefined,
              email: cred.email?.trim() || undefined,
              proxyUrl: cred.proxyUrl?.trim() || undefined,
              proxyUsername: cred.proxyUsername?.trim() || undefined,
              proxyPassword: cred.proxyPassword?.trim() || undefined,
              allowSameAccount,
            })

            addedCredId = addedCred.credentialId

            // 延迟 1 秒
            await new Promise(resolve => setTimeout(resolve, 1000))

            // 验活
            const balance = await getCredentialBalance(addedCred.credentialId)

            successCount++
            existingApiKeyHashes.add(credHash)
            const displayEmail = addedCred.email || cred.email?.trim() || undefined
            setCurrentProcessing(displayEmail ? `验活成功: ${displayEmail}` : `验活成功: 凭据 ${i + 1}`)
            setResults(prev => {
              const newResults = [...prev]
              newResults[i] = {
                ...newResults[i],
                status: 'verified',
                usage: `${balance.currentUsage}/${balance.usageLimit}`,
                email: displayEmail,
                credentialId: addedCred.credentialId
              }
              return newResults
            })
            setProgress({ current: i + 1, total: credentials.length })
            continue
          }

          // OAuth 凭据
          const token = cred.refreshToken!.trim()
          const clientId = cred.clientId?.trim() || undefined
          const clientSecret = cred.clientSecret?.trim() || undefined
          const requestedAuthMethod = normalizeAuthMethod(cred.authMethod)
          const authMethod = requestedAuthMethod || (clientId && clientSecret ? 'idc' : 'social')

          // idc 模式下必须同时提供 clientId 和 clientSecret
          if (authMethod === 'social' && (clientId || clientSecret)) {
            throw new Error('idc 模式需要同时提供 clientId 和 clientSecret')
          }

          const addedCred = await addCredential({
            refreshToken: token,
            accessToken: cred.accessToken?.trim() || undefined,
            profileArn: cred.profileArn?.trim() || undefined,
            expiresAt: cred.expiresAt?.trim() || undefined,
            authMethod,
            provider: cred.provider?.trim() || undefined,
            startUrl: cred.startUrl?.trim() || undefined,
            authRegion: cred.authRegion?.trim() || cred.region?.trim() || undefined,
            apiRegion: cred.apiRegion?.trim() || undefined,
            clientId,
            clientSecret,
            priority: cred.priority || 0,
            machineId: cred.machineId?.trim() || undefined,
            endpoint: cred.endpoint?.trim() || undefined,
            email: cred.email?.trim() || undefined,
            proxyUrl: cred.proxyUrl?.trim() || undefined,
            proxyUsername: cred.proxyUsername?.trim() || undefined,
            proxyPassword: cred.proxyPassword?.trim() || undefined,
            allowSameAccount,
          })

          addedCredId = addedCred.credentialId

          // 延迟 1 秒
          await new Promise(resolve => setTimeout(resolve, 1000))

          // 验活
          const balance = await getCredentialBalance(addedCred.credentialId)

          // 验活成功
          const oauthDisplayEmail = addedCred.email || cred.email?.trim() || undefined
          successCount++
          existingOauthKeys.add(`${credHash}:${cred.profileArn?.trim() || ''}`)
          setCurrentProcessing(oauthDisplayEmail ? `验活成功: ${oauthDisplayEmail}` : `验活成功: 凭据 ${i + 1}`)
          setResults(prev => {
            const newResults = [...prev]
            newResults[i] = {
              ...newResults[i],
              status: 'verified',
              usage: `${balance.currentUsage}/${balance.usageLimit}`,
              email: oauthDisplayEmail,
              credentialId: addedCred.credentialId
            }
            return newResults
          })
        } catch (error) {
          const errMsg = extractErrorMessage(error)
          // 后端账号级去重：不同 key 但属于同一上游账户。后端已自行回滚，
          // 这里归类为"重复"而非"失败"。
          if (errMsg.includes('已存在') || errMsg.includes('重复')) {
            duplicateCount++
            setResults(prev => {
              const newResults = [...prev]
              newResults[i] = {
                ...newResults[i],
                status: 'duplicate',
                error: errMsg,
                email: undefined,
              }
              return newResults
            })
            setProgress({ current: i + 1, total: credentials.length })
            continue
          }

          // 验活失败，尝试回滚（先禁用再删除）
          let rollbackStatus: VerificationResult['rollbackStatus'] = 'skipped'
          let rollbackError: string | undefined

          if (addedCredId) {
            const rollbackResult = await rollbackCredential(addedCredId)
            if (rollbackResult.success) {
              rollbackStatus = 'success'
              rollbackSuccessCount++
            } else {
              rollbackStatus = 'failed'
              rollbackFailedCount++
              rollbackError = rollbackResult.error
            }
          } else {
            rollbackSkippedCount++
          }

          failCount++
          setResults(prev => {
            const newResults = [...prev]
            newResults[i] = {
              ...newResults[i],
              status: 'failed',
              error: errMsg,
              email: undefined,
              rollbackStatus,
              rollbackError,
            }
            return newResults
          })
        }

        setProgress({ current: i + 1, total: credentials.length })
      }

      // 显示结果
      if (failCount === 0 && duplicateCount === 0) {
        toast.success(`成功导入并验活 ${successCount} 个凭据`)
      } else {
        const failureSummary = failCount > 0
          ? `，失败 ${failCount} 个（已排除 ${rollbackSuccessCount}，未排除 ${rollbackFailedCount}，无需排除 ${rollbackSkippedCount}）`
          : ''
        toast.info(`验活完成：成功 ${successCount} 个，重复 ${duplicateCount} 个${failureSummary}`)

        if (rollbackFailedCount > 0) {
          toast.warning(`有 ${rollbackFailedCount} 个失败凭据回滚未完成，请手动禁用并删除`)
        }
      }
    } catch (error) {
      toast.error('导入失败: ' + extractErrorMessage(error))
    } finally {
      setImporting(false)
    }
  }

  const getStatusIcon = (status: VerificationResult['status']) => {
    switch (status) {
      case 'pending':
        return <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
      case 'checking':
      case 'verifying':
        return <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      case 'verified':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />
      case 'duplicate':
        return <AlertCircle className="w-5 h-5 text-yellow-500" />
      case 'failed':
        return <XCircle className="w-5 h-5 text-red-500" />
    }
  }

  const getStatusText = (result: VerificationResult) => {
    switch (result.status) {
      case 'pending':
        return '等待中'
      case 'checking':
        return '检查重复...'
      case 'verifying':
        return '验活中...'
      case 'verified':
        return '验活成功'
      case 'duplicate':
        return '重复凭据'
      case 'failed':
        if (result.rollbackStatus === 'success') return '验活失败（已排除）'
        if (result.rollbackStatus === 'failed') return '验活失败（未排除）'
        return '验活失败（未创建）'
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(newOpen) => {
        // 关闭时清空表单（但不在导入过程中清空）
        if (!newOpen && !importing) {
          resetForm()
        }
        onOpenChange(newOpen)
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>批量导入凭据（自动验活）</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              JSON 格式凭据
            </label>
            <textarea
              placeholder={'粘贴 JSON 格式的凭据（支持单个对象、数组，或 KAM 导出的 {accounts:[...]}）\n\nOAuth: [{"refreshToken":"...","clientId":"...","clientSecret":"..."}]\n也支持 refresh_token / client_id / client_secret 等 snake_case 字段\nAPI Key JSON: [{"kiroApiKey":"ksk_xxx"}]\nAPI Key TXT: 一行一个 ksk_...\n\n支持 region 字段自动映射为 authRegion'}
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              disabled={importing}
              className="flex min-h-[200px] w-full rounded-xl border border-input bg-background/60 px-3.5 py-2.5 text-sm transition-[border-color,background-color,box-shadow] duration-150 ease-apple placeholder:text-muted-foreground/70 hover:border-border focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 focus-visible:bg-background disabled:cursor-not-allowed disabled:opacity-50 font-mono"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={importing} asChild>
                <label className="cursor-pointer">
                  选择 JSON/TXT 文件批量导入
                  <input
                    type="file"
                    accept=".json,.txt,application/json,text/plain"
                    multiple
                    className="hidden"
                    onChange={handleFileImport}
                  />
                </label>
              </Button>
              <p className="text-xs text-muted-foreground">
                💡 支持多文件、数组、单对象、KAM accounts、TXT 一行一个 ksk_；导入时自动验活，失败的凭据会被排除
              </p>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={allowSameAccount}
                disabled={importing}
                onChange={(e) => setAllowSameAccount(e.target.checked)}
              />
              <span>
                允许同一上游账户的多把 key（默认关闭：不同 key 但属于同一个 Kiro 账户会被账号级去重拒绝。除非你确实需要同账户多 key，否则建议保持关闭。）
              </span>
            </label>
          </div>

          {(importing || results.length > 0) && (
            <>
              {/* 进度条 */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>{importing ? '验活进度' : '验活完成'}</span>
                  <span>{progress.current} / {progress.total}</span>
                </div>
                <div className="w-full bg-secondary rounded-full h-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all"
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
                {importing && currentProcessing && (
                  <div className="text-xs text-muted-foreground">
                    {currentProcessing}
                  </div>
                )}
              </div>

              {/* 统计 */}
              <div className="flex gap-4 text-sm">
                <span className="text-green-600 dark:text-green-400">
                  ✓ 成功: {results.filter(r => r.status === 'verified').length}
                </span>
                <span className="text-yellow-600 dark:text-yellow-400">
                  ⚠ 重复: {results.filter(r => r.status === 'duplicate').length}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  ✗ 失败: {results.filter(r => r.status === 'failed').length}
                </span>
              </div>

              {/* 结果列表 */}
              <div className="border rounded-md divide-y max-h-[300px] overflow-y-auto">
                {results.map((result) => (
                  <div key={result.index} className="p-3">
                    <div className="flex items-start gap-3">
                      {getStatusIcon(result.status)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {result.email || `凭据 #${result.index}`}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {getStatusText(result)}
                          </span>
                        </div>
                        {result.usage && (
                          <div className="text-xs text-muted-foreground mt-1">
                            用量: {result.usage}
                          </div>
                        )}
                        {result.error && (
                          <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                            {result.error}
                          </div>
                        )}
                        {result.rollbackError && (
                          <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                            回滚失败: {result.rollbackError}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false)
              resetForm()
            }}
            disabled={importing}
          >
            {importing ? '验活中...' : results.length > 0 ? '关闭' : '取消'}
          </Button>
          {results.length === 0 && (
            <Button
              type="button"
              onClick={handleBatchImport}
              disabled={importing || !jsonInput.trim()}
            >
              开始导入并验活
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
