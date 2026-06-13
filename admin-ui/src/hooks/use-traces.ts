import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getTraces, getFailureStats, getRecentStats, getLimiterSnapshots } from '@/api/traces'
import type { TraceQuery } from '@/types/api'

/**
 * 请求链路查询 hook
 *
 * 复用与 stats 一致的刷新策略：30s 自动刷新、切换筛选时保留旧数据避免闪烁。
 * `enabled=false` 时不发请求（用于弹框未打开时的懒加载）。
 */
export function useTraces(query: TraceQuery, enabled = true) {
  return useQuery({
    queryKey: ['traces', query],
    queryFn: () => getTraces(query),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  })
}

/** 按凭据的失败分类计数（鉴权/风控/其他），用于卡片分色展示 */
export function useFailureStats() {
  return useQuery({
    queryKey: ['traces', 'failure-stats'],
    queryFn: getFailureStats,
    refetchInterval: 30_000,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  })
}

/** 最近 1 小时按凭据聚合的调用概况，用于卡片显示压测/并发健康度 */
export function useRecentStats() {
  return useQuery({
    queryKey: ['traces', 'recent-stats'],
    queryFn: getRecentStats,
    refetchInterval: 10_000,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  })
}

/** 自适应限流器实时快照（按 account key）：limit/gradient/RTT/退避计数 */
export function useLimiterSnapshots(enabled = true) {
  return useQuery({
    queryKey: ['limiter', 'snapshots'],
    queryFn: getLimiterSnapshots,
    enabled,
    refetchInterval: enabled ? 3_000 : false,
    staleTime: 1_500,
    refetchOnWindowFocus: false,
  })
}
