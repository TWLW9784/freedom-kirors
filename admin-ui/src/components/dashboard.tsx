import { useState, useEffect, useRef } from "react";
import {
  RefreshCw,
  LogOut,
  Moon,
  Sun,
  Server,
  Plus,
  Upload,
  FileUp,
  FileDown,
  Trash2,
  RotateCcw,
  CheckCircle2,
  Globe,
  LogIn,
  Key,
  Building2,
  Settings,
  UploadCloud,
  MoreHorizontal,
  ChevronDown,
  Activity,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Eye,
  EyeOff,
  Copy,
  Wand2,
  Zap,
  Search,
  X,
} from "lucide-react";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12.02c0 5.1 3.29 9.42 7.86 10.95.58.11.79-.25.79-.55 0-.27-.01-.99-.02-1.95-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18a10.95 10.95 0 0 1 5.75 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.59.23 2.76.12 3.05.74.8 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12.02C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { storage } from "@/lib/storage";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { CredentialCard } from "@/components/credential-card";
import { AddCredentialDialog } from "@/components/add-credential-dialog";
import { BatchImportDialog } from "@/components/batch-import-dialog";
import { IdcLoginDialog } from "@/components/idc-login-dialog";
import { SocialLoginDialog } from "@/components/social-login-dialog";
import { KamImportDialog } from "@/components/kam-import-dialog";
import {
  BatchVerifyDialog,
  type VerifyResult,
} from "@/components/batch-verify-dialog";
import { ProxyPoolDialog } from "@/components/proxy-pool-dialog";
import { ImageUpdateDialog } from "@/components/image-update-dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  useCredentials,
  useDeleteCredential,
  useResetFailure,
  useLoadBalancingMode,
  useSetLoadBalancingMode,
  useResetAllSuccessCount,
  useSetPriority,
} from "@/hooks/use-credentials";
import { useUpdateCheck } from "@/hooks/use-update-check";
import { useFailureStats, useRecentStats } from "@/hooks/use-traces";
import { useRectSelect } from "@/hooks/use-rect-select";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import {
  getCredentialBalance,
  forceRefreshToken,
  updateAdminKey,
  disableQuotaExceeded,
  updateApiKey,
  enableOverageForAllCapable,
  exportKamCredentials,
} from "@/api/credentials";
import {
  extractErrorMessage,
  parseError,
  generateApiKey,
  formatNumber,
  overageFailureMessage,
} from "@/lib/utils";
import type { BalanceResponse, CredentialStatusItem } from "@/types/api";

interface DashboardProps {
  onLogout: () => void;
  /** 当作为 Tab 嵌入到 App 中时为 true：隐藏自带顶栏与外层布局，由父 App 提供 */
  embedded?: boolean;
}

type CredentialFilter =
  | "all"
  | "enabled"
  | "disabled"
  | "available-pro"
  | "pro"
  | "pro-plus"
  | "power"
  | "free"
  | "subscription-unknown"
  | "throttled";

type CredentialSortKey =
  | "priority"
  | "lastUsed"
  | "remaining"
  | "failures";

type SortDirection = "asc" | "desc";

const credentialFilterLabels: Record<CredentialFilter, string> = {
  all: "全部",
  enabled: "已启用",
  disabled: "已禁用",
  "available-pro": "可用 PRO/PRO+/POWER",
  pro: "PRO",
  "pro-plus": "PRO+",
  power: "POWER",
  free: "FREE",
  "subscription-unknown": "未知/未查",
  throttled: "风控冷却",
};

const credentialSortLabels: Record<CredentialSortKey, string> = {
  priority: "优先级",
  lastUsed: "最近使用",
  remaining: "剩余额度",
  failures: "失败次数",
};

function credentialSearchText(c: CredentialStatusItem): string {
  return [
    c.id,
    c.email,
    c.authMethod,
    c.endpoint,
    c.proxyUrl,
    c.disabledReason,
    c.balance?.subscriptionTitle,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getSubscriptionTitle(c: CredentialStatusItem): string {
  return (c.balance?.subscriptionTitle || "").toUpperCase();
}

function isProCredential(c: CredentialStatusItem): boolean {
  const t = getSubscriptionTitle(c);
  return t.includes("PRO") && !t.includes("PRO+") && !t.includes("POWER");
}

function isProPlusCredential(c: CredentialStatusItem): boolean {
  return getSubscriptionTitle(c).includes("PRO+");
}

function isPowerCredential(c: CredentialStatusItem): boolean {
  return getSubscriptionTitle(c).includes("POWER");
}

function isAnyProCredential(c: CredentialStatusItem): boolean {
  const t = getSubscriptionTitle(c);
  return t.includes("PRO") || t.includes("POWER");
}

function isFreeCredential(c: CredentialStatusItem): boolean {
  return getSubscriptionTitle(c).includes("FREE");
}

function hasKnownSubscription(c: CredentialStatusItem): boolean {
  return Boolean(c.balance?.subscriptionTitle);
}

function getCredentialSortValue(c: CredentialStatusItem, key: CredentialSortKey): string | number {
  switch (key) {
    case "priority":
      return c.priority;
    case "failures":
      return c.totalFailureCount ?? c.failureCount ?? 0;
    case "lastUsed":
      return c.lastUsedAt ? new Date(c.lastUsedAt).getTime() : 0;
    case "remaining":
      return c.balance?.remaining ?? 0;
  }
}

export function Dashboard({ onLogout, embedded = false }: DashboardProps) {
  const confirm = useConfirm();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [batchImportDialogOpen, setBatchImportDialogOpen] = useState(false);
  const [idcLoginDialogOpen, setIdcLoginDialogOpen] = useState(false);
  const [enterpriseLoginDialogOpen, setEnterpriseLoginDialogOpen] = useState(false);
  const [socialLoginDialogOpen, setSocialLoginDialogOpen] = useState(false);
  const [kamImportDialogOpen, setKamImportDialogOpen] = useState(false);
  const [proxyPoolDialogOpen, setProxyPoolDialogOpen] = useState(false);
  const [imageUpdateDialogOpen, setImageUpdateDialogOpen] = useState(false);
  const [adminKeyDialogOpen, setAdminKeyDialogOpen] = useState(false);
  const [newAdminKey, setNewAdminKey] = useState("");
  const [updatingAdminKey, setUpdatingAdminKey] = useState(false);
  const [showAdminKeyPlain, setShowAdminKeyPlain] = useState(false);
  /** 当前对话框正在编辑哪个 Key：'admin' = 管理面板登录 Key；'api' = 业务 /v1 流量 Key */
  const [keyEditMode, setKeyEditMode] = useState<"admin" | "api">("admin");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState({
    current: 0,
    total: 0,
  });
  const [verifyResults, setVerifyResults] = useState<Map<number, VerifyResult>>(
    new Map(),
  );
  const [balanceMap, setBalanceMap] = useState<Map<number, BalanceResponse>>(
    new Map(),
  );
  const [loadingBalanceIds, setLoadingBalanceIds] = useState<Set<number>>(
    new Set(),
  );
  const [queryingInfo, setQueryingInfo] = useState(false);
  const [queryInfoProgress, setQueryInfoProgress] = useState({
    current: 0,
    total: 0,
  });
  const [batchRefreshing, setBatchRefreshing] = useState(false);
  const [batchRefreshProgress, setBatchRefreshProgress] = useState({
    current: 0,
    total: 0,
  });
  const cancelVerifyRef = useRef(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [credentialSearch, setCredentialSearch] = useState("");
  const [credentialFilter, setCredentialFilter] = useState<CredentialFilter>("all");
  const [credentialSortKey, setCredentialSortKey] = useState<CredentialSortKey>("priority");
  const [credentialSortDirection, setCredentialSortDirection] = useState<SortDirection>("asc");
  const itemsPerPage = 12;
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== "undefined") {
      return document.documentElement.classList.contains("dark");
    }
    return false;
  });

  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useCredentials();
  const { mutate: deleteCredential } = useDeleteCredential();
  const { mutate: resetFailure } = useResetFailure();
  const { data: loadBalancingData, isLoading: isLoadingMode } =
    useLoadBalancingMode();
  const { mutate: setLoadBalancingMode, isPending: isSettingMode } =
    useSetLoadBalancingMode();
  const resetAllSuccess = useResetAllSuccessCount();
  const setPriority = useSetPriority();
  const { data: updateCheck } = useUpdateCheck();
  const { data: failureStatsMap } = useFailureStats();
  const { data: recentStatsMap } = useRecentStats();

  const allCredentials = data?.credentials || [];
  const totalInFlight = allCredentials.reduce(
    (sum, c) => sum + (c.inFlight ?? 0),
    0,
  );
  const activeInFlightCredentials = allCredentials.filter(
    (c) => (c.inFlight ?? 0) > 0,
  ).length;
  const concurrencyVersion = "RAM实时并发 v2026-06-07-1325";
  const subscriptionStats = (() => {
    let pro = 0, proPlus = 0, power = 0, free = 0, unknown = 0;
    let availablePro = 0, availableProPlus = 0, availablePower = 0, availableFree = 0;
    for (const c of allCredentials) {
      if (isPowerCredential(c)) {
        power += 1;
        if (!c.disabled) availablePower += 1;
      } else if (isProPlusCredential(c)) {
        proPlus += 1;
        if (!c.disabled) availableProPlus += 1;
      } else if (isProCredential(c)) {
        pro += 1;
        if (!c.disabled) availablePro += 1;
      } else if (isFreeCredential(c)) {
        free += 1;
        if (!c.disabled) availableFree += 1;
      } else {
        unknown += 1;
      }
    }
    const availableAnyPro = availablePro + availableProPlus + availablePower;
    return { pro, proPlus, power, free, unknown, availablePro, availableProPlus, availablePower, availableFree, availableAnyPro };
  })();
  const normalizedSearch = credentialSearch.trim().toLowerCase();
  const filteredCredentials = allCredentials.filter((c) => {
    const matchesSearch =
      !normalizedSearch || credentialSearchText(c).includes(normalizedSearch);
    if (!matchesSearch) return false;

    switch (credentialFilter) {
      case "enabled":
        return !c.disabled;
      case "disabled":
        return c.disabled;
      case "pro":
        return isProCredential(c);
      case "pro-plus":
        return isProPlusCredential(c);
      case "power":
        return isPowerCredential(c);
      case "free":
        return isFreeCredential(c);
      case "subscription-unknown":
        return !hasKnownSubscription(c);
      case "available-pro":
        return !c.disabled && isAnyProCredential(c);
      case "throttled":
        return (c.throttledRemainingSecs ?? 0) > 0;
      case "all":
      default:
        return true;
    }
  });
  const filteredSortedCredentials = [...filteredCredentials].sort((a, b) => {
    const av = getCredentialSortValue(a, credentialSortKey);
    const bv = getCredentialSortValue(b, credentialSortKey);
    let cmp = 0;
    if (typeof av === "number" && typeof bv === "number") {
      cmp = av - bv;
    } else {
      cmp = String(av).localeCompare(String(bv), "zh-CN", { numeric: true });
    }
    if (cmp === 0) cmp = a.id - b.id;
    return credentialSortDirection === "asc" ? cmp : -cmp;
  });
  const totalPages = Math.max(1, Math.ceil(filteredSortedCredentials.length / itemsPerPage));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (safeCurrentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const serverPageCreds = filteredSortedCredentials.slice(startIndex, endIndex);
  const canManualSort =
    credentialSortKey === "priority" &&
    credentialSortDirection === "asc" &&
    credentialFilter === "all" &&
    !normalizedSearch;
  // 拖拽排序的本地乐观顺序：仅当 id 集合与当前页一致时生效，否则回落到服务端顺序，
  // 避免翻页 / 数据变更后顺序错乱。
  const [pageOrder, setPageOrder] = useState<number[] | null>(null);
  const currentCredentials = (() => {
    if (!pageOrder) return serverPageCreds;
    const serverIds = new Set(serverPageCreds.map((c) => c.id));
    const orderIds = new Set(pageOrder);
    if (
      serverIds.size !== orderIds.size ||
      ![...serverIds].every((id) => orderIds.has(id))
    ) {
      return serverPageCreds;
    }
    const byId = new Map(serverPageCreds.map((c) => [c.id, c]));
    return pageOrder.map((id) => byId.get(id)!).filter(Boolean);
  })();
  const currentPageIds = currentCredentials.map((c) => c.id);
  const currentPageAllSelected =
    currentPageIds.length > 0 &&
    currentPageIds.every((id) => selectedIds.has(id));
  const filteredCredentialIds = filteredSortedCredentials.map((c) => c.id);
  const filteredAllSelected =
    filteredCredentialIds.length > 0 &&
    filteredCredentialIds.every((id) => selectedIds.has(id));

  // 翻页时清掉本地排序覆盖，回到服务端顺序
  useEffect(() => {
    setPageOrder(null);
  }, [currentPage]);

  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    if (!canManualSort) {
      toast.info("当前处于筛选/排序视图，切回“全部 + 优先级升序”后可拖拽调整优先级");
      return;
    }
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = currentCredentials.map((c) => c.id);
    const oldIndex = ids.indexOf(Number(active.id));
    const newIndex = ids.indexOf(Number(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const newOrder = arrayMove(ids, oldIndex, newIndex);
    setPageOrder(newOrder);

    // 按新视觉顺序赋连续递增的 priority（全局位置 = startIndex + 页内索引）。
    // 不依赖原有 priority 值域：即使原值全为默认 0 / 相同，也能保证数字更新、排序持久化；
    // 跨页也不冲突（第 1 页 0..11、第 2 页 12..23）。只对实际变化的卡片发请求。
    const prevPriority = new Map(
      currentCredentials.map((c) => [c.id, c.priority]),
    );
    const updates = newOrder
      .map((id, i) => ({ id, priority: startIndex + i }))
      .filter((u) => prevPriority.get(u.id) !== u.priority);
    if (updates.length === 0) return;

    Promise.all(
      updates.map((u) =>
        setPriority.mutateAsync({ id: u.id, priority: u.priority }),
      ),
    )
      .then(() => {
        toast.success("优先级顺序已更新");
        queryClient.invalidateQueries({ queryKey: ["credentials"] });
      })
      .catch((err) => {
        toast.error("更新优先级失败: " + (err as Error).message);
        setPageOrder(null);
      });
  };

  const gridRef = useRef<HTMLElement | null>(null);
  const rectSelection = useRectSelect({
    containerRef: gridRef,
    itemSelector: "[data-credential-id]",
    idAttribute: "credential-id",
    enabled: currentCredentials.length > 0,
    onSelectionChange: (hits, additive) => {
      setSelectedIds((prev) => {
        if (!additive) return new Set(hits);
        const next = new Set(prev);
        hits.forEach((id) => next.add(id));
        return next;
      });
    },
  });
  const disabledCredentialCount =
    data?.credentials.filter((c) => c.disabled).length || 0;

  // 已超额且尚未禁用的数量（用于一键超额按钮）
  const quotaExceededCount = (data?.credentials || []).filter((c) => {
    if (c.disabled) return false;
    const b = balanceMap.get(c.id) || c.balance;
    if (!b) return false;
    return b.remaining <= 0 || b.usagePercentage >= 100;
  }).length;

  // 超额统计：分别计算"已开 / 未开 / 待确定"三类，便于按钮文案与决策
  const overageStats = (() => {
    let enabled = 0;
    let disabledOff = 0;
    let unknown = 0;
    let total = 0;
    for (const c of data?.credentials || []) {
      if (c.disabled) continue;
      total += 1;
      const b = balanceMap.get(c.id) || c.balance;
      if (!b) {
        // 还没拉到余额，无法判断 — 视为待定
        unknown += 1;
        continue;
      }
      // 不可开启的订阅（FREE）不参与统计
      if (b.overageCapable === false) continue;
      if (b.overageEnabled === true) enabled += 1;
      else if (b.overageCapable === true) disabledOff += 1;
      else unknown += 1;
    }
    return { enabled, disabledOff, unknown, total };
  })();
  const overageEnableableCount = overageStats.disabledOff;
  const overageRetryableCount = overageStats.disabledOff + overageStats.unknown;

  useEffect(() => {
    setCurrentPage(1);
  }, [data?.credentials.length, credentialSearch, credentialFilter, credentialSortKey, credentialSortDirection]);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  useEffect(() => {
    if (!data?.credentials) {
      setBalanceMap(new Map());
      setLoadingBalanceIds(new Set());
      return;
    }
    const validIds = new Set(data.credentials.map((c) => c.id));
    setBalanceMap((prev) => {
      const next = new Map<number, BalanceResponse>();
      prev.forEach((v, id) => {
        if (validIds.has(id)) next.set(id, v);
      });
      return next.size === prev.size ? prev : next;
    });
    setLoadingBalanceIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<number>();
      prev.forEach((id) => {
        if (validIds.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [data?.credentials]);

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle("dark");
  };

  const handleRefresh = () => {
    refetch();
    toast.success("已刷新凭据列表");
  };

  const handleLogout = () => {
    storage.removeApiKey();
    queryClient.clear();
    onLogout();
  };

  useEffect(() => {
    if (!error) return;
    const parsed = parseError(error);
    if (parsed.type === "authentication_error") {
      toast.error("登录已失效，请重新登录");
      handleLogout();
    }
  }, [error]);

  const toggleSelect = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };
  const deselectAll = () => setSelectedIds(new Set());

  /** 全选 / 取消全选当前页凭据。已选中其他页的不会被清除。 */
  const toggleSelectCurrentPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (currentPageAllSelected) {
        currentPageIds.forEach((id) => next.delete(id));
      } else {
        currentPageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  /** 全选 / 取消全选当前筛选结果，支持跨页批量导出。 */
  const toggleSelectFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (filteredAllSelected) {
        filteredCredentialIds.forEach((id) => next.delete(id));
      } else {
        filteredCredentialIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) {
      toast.error("请先选择要删除的凭据");
      return;
    }
    const ids = Array.from(selectedIds);
    if (
      !(await confirm({
        title: "批量删除凭据",
        description: `确定要删除 ${ids.length} 个凭据吗？此操作无法撤销。`,
        confirmText: "删除",
        destructive: true,
      }))
    )
      return;
    let s = 0,
      f = 0;
    for (const id of ids) {
      try {
        await new Promise<void>((resolve, reject) => {
          deleteCredential(id, {
            onSuccess: () => {
              s++;
              resolve();
            },
            onError: (err) => {
              f++;
              reject(err);
            },
          });
        });
      } catch {}
    }
    if (f === 0) toast.success(`成功删除 ${s} 个凭据`);
    else toast.warning(`删除凭据：成功 ${s} 个，失败 ${f} 个`);
    deselectAll();
  };

  const handleBatchResetFailure = async () => {
    if (selectedIds.size === 0) {
      toast.error("请先选择要恢复的凭据");
      return;
    }
    const failedIds = Array.from(selectedIds).filter((id) => {
      const c = data?.credentials.find((x) => x.id === id);
      return c && c.failureCount > 0;
    });
    if (failedIds.length === 0) {
      toast.error("选中的凭据中没有失败的凭据");
      return;
    }
    let s = 0,
      f = 0;
    for (const id of failedIds) {
      try {
        await new Promise<void>((resolve, reject) => {
          resetFailure(id, {
            onSuccess: () => {
              s++;
              resolve();
            },
            onError: (err) => {
              f++;
              reject(err);
            },
          });
        });
      } catch {}
    }
    if (f === 0) toast.success(`成功恢复 ${s} 个凭据`);
    else toast.warning(`成功 ${s} 个，失败 ${f} 个`);
    deselectAll();
  };

  const handleBatchForceRefresh = async () => {
    if (selectedIds.size === 0) {
      toast.error("请先选择要刷新的凭据");
      return;
    }
    const enabledIds = Array.from(selectedIds).filter((id) => {
      const c = data?.credentials.find((x) => x.id === id);
      return c && !c.disabled;
    });
    if (enabledIds.length === 0) {
      toast.error("选中的凭据中没有启用的凭据");
      return;
    }
    setBatchRefreshing(true);
    setBatchRefreshProgress({ current: 0, total: enabledIds.length });
    let s = 0,
      f = 0;
    for (let i = 0; i < enabledIds.length; i++) {
      try {
        await forceRefreshToken(enabledIds[i]);
        s++;
      } catch {
        f++;
      }
      setBatchRefreshProgress({ current: i + 1, total: enabledIds.length });
    }
    setBatchRefreshing(false);
    queryClient.invalidateQueries({ queryKey: ["credentials"] });
    if (f === 0) toast.success(`成功刷新 ${s} 个凭据的 Token`);
    else toast.warning(`刷新 Token：成功 ${s} 个，失败 ${f} 个`);
    deselectAll();
  };

  const handleClearAll = async () => {
    if (!data?.credentials || data.credentials.length === 0) {
      toast.error("没有可清除的凭据");
      return;
    }
    const disabled = data.credentials.filter((c) => c.disabled);
    if (disabled.length === 0) {
      toast.error("没有可清除的已禁用凭据");
      return;
    }
    if (
      !(await confirm({
        title: "清除已禁用凭据",
        description: `确定要清除所有 ${disabled.length} 个已禁用凭据吗？此操作无法撤销。`,
        confirmText: "清除",
        destructive: true,
      }))
    )
      return;
    let s = 0,
      f = 0;
    for (const c of disabled) {
      try {
        await new Promise<void>((resolve, reject) => {
          deleteCredential(c.id, {
            onSuccess: () => {
              s++;
              resolve();
            },
            onError: (err) => {
              f++;
              reject(err);
            },
          });
        });
      } catch {}
    }
    if (f === 0) toast.success(`成功清除所有 ${s} 个已禁用凭据`);
    else toast.warning(`清除已禁用凭据：成功 ${s} 个，失败 ${f} 个`);
    deselectAll();
  };

  const handleQueryCurrentPageInfo = async () => {
    if (currentCredentials.length === 0) {
      toast.error("当前页没有可查询的凭据");
      return;
    }
    const ids = currentCredentials.filter((c) => !c.disabled).map((c) => c.id);
    if (ids.length === 0) {
      toast.error("当前页没有可查询的启用凭据");
      return;
    }
    setQueryingInfo(true);
    setQueryInfoProgress({ current: 0, total: ids.length });
    let s = 0,
      f = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      setLoadingBalanceIds((prev) => {
        const n = new Set(prev);
        n.add(id);
        return n;
      });
      try {
        const balance = await getCredentialBalance(id);
        s++;
        setBalanceMap((prev) => {
          const n = new Map(prev);
          n.set(id, balance);
          return n;
        });
      } catch {
        f++;
      } finally {
        setLoadingBalanceIds((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      }
      setQueryInfoProgress({ current: i + 1, total: ids.length });
    }
    setQueryingInfo(false);
    if (f === 0) toast.success(`查询完成：成功 ${s}/${ids.length}`);
    else toast.warning(`查询完成：成功 ${s} 个，失败 ${f} 个`);
  };

  const handleRefreshBalance = async (id: number) => {
    setLoadingBalanceIds((prev) => {
      const n = new Set(prev);
      n.add(id);
      return n;
    });
    try {
      const balance = await getCredentialBalance(id);
      setBalanceMap((prev) => {
        const n = new Map(prev);
        n.set(id, balance);
        return n;
      });
      toast.success("余额已刷新");
    } catch (err) {
      toast.error("刷新余额失败: " + (err as Error).message);
    } finally {
      setLoadingBalanceIds((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }
  };

  const handleBatchVerify = async () => {
    if (selectedIds.size === 0) {
      toast.error("请先选择要验活的凭据");
      return;
    }
    setVerifying(true);
    cancelVerifyRef.current = false;
    const ids = Array.from(selectedIds);
    setVerifyProgress({ current: 0, total: ids.length });
    let successCount = 0;
    const init = new Map<number, VerifyResult>();
    ids.forEach((id) => init.set(id, { id, status: "pending" }));
    setVerifyResults(init);
    setVerifyDialogOpen(true);
    for (let i = 0; i < ids.length; i++) {
      if (cancelVerifyRef.current) {
        toast.info("已取消验活");
        break;
      }
      const id = ids[i];
      setVerifyResults((prev) => {
        const n = new Map(prev);
        n.set(id, { id, status: "verifying" });
        return n;
      });
      try {
        const balance = await getCredentialBalance(id);
        successCount++;
        setVerifyResults((prev) => {
          const n = new Map(prev);
          n.set(id, {
            id,
            status: "success",
            usage: `${balance.currentUsage}/${balance.usageLimit}`,
          });
          return n;
        });
      } catch (err) {
        setVerifyResults((prev) => {
          const n = new Map(prev);
          n.set(id, { id, status: "failed", error: extractErrorMessage(err) });
          return n;
        });
      }
      setVerifyProgress({ current: i + 1, total: ids.length });
      if (i < ids.length - 1 && !cancelVerifyRef.current) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    setVerifying(false);
    if (!cancelVerifyRef.current)
      toast.success(`验活完成：成功 ${successCount}/${ids.length}`);
  };

  const handleCancelVerify = () => {
    cancelVerifyRef.current = true;
    setVerifying(false);
  };

  // 一键超额：把所有已超额（未禁用）凭据标记为 QuotaExceeded 并禁用
  const [disablingQuota, setDisablingQuota] = useState(false);
  const handleDisableQuotaExceeded = async () => {
    if (quotaExceededCount === 0) {
      toast.info('当前没有已超额的凭据，可先点击"刷新当前页余额"');
      return;
    }
    if (
      !(await confirm({
        title: "禁用已超额凭据",
        description: `确定要把 ${quotaExceededCount} 个已超额的凭据全部禁用吗？`,
        confirmText: "禁用",
        destructive: true,
      }))
    )
      return;
    setDisablingQuota(true);
    try {
      const res = await disableQuotaExceeded();
      const ok = res.disabledIds?.length || 0;
      const skip = res.skippedIds?.length || 0;
      if (ok > 0)
        toast.success(
          `已禁用 ${ok} 个已超额凭据${skip > 0 ? `，跳过 ${skip} 个` : ""}`,
        );
      else toast.warning("未找到已超额凭据（缓存可能已失效）");
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
    } catch (err) {
      toast.error("一键超额失败: " + extractErrorMessage(err));
    } finally {
      setDisablingQuota(false);
    }
  };

  // 一键开启超额：调用上游 setUserPreference 把所有"可开启且未开启"的凭据开启
  const [enablingOverage, setEnablingOverage] = useState(false);
  const handleEnableOverageAll = async () => {
    if (overageEnableableCount === 0) {
      toast.info("当前没有明确「未开启超额」的凭据");
      return;
    }
    if (
      !(await confirm({
        title: "开启超额",
        description: `确定要为 ${overageEnableableCount} 个凭据开启超额吗？开启后超出额度将按 overageRate 计费。`,
        confirmText: "开启",
      }))
    )
      return;
    setEnablingOverage(true);
    try {
      const res = await enableOverageForAllCapable();
      const ok = res.enabledIds?.length || 0;
      const fail = res.failedIds?.length || 0;
      if (ok > 0 && fail === 0) toast.success(`已为 ${ok} 个凭据开启超额`);
      else if (ok > 0 && fail > 0)
        toast.warning(
          `成功 ${ok} 个，失败 ${fail} 个：${overageFailureMessage(res.failureMessages?.[0])}`,
        );
      else if (fail > 0)
        toast.error(`全部失败：${overageFailureMessage(res.failureMessages?.[0])}`);
      else toast.info("没有需要操作的凭据");
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
    } catch (err) {
      toast.error("一键开启超额失败: " + extractErrorMessage(err));
    } finally {
      setEnablingOverage(false);
    }
  };

  // 重试拉取超额状态：仅针对状态待确定的凭据批量查余额（只读，安全）。
  // 区分于「一键开启超额」——后者会调用写接口 setUserPreference，FREE 订阅会 403。
  const [refreshingOverage, setRefreshingOverage] = useState(false);
  const [refreshingOverageProgress, setRefreshingOverageProgress] = useState({
    current: 0,
    total: 0,
  });
  const handleRefreshOverageStatus = async () => {
    const targets = (data?.credentials || [])
      .filter((c) => {
        if (c.disabled) return false;
        const b = balanceMap.get(c.id) || c.balance;
        if (!b) return true;
        return b.overageCapable === undefined || b.overageCapable === null;
      })
      .map((c) => c.id);
    if (targets.length === 0) {
      toast.info("没有状态待确定的凭据");
      return;
    }
    setRefreshingOverage(true);
    setRefreshingOverageProgress({ current: 0, total: targets.length });
    let s = 0,
      f = 0;
    for (let i = 0; i < targets.length; i++) {
      const id = targets[i];
      setLoadingBalanceIds((prev) => {
        const n = new Set(prev);
        n.add(id);
        return n;
      });
      try {
        const balance = await getCredentialBalance(id);
        s++;
        setBalanceMap((prev) => {
          const n = new Map(prev);
          n.set(id, balance);
          return n;
        });
      } catch {
        f++;
      } finally {
        setLoadingBalanceIds((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      }
      setRefreshingOverageProgress({ current: i + 1, total: targets.length });
    }
    setRefreshingOverage(false);
    if (f === 0) toast.success(`刷新完成：成功 ${s}/${targets.length}`);
    else toast.warning(`刷新完成：成功 ${s} 个，失败 ${f} 个`);
  };

  const [exportingKam, setExportingKam] = useState(false);
  const compactObject = <T extends Record<string, unknown>>(obj: T) =>
    Object.fromEntries(
      Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    );

  const handleExportKam = async () => {
    if (selectedIds.size === 0) {
      toast.info("请先勾选要导出的凭据");
      return;
    }
    const ids = Array.from(selectedIds);
    setExportingKam(true);
    try {
      const exportData = await exportKamCredentials(ids);
      const normalizedAccounts = (exportData.accounts || []).map((account) =>
        compactObject({
          email: account.email,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          profileArn: account.profileArn,
          expiresAt: account.expiresAt,
          region: account.region,
          machineId: account.machineId,
        }),
      );
      const accountCount = normalizedAccounts.length;
      if (accountCount === 0) {
        toast.warning("勾选的凭据中没有可导出的（缺少 refreshToken）");
        return;
      }
      const payload = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        accounts: normalizedAccounts,
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kiro-credentials-export-${accountCount}-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const skipped = ids.length - accountCount;
      toast.success(
        skipped > 0
          ? `已导出 ${accountCount} 个凭据，${skipped} 个不可导出已跳过`
          : `已导出 ${accountCount} 个凭据`,
      );
    } catch (err) {
      toast.error("导出失败: " + extractErrorMessage(err));
    } finally {
      setExportingKam(false);
    }
  };

  const handleUpdateAdminKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = newAdminKey.trim();
    if (!key) {
      toast.error(
        keyEditMode === "admin"
          ? "新登录API密钥不能为空"
          : "新管理员API密钥不能为空",
      );
      return;
    }
    setUpdatingAdminKey(true);
    try {
      if (keyEditMode === "admin") {
        await updateAdminKey({ newKey: key });
        storage.setApiKey(key);
        toast.success("登录API密钥已更新，已自动切换到新 Key");
      } else {
        await updateApiKey({ newKey: key });
        toast.success(
          "管理员API密钥已更新，所有使用 /v1 接口的客户端都需要切换",
        );
      }
      setAdminKeyDialogOpen(false);
      setNewAdminKey("");
    } catch (error) {
      toast.error(`更新失败: ${extractErrorMessage(error)}`);
    } finally {
      setUpdatingAdminKey(false);
    }
  };

  const handleToggleLoadBalancing = () => {
    const cur = loadBalancingData?.mode || "priority";
    const next = cur === "priority" ? "balanced" : "priority";
    setLoadBalancingMode(next, {
      onSuccess: () =>
        toast.success(
          `已切换到${next === "priority" ? "优先级模式" : "均衡负载模式"}`,
        ),
      onError: (err) => toast.error(`切换失败: ${extractErrorMessage(err)}`),
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary/20 border-t-primary mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">加载中…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <div className="text-destructive font-semibold mb-2">加载失败</div>
            <p className="text-sm text-muted-foreground mb-4">
              {extractErrorMessage(error)}
            </p>
            <div className="flex gap-2 justify-center">
              <Button onClick={() => refetch()}>重试</Button>
              <Button variant="outline" onClick={handleLogout}>
                重新登录
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={embedded ? "" : "min-h-screen"}>
      {/* 顶部毛玻璃导航条（仅独立模式渲染；嵌入模式由外层 App 提供顶栏） */}
      {!embedded && (
        <header className="sticky top-0 z-40 w-full glass">
          <div className="mx-auto max-w-[1400px] flex h-16 items-center justify-between px-4 md:px-8">
            <div className="flex items-center gap-2.5">
              <img
                src="/admin/kirors.png"
                alt="Kiro"
                className="h-10 w-10 object-contain"
                draggable={false}
              />
              <span className="font-semibold tracking-tight">Kiro Admin</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleLoadBalancing}
                disabled={isLoadingMode || isSettingMode}
                title="切换负载均衡模式"
              >
                <Activity className="h-3.5 w-3.5" />
                {isLoadingMode
                  ? "加载中…"
                  : loadBalancingData?.mode === "priority"
                    ? "优先级"
                    : "均衡负载"}
              </Button>
              <Button variant="ghost" size="icon" asChild title="GitHub 仓库">
                <a
                  href="https://github.com/ZyphrZero/kiro.rs"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="GitHub 仓库"
                >
                  <GithubIcon className="h-4 w-4" />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleDarkMode}
                title="切换主题"
              >
                {darkMode ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefresh}
                title="刷新"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setImageUpdateDialogOpen(true)}
                title={
                  updateCheck?.hasUpdate
                    ? `发现新版本 v${updateCheck.latestVersion}（当前 v${updateCheck.currentVersion}）`
                    : "镜像在线更新"
                }
                className="relative"
              >
                <UploadCloud className="h-4 w-4" />
                {updateCheck?.hasUpdate && (
                  <span className="absolute right-1 top-1 inline-flex h-2 w-2 items-center justify-center">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                  </span>
                )}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" title="设置">
                    <Settings className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>密钥管理</DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={() => {
                      setKeyEditMode("admin");
                      setNewAdminKey("");
                      setShowAdminKeyPlain(false);
                      setAdminKeyDialogOpen(true);
                    }}
                  >
                    <Key />
                    修改登录API密钥（管理面板登录）
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setKeyEditMode("api");
                      setNewAdminKey("");
                      setShowAdminKeyPlain(false);
                      setAdminKeyDialogOpen(true);
                    }}
                  >
                    <Key />
                    修改管理员API密钥（客户端 /v1 调用）
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleLogout}
                title="退出登录"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>
      )}

      {/* 主内容 */}
      <main
        ref={gridRef}
        className={embedded ? "" : "mx-auto max-w-[1400px] px-4 md:px-8 py-8"}
      >
        {/* 大标题 */}
        <div className="mb-5 flex items-end justify-between gap-4 sm:mb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight leading-tight sm:text-[28px]">
              凭据管理
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              管理 Kiro 的所有访问凭据、负载均衡与登录信息
            </p>
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium">当前并发已接入：RAM {totalInFlight}</div>
            <div className="text-xs opacity-80">
              活跃凭据 {activeInFlightCredentials} 个 · {concurrencyVersion}
            </div>
          </div>
        </div>

        {/* 统计卡片 */}
        <div className="mb-5 grid grid-cols-3 gap-2 sm:mb-6 sm:gap-4 md:grid-cols-4">
          <Card className="hover:shadow-apple-lg hover:-translate-y-0.5">
            <CardContent className="p-3 sm:p-5">
              <div className="text-[11px] font-medium text-muted-foreground sm:text-[13px]">
                凭据总数
              </div>
              <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums sm:mt-2 sm:text-3xl">
                {formatNumber(data?.total)}
              </div>
            </CardContent>
          </Card>
          <Card className="hover:shadow-apple-lg hover:-translate-y-0.5">
            <CardContent className="p-3 sm:p-5">
              <div className="text-[11px] font-medium text-muted-foreground sm:text-[13px]">
                可用凭据
              </div>
              <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400 sm:mt-2 sm:text-3xl">
                {formatNumber(data?.available)}
              </div>
            </CardContent>
          </Card>
          <Card className="hover:shadow-apple-lg hover:-translate-y-0.5">
            <CardContent className="p-3 sm:p-5">
              <div className="text-[11px] font-medium text-muted-foreground sm:text-[13px]">
                当前活跃
              </div>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 sm:mt-2 sm:gap-2">
                <span className="truncate text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
                  #{data?.currentId || "-"}
                </span>
                {data?.currentId && <Badge variant="success">活跃</Badge>}
              </div>
            </CardContent>
          </Card>
          <Card className="hover:shadow-apple-lg hover:-translate-y-0.5">
            <CardContent className="p-5">
              <div className="text-[13px] font-medium text-muted-foreground">
                实时并发 RAM
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-3xl font-semibold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatNumber(totalInFlight)}
                </span>
                <Badge variant={totalInFlight > 0 ? "success" : "secondary"}>
                  当前
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 工具栏 */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">凭据列表</h2>
            {data?.credentials && data.credentials.length > 0 && (
              <Badge variant="secondary">
                {filteredSortedCredentials.length}/{data.credentials.length}
              </Badge>
            )}
            {currentCredentials.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="px-2 sm:px-3"
                onClick={toggleSelectCurrentPage}
                title={currentPageAllSelected ? "取消选择当前页" : "全选当前页"}
              >
                {currentPageAllSelected ? "取消本页" : "全选本页"}
              </Button>
            )}
            {filteredSortedCredentials.length > currentCredentials.length && (
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleSelectFiltered}
                title={filteredAllSelected ? "取消选择当前筛选结果" : "选择当前筛选结果的所有页"}
              >
                {filteredAllSelected ? "取消筛选结果" : `全选筛选结果 (${filteredSortedCredentials.length})`}
              </Button>
            )}
            {selectedIds.size > 0 && (
              <>
                <Badge variant="default">已选 {selectedIds.size}</Badge>
                <Button
                  onClick={deselectAll}
                  size="sm"
                  variant="ghost"
                  className="px-2 sm:px-3"
                >
                  取消选择
                </Button>
              </>
            )}
            {verifying && !verifyDialogOpen && (
              <Button
                onClick={() => setVerifyDialogOpen(true)}
                size="sm"
                variant="secondary"
              >
                <CheckCircle2 className="h-3.5 w-3.5 animate-spin" />
                验活中… {verifyProgress.current}/{verifyProgress.total}
              </Button>
            )}
          </div>

          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
            {/* 选中态批量操作 */}
            {selectedIds.size > 0 && (
              <>
                <Button
                  onClick={handleBatchVerify}
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  批量验活
                </Button>
                <Button
                  onClick={handleBatchForceRefresh}
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={batchRefreshing}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${batchRefreshing ? "animate-spin" : ""}`}
                  />
                  {batchRefreshing
                    ? `刷新中… ${batchRefreshProgress.current}/${batchRefreshProgress.total}`
                    : "刷新 Token"}
                </Button>
                <Button
                  onClick={handleBatchResetFailure}
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  恢复异常
                </Button>
                <Button
                  onClick={handleExportKam}
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={exportingKam}
                  title="导出勾选的凭据为规范化 JSON，可直接批量导入"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  {exportingKam ? "导出中…" : "导出 JSON"}
                </Button>
                <Button
                  onClick={handleBatchDelete}
                  size="sm"
                  variant="destructive"
                  className="w-full sm:w-auto"
                  disabled={selectedIds.size === 0}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除
                </Button>
                <span className="mx-1 hidden h-5 w-px bg-border/70 sm:inline-block" />
              </>
            )}

            {/* 刷新当前页余额 */}
            <Button
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={queryingInfo || !data?.credentials?.length}
              onClick={handleQueryCurrentPageInfo}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${queryingInfo ? "animate-spin" : ""}`}
              />
              {queryingInfo
                ? `刷新中… ${queryInfoProgress.current}/${queryInfoProgress.total}`
                : "刷新当前页余额"}
            </Button>

            {/* 主操作 */}
            <Button
              onClick={() => setAddDialogOpen(true)}
              size="sm"
              className="w-full sm:w-auto"
            >
              <Plus className="h-3.5 w-3.5" />
              添加凭据
            </Button>

            {/* 导入 / 登录折叠菜单 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="w-full sm:w-auto">
                  <Upload className="h-3.5 w-3.5" />
                  导入 / 登录
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>登录</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => setSocialLoginDialogOpen(true)}
                >
                  <LogIn />
                  Kiro 账号登录
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setIdcLoginDialogOpen(true)}>
                  <Key />
                  AWS SSO (IdC) 登录
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEnterpriseLoginDialogOpen(true)}>
                  <Building2 />
                  Enterprise (IAM Identity Center) 登录
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>导入</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => setBatchImportDialogOpen(true)}
                >
                  <Upload />
                  批量导入
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setKamImportDialogOpen(true)}>
                  <FileUp />
                  Kiro Account Manager 导入
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 维护 / 危险操作折叠菜单 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  title="更多操作"
                  className="w-full sm:w-auto"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                  <span className="sm:hidden">更多</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>维护</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setProxyPoolDialogOpen(true)}>
                  <Globe />
                  IP 代理池管理
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={
                    resetAllSuccess.isPending || !data?.credentials?.length
                  }
                  onSelect={(e) => {
                    e.preventDefault();
                    resetAllSuccess.mutate(undefined, {
                      onSuccess: (res) => toast.success(res.message),
                      onError: (err) =>
                        toast.error("重置失败: " + (err as Error).message),
                    });
                  }}
                >
                  <RotateCcw
                    className={resetAllSuccess.isPending ? "animate-spin" : ""}
                  />
                  重置成功次数
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={
                    enablingOverage ||
                    refreshingOverage ||
                    overageRetryableCount === 0
                  }
                  onSelect={(e) => {
                    e.preventDefault();
                    if (overageEnableableCount > 0) {
                      handleEnableOverageAll();
                    } else {
                      handleRefreshOverageStatus();
                    }
                  }}
                  title={
                    overageRetryableCount === 0
                      ? `全部 ${overageStats.enabled} 个 PRO/ENTERPRISE 凭据均已开启超额`
                      : `已开 ${overageStats.enabled} 个 / 未开 ${overageStats.disabledOff} 个 / 待确定 ${overageStats.unknown} 个`
                  }
                >
                  <Zap
                    className={
                      enablingOverage || refreshingOverage
                        ? "animate-pulse text-emerald-500"
                        : "text-emerald-500"
                    }
                  />
                  {refreshingOverage
                    ? `刷新中… ${refreshingOverageProgress.current}/${refreshingOverageProgress.total}`
                    : overageRetryableCount === 0
                      ? `全部已开启超额（${overageStats.enabled}）`
                      : overageEnableableCount > 0
                        ? `一键开启超额（${overageEnableableCount}）`
                        : `重试拉取超额状态（${overageStats.unknown}）`}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  disabled={disablingQuota || quotaExceededCount === 0}
                  onSelect={(e) => {
                    e.preventDefault();
                    handleDisableQuotaExceeded();
                  }}
                >
                  <AlertTriangle />
                  一键超额禁用 ({quotaExceededCount})
                </DropdownMenuItem>
                <DropdownMenuItem
                  destructive
                  disabled={disabledCredentialCount === 0}
                  onSelect={(e) => {
                    e.preventDefault();
                    handleClearAll();
                  }}
                >
                  <Trash2 />
                  清除已禁用 ({disabledCredentialCount})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* 排序 / 筛选 */}
        {data?.credentials && data.credentials.length > 0 && (
          <Card className="mb-5">
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {(["all", "enabled", "disabled", "free", "pro", "pro-plus", "power"] as CredentialFilter[]).map((key) => (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={credentialFilter === key ? "default" : "outline"}
                    onClick={() => setCredentialFilter(key)}
                  >
                    {credentialFilterLabels[key]}
                    {key === "available-pro" && ` (${subscriptionStats.availableAnyPro})`}
                    {key === "pro" && ` (${subscriptionStats.pro})`}
                    {key === "pro-plus" && ` (${subscriptionStats.proPlus})`}
                    {key === "power" && ` (${subscriptionStats.power})`}
                    {key === "free" && ` (${subscriptionStats.free})`}
                    {key === "subscription-unknown" && ` (${subscriptionStats.unknown})`}
                  </Button>
                ))}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" size="sm" variant="outline">
                      更多筛选：{credentialFilterLabels[credentialFilter]}
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuLabel>筛选</DropdownMenuLabel>
                    {(Object.keys(credentialFilterLabels) as CredentialFilter[]).map((key) => (
                      <DropdownMenuItem key={key} onSelect={() => setCredentialFilter(key)}>
                        <span className="w-4 text-center">{credentialFilter === key ? "✓" : ""}</span>
                        {credentialFilterLabels[key]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={credentialSearch}
                    onChange={(e) => setCredentialSearch(e.target.value)}
                    placeholder="搜索邮箱 / ID / 端点"
                    className="pl-9"
                  />
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" className="h-10">
                      排序：{credentialSortLabels[credentialSortKey]} · {credentialSortDirection === "asc" ? "升序" : "降序"}
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>排序</DropdownMenuLabel>
                    {(Object.keys(credentialSortLabels) as CredentialSortKey[]).map((key) => (
                      <DropdownMenuItem key={key} onSelect={() => setCredentialSortKey(key)}>
                        <span className="w-4 text-center">{credentialSortKey === key ? "✓" : ""}</span>
                        {credentialSortLabels[key]}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setCredentialSortDirection("asc")}>
                      <span className="w-4 text-center">{credentialSortDirection === "asc" ? "✓" : ""}</span>
                      升序
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setCredentialSortDirection("desc")}>
                      <span className="w-4 text-center">{credentialSortDirection === "desc" ? "✓" : ""}</span>
                      降序
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!credentialSearch && credentialFilter === "all" && credentialSortKey === "priority" && credentialSortDirection === "asc"}
                  onClick={() => {
                    setCredentialSearch("");
                    setCredentialFilter("all");
                    setCredentialSortKey("priority");
                    setCredentialSortDirection("asc");
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                  重置
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                显示 {filteredSortedCredentials.length} / {data.credentials.length}；POWER {subscriptionStats.power}（可用 {subscriptionStats.availablePower}），PRO+ {subscriptionStats.proPlus}（可用 {subscriptionStats.availableProPlus}），PRO {subscriptionStats.pro}（可用 {subscriptionStats.availablePro}），FREE {subscriptionStats.free}，未知 {subscriptionStats.unknown}
                {!canManualSort && "；当前视图不改写拖拽优先级"}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 列表 */}
        {data?.credentials.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
                <Server className="h-5 w-5" />
              </div>
              <p className="text-sm text-muted-foreground">
                暂无凭据，点击右上角“添加凭据”开始
              </p>
            </CardContent>
          </Card>
        ) : filteredSortedCredentials.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
                <Search className="h-5 w-5" />
              </div>
              <p className="text-sm text-muted-foreground">没有匹配当前筛选条件的凭据</p>
              <Button
                className="mt-4"
                variant="outline"
                size="sm"
                onClick={() => {
                  setCredentialSearch("");
                  setCredentialFilter("all");
                  setCredentialSortKey("priority");
                  setCredentialSortDirection("asc");
                }}
              >
                清空筛选
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <DndContext
              sensors={dragSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={currentPageIds}
                strategy={rectSortingStrategy}
              >
                <div className="grid select-none gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {currentCredentials.map((credential) => (
                    <CredentialCard
                      key={credential.id}
                      credential={credential}
                      selected={selectedIds.has(credential.id)}
                      onToggleSelect={() => toggleSelect(credential.id)}
                      balance={
                        balanceMap.get(credential.id) ||
                        credential.balance ||
                        null
                      }
                      loadingBalance={loadingBalanceIds.has(credential.id)}
                      onRefreshBalance={() =>
                        handleRefreshBalance(credential.id)
                      }
                      failureStats={failureStatsMap?.[String(credential.id)]}
                      recentStats={recentStatsMap?.[String(credential.id)]}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {totalPages > 1 && (
              <div className="mt-6 flex flex-wrap items-center justify-center gap-2 sm:mt-8">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={safeCurrentPage === 1}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  上一页
                </Button>
                <div className="order-first w-full px-3 text-center text-sm tabular-nums text-muted-foreground sm:order-none sm:w-auto">
                  第{" "}
                  <span className="font-medium text-foreground">
                    {safeCurrentPage}
                  </span>{" "}
                  / {totalPages} 页
                  <span className="mx-1.5 text-muted-foreground/50">·</span>共{" "}
                  {filteredSortedCredentials.length} 个
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages, p + 1))
                  }
                  disabled={safeCurrentPage === totalPages}
                >
                  下一页
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      {/* 弹窗们 */}
      <AddCredentialDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />
      <BatchImportDialog
        open={batchImportDialogOpen}
        onOpenChange={setBatchImportDialogOpen}
      />
      <SocialLoginDialog
        open={socialLoginDialogOpen}
        onOpenChange={setSocialLoginDialogOpen}
        onSuccess={() =>
          queryClient.invalidateQueries({ queryKey: ["credentials"] })
        }
      />
      <IdcLoginDialog
        open={idcLoginDialogOpen}
        onOpenChange={setIdcLoginDialogOpen}
        onSuccess={() =>
          queryClient.invalidateQueries({ queryKey: ["credentials"] })
        }
      />
      <IdcLoginDialog
        mode="enterprise"
        open={enterpriseLoginDialogOpen}
        onOpenChange={setEnterpriseLoginDialogOpen}
        onSuccess={() =>
          queryClient.invalidateQueries({ queryKey: ["credentials"] })
        }
      />
      <KamImportDialog
        open={kamImportDialogOpen}
        onOpenChange={setKamImportDialogOpen}
      />
      <ProxyPoolDialog
        open={proxyPoolDialogOpen}
        onOpenChange={setProxyPoolDialogOpen}
      />
      <ImageUpdateDialog
        open={imageUpdateDialogOpen}
        onOpenChange={setImageUpdateDialogOpen}
      />

      {rectSelection.active && rectSelection.rect && (
        <div
          className="pointer-events-none fixed z-50 rounded-sm border border-primary/70 bg-primary/15"
          style={{
            left: rectSelection.rect.left,
            top: rectSelection.rect.top,
            width: rectSelection.rect.width,
            height: rectSelection.rect.height,
          }}
        />
      )}
      <BatchVerifyDialog
        open={verifyDialogOpen}
        onOpenChange={setVerifyDialogOpen}
        verifying={verifying}
        progress={verifyProgress}
        results={verifyResults}
        onCancel={handleCancelVerify}
      />

      {/* 修改登录API密钥对话框 */}
      <Dialog
        open={adminKeyDialogOpen}
        onOpenChange={(open) => {
          if (!updatingAdminKey) setAdminKeyDialogOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="h-4 w-4" />
              {keyEditMode === "admin"
                ? "修改登录API密钥"
                : "修改管理员API密钥"}
            </DialogTitle>
            <DialogDescription>
              {keyEditMode === "admin"
                ? "用于登录此管理面板。修改后将自动更新本地存储的 Key，无需重新登录。"
                : "客户端调用 /v1/* 接口时携带的密钥。修改后所有第三方客户端（Cline、Cursor、SDK 等）都需要更新为新值。"}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleUpdateAdminKey} className="space-y-4 py-2">
            <div className="relative">
              <Input
                type={showAdminKeyPlain ? "text" : "password"}
                placeholder={
                  keyEditMode === "admin"
                    ? "输入或生成新的登录API密钥"
                    : "输入或生成新的管理员API密钥"
                }
                value={newAdminKey}
                onChange={(e) => setNewAdminKey(e.target.value)}
                disabled={updatingAdminKey}
                autoFocus
                className="pr-20 font-mono text-[13px]"
              />
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-1.5">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="pointer-events-auto h-7 w-7"
                  onClick={() => setShowAdminKeyPlain((v) => !v)}
                  disabled={updatingAdminKey}
                  title={showAdminKeyPlain ? "隐藏" : "显示"}
                >
                  {showAdminKeyPlain ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="pointer-events-auto h-7 w-7"
                  onClick={async () => {
                    if (!newAdminKey.trim()) {
                      toast.error("请先输入或生成 Key 再复制");
                      return;
                    }
                    try {
                      await navigator.clipboard.writeText(newAdminKey);
                      toast.success("已复制到剪贴板");
                    } catch {
                      toast.error("复制失败，请手动选择文本");
                    }
                  }}
                  disabled={updatingAdminKey}
                  title="复制"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const key = generateApiKey(
                    keyEditMode === "admin" ? "sk-admin-" : "sk-kiro-",
                  );
                  setNewAdminKey(key);
                  setShowAdminKeyPlain(true);
                }}
                disabled={updatingAdminKey}
              >
                <Wand2 className="h-3.5 w-3.5" />
                生成随机 Key
              </Button>
              <p className="text-[11px] text-muted-foreground">
                建议生成后立即复制保存，确认更新后即生效。
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAdminKeyDialogOpen(false)}
                disabled={updatingAdminKey}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={updatingAdminKey || !newAdminKey.trim()}
              >
                {updatingAdminKey ? "更新中…" : "确认更新"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
