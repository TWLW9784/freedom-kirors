#!/usr/bin/env node
// 极限并发压测工具 —— 针对 kiro-rs 的 /v1/messages 代理端点。
//
// 零依赖（仅用 Node 内置 http/https）。在终端实时刷新进度：
// 实时并发 / 已发 / 成功 / 失败 / 429 / req·s / 延迟 p50·p90·p99 / TTFB。
//
// 用法示例：
//   node tools/stress-test.mjs --url http://127.0.0.1:8990 --key sk-xxx \
//       --model claude-sonnet-4.5 --concurrency 50 --duration 30
//
// 参数：
//   --url          代理基地址（默认 http://127.0.0.1:8990）
//   --key          x-api-key（master apiKey 或客户端 key），必填
//   --model        模型名（默认 claude-sonnet-4.5）
//   --concurrency  并发 worker 数（默认 20）
//   --duration     压测时长秒（与 --requests 二选一，默认 20）
//   --requests     总请求数（设置后忽略 --duration）
//   --stream       是否走流式（默认 false，非流式更快收敛延迟统计）
//   --max-tokens   每请求 max_tokens（默认 64，越小越快）
//   --prompt       请求内容（默认 "ping"，压测重在调度不在内容）
//   --timeout      单请求超时秒（默认 120）

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true // 布尔 flag
      } else {
        args[key] = next
        i++
      }
    }
  }
  return args
}

const args = parseArgs(process.argv)
const BASE_URL = args.url || 'http://127.0.0.1:8990'
const API_KEY = args.key || process.env.KIRO_API_KEY
const MODEL = args.model || 'claude-sonnet-4.5'
const CONCURRENCY = parseInt(args.concurrency || '20', 10)
const DURATION_S = parseInt(args.duration || '20', 10)
const TOTAL_REQUESTS = args.requests ? parseInt(args.requests, 10) : null
const STREAM = args.stream === true || args.stream === 'true'
const MAX_TOKENS = parseInt(args['max-tokens'] || '64', 10)
const PROMPT = args.prompt || 'ping'
const TIMEOUT_MS = parseInt(args.timeout || '120', 10) * 1000

if (!API_KEY) {
  console.error('错误：必须通过 --key 或 KIRO_API_KEY 提供 API Key')
  process.exit(1)
}

const target = new URL('/v1/messages', BASE_URL)
const isHttps = target.protocol === 'https:'
const agentLib = isHttps ? https : http
// keep-alive，最大 socket 跟随并发，避免 socket 建立成为瓶颈
const agent = new agentLib.Agent({
  keepAlive: true,
  maxSockets: CONCURRENCY * 2,
  maxFreeSockets: CONCURRENCY,
})

const REQUEST_BODY = JSON.stringify({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  stream: STREAM,
  messages: [{ role: 'user', content: PROMPT }],
})

// ---------- 统计状态 ----------
const stats = {
  sent: 0,
  inFlight: 0,
  success: 0,
  failed: 0,
  throttled429: 0, // 429
  serverErr5xx: 0,
  other4xx: 0,
  network: 0,
  timeout: 0,
  latencies: [], // 全量延迟（ms），用于分位
  ttfbs: [], // 首字节延迟（ms）
  statusCounts: new Map(), // 状态码 → 计数
  bytesIn: 0,
}

let running = true
const startTime = Date.now()
let endTime = TOTAL_REQUESTS ? null : startTime + DURATION_S * 1000

// 上一秒快照，用于算瞬时 req/s
let lastTickSent = 0
let lastTickTime = startTime

function recordStatus(code) {
  stats.statusCounts.set(code, (stats.statusCounts.get(code) || 0) + 1)
}

function shouldContinue() {
  if (!running) return false
  if (TOTAL_REQUESTS) return stats.sent < TOTAL_REQUESTS
  return Date.now() < endTime
}

// ---------- 单请求 ----------
function doRequest() {
  return new Promise((resolve) => {
    const reqStart = Date.now()
    let firstByteAt = null
    const options = {
      method: 'POST',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname,
      agent,
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(REQUEST_BODY),
      },
      timeout: TIMEOUT_MS,
    }

    const req = agentLib.request(options, (res) => {
      const code = res.statusCode
      res.on('data', (chunk) => {
        if (firstByteAt === null) {
          firstByteAt = Date.now()
          stats.ttfbs.push(firstByteAt - reqStart)
        }
        stats.bytesIn += chunk.length
      })
      res.on('end', () => {
        const elapsed = Date.now() - reqStart
        stats.latencies.push(elapsed)
        recordStatus(code)
        if (code >= 200 && code < 300) {
          stats.success++
        } else if (code === 429) {
          stats.throttled429++
          stats.failed++
        } else if (code >= 500) {
          stats.serverErr5xx++
          stats.failed++
        } else {
          stats.other4xx++
          stats.failed++
        }
        resolve()
      })
    })

    req.on('error', () => {
      stats.network++
      stats.failed++
      recordStatus('ERR')
      resolve()
    })
    req.on('timeout', () => {
      stats.timeout++
      stats.failed++
      recordStatus('TIMEOUT')
      req.destroy()
      resolve()
    })

    req.write(REQUEST_BODY)
    req.end()
  })
}

// ---------- worker：持续发请求直到停止条件 ----------
async function worker() {
  while (shouldContinue()) {
    stats.sent++
    stats.inFlight++
    await doRequest()
    stats.inFlight--
  }
}

// ---------- 实时渲染 ----------
function percentile(arr, p) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function fmt(n, w = 0) {
  return String(n).padStart(w)
}

function render(final = false) {
  const now = Date.now()
  const elapsedS = (now - startTime) / 1000
  const tickDt = (now - lastTickTime) / 1000
  const instRps = tickDt > 0 ? (stats.sent - lastTickSent) / tickDt : 0
  lastTickSent = stats.sent
  lastTickTime = now
  const avgRps = elapsedS > 0 ? stats.success / elapsedS : 0

  const done = stats.success + stats.failed
  const successRate = done > 0 ? (stats.success / done) * 100 : 0

  const p50 = percentile(stats.latencies, 50)
  const p90 = percentile(stats.latencies, 90)
  const p99 = percentile(stats.latencies, 99)
  const ttfbP50 = percentile(stats.ttfbs, 50)

  let progressLine
  if (TOTAL_REQUESTS) {
    const pct = Math.min(100, (stats.sent / TOTAL_REQUESTS) * 100)
    progressLine = `进度 ${fmt(stats.sent)}/${TOTAL_REQUESTS} (${pct.toFixed(1)}%)  已用 ${elapsedS.toFixed(1)}s`
  } else {
    const remain = Math.max(0, (endTime - now) / 1000)
    progressLine = `已用 ${elapsedS.toFixed(1)}s  剩余 ${remain.toFixed(1)}s`
  }

  const lines = [
    `\x1b[1m━━ kiro-rs 并发压测 ━━\x1b[0m  目标 ${BASE_URL}  模型 ${MODEL}  并发 ${CONCURRENCY}${STREAM ? '  [流式]' : ''}`,
    progressLine,
    `实时并发 \x1b[36m${fmt(stats.inFlight, 4)}\x1b[0m   瞬时 \x1b[36m${instRps.toFixed(1)}\x1b[0m req/s   平均成功 \x1b[36m${avgRps.toFixed(1)}\x1b[0m req/s`,
    `成功 \x1b[32m${fmt(stats.success, 5)}\x1b[0m   失败 \x1b[31m${fmt(stats.failed, 5)}\x1b[0m   成功率 ${successRate.toFixed(1)}%`,
    `429限流 \x1b[33m${fmt(stats.throttled429, 4)}\x1b[0m   5xx \x1b[31m${fmt(stats.serverErr5xx, 4)}\x1b[0m   其他4xx ${fmt(stats.other4xx, 4)}   网络错 ${fmt(stats.network, 4)}   超时 ${fmt(stats.timeout, 4)}`,
    `延迟(ms)  p50 \x1b[35m${fmt(p50, 6)}\x1b[0m   p90 \x1b[35m${fmt(p90, 6)}\x1b[0m   p99 \x1b[35m${fmt(p99, 6)}\x1b[0m   TTFB p50 ${fmt(ttfbP50, 5)}`,
  ]

  // 清屏重绘：移动到行首并清除前 N 行
  if (!final && process.stdout.isTTY) {
    if (render._lastLines) {
      process.stdout.write(`\x1b[${render._lastLines}A`)
    }
    for (const l of lines) {
      process.stdout.write('\x1b[2K' + l + '\n')
    }
    render._lastLines = lines.length
  } else {
    process.stdout.write(lines.join('\n') + '\n')
  }
}

// ---------- 收尾报告 ----------
function finalReport() {
  render(true)
  const elapsedS = (Date.now() - startTime) / 1000
  const done = stats.success + stats.failed
  console.log('\n\x1b[1m━━ 压测结果汇总 ━━\x1b[0m')
  console.log(`总耗时        ${elapsedS.toFixed(2)} s`)
  console.log(`总请求        ${stats.sent}`)
  console.log(`成功          ${stats.success}  (${done > 0 ? ((stats.success / done) * 100).toFixed(2) : 0}%)`)
  console.log(`吞吐(成功)    ${(stats.success / elapsedS).toFixed(2)} req/s`)
  console.log(`429 限流      ${stats.throttled429}`)
  console.log(`5xx          ${stats.serverErr5xx}`)
  console.log(`其他 4xx      ${stats.other4xx}`)
  console.log(`网络错误      ${stats.network}`)
  console.log(`超时          ${stats.timeout}`)
  console.log(
    `延迟(ms)      p50=${percentile(stats.latencies, 50)}  p90=${percentile(stats.latencies, 90)}  p99=${percentile(stats.latencies, 99)}  max=${stats.latencies.length ? Math.max(...stats.latencies) : 0}`,
  )
  console.log(`接收数据      ${(stats.bytesIn / 1024).toFixed(1)} KiB`)
  console.log('状态码分布:')
  const sortedCodes = [...stats.statusCounts.entries()].sort((a, b) => b[1] - a[1])
  for (const [code, cnt] of sortedCodes) {
    console.log(`  ${String(code).padEnd(8)} ${cnt}`)
  }
}

// ---------- 主流程 ----------
async function main() {
  console.log(
    `启动压测：并发=${CONCURRENCY} ${TOTAL_REQUESTS ? `总请求=${TOTAL_REQUESTS}` : `时长=${DURATION_S}s`} 流式=${STREAM}\n`,
  )
  const timer = setInterval(() => render(false), 500)

  process.on('SIGINT', () => {
    running = false
    clearInterval(timer)
    setTimeout(() => {
      finalReport()
      process.exit(0)
    }, 200)
  })

  const workers = Array.from({ length: CONCURRENCY }, () => worker())
  await Promise.all(workers)

  clearInterval(timer)
  finalReport()
  agent.destroy()
  process.exit(0)
}

main().catch((err) => {
  console.error('压测异常:', err)
  process.exit(1)
})
