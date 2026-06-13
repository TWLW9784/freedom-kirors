// 统计凭据数与去重 profile 数（按 profileArn → email → id 归并）
import { readFileSync } from 'node:fs'

const j = JSON.parse(readFileSync('/tmp/creds.json', 'utf8'))
const arr = j.credentials || []
const profiles = new Set(arr.map((c) => c.profileArn || c.email || String(c.id)))
const tiers = {}
for (const c of arr) {
  const t = c.maxInFlight != null ? `override:${c.maxInFlight}` : 'tier-default'
  tiers[t] = (tiers[t] || 0) + 1
}
console.log('总凭据', arr.length)
console.log('可用', `${j.available}/${j.total}`)
console.log('去重 profile', profiles.size)
console.log('并发覆盖分布', JSON.stringify(tiers))
