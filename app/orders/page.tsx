"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronDown,
  ClipboardList,
  CloudOff,
  History,
  Play,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { useOrdersStore } from "@/store/useOrdersStore";
import { usePosStoreHydrated } from "@/hooks/usePosStoreHydrated";
import { useOrdersBoot } from "@/hooks/useOrdersBoot";
import { subscribeCatalogRefresh } from "@/lib/catalogInvalidation";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { computeSaleTotals } from "@/lib/saleMath";
import { formatMoney } from "@/lib/format";
import { formatProductDisplayName } from "@/lib/productDisplayName";
import type { LocalOrder } from "@/types/orders.types";
import OrderPrintButton from "@/components/orders/OrderPrintButton";
import OrderReturnButton from "@/components/orders/OrderReturnButton";
import OrderFilter, {
  EMPTY_FILTER,
  type OrderFilterState,
} from "@/components/orders/OrderFilter";
import { isWedgeBurst } from "@/hooks/useBarcodeScanner";

type Tab = "open" | "closed";

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ar", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
}

function orderTotal(order: LocalOrder): number {
  // Same derivation checkout uses: line discounts, invoice discount, tax,
  // delivery fee.
  return computeSaleTotals(order.items, order.invoiceDiscount, 0, order.deliveryFee).total;
}

function matchesQuery(order: LocalOrder, q: string): boolean {
  if (!q) return true;
  const haystack = [
    order.orderNumber,
    order.customerName ?? "",
    order.customerPhone ?? "",
    order.cashierName ?? "",
    order.deviceName ?? "",
    order.invoiceSyncId ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q.toLowerCase());
}

/** True when the query exactly identifies one order (scanned barcode match). */
function isExactId(order: LocalOrder, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  return (
    order.orderNumber.toLowerCase() === needle ||
    (order.invoiceSyncId ?? "").toLowerCase() === needle
  );
}

function matchesFilters(order: LocalOrder, filter: OrderFilterState): boolean {
  if (filter.status !== "all") {
    if (filter.status === "CANCELLED" && order.status !== "CANCELLED") return false;
    if (filter.status === "COMPLETED" && order.status !== "CLOSED") return false;
  }

  const stamp = order.closedAt ?? order.createdAt;
  if (filter.date !== "all" && stamp) {
    const d = new Date(stamp);
    const today = new Date();
    const startOfDay = (dt: Date) =>
      new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
    if (filter.date === "today" && startOfDay(d) !== startOfDay(today)) return false;
    if (filter.date === "yesterday") {
      const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      if (startOfDay(d) !== startOfDay(yesterday)) return false;
    }
    if (filter.date === "date" && filter.dateValue) {
      const target = new Date(`${filter.dateValue}T00:00:00`);
      if (startOfDay(d) !== startOfDay(target)) return false;
    }
  }

  return true;
}

/**
 * صفحة الطلبات (Phase 3). Cross-device parked-order board: an Open tab to
 * resume/retire live carts and a Closed tab for settled history — responsive
 * card grid, never tables, in the register design language.
 */
export default function OrdersPage() {
  const router = useRouter();
  const hydrated = usePosStoreHydrated();
  const currentCashier = usePosStore((s) => s.currentCashier);
  const restoreInvoice = usePosStore((s) => s.restoreInvoice);
  const cancelOrder = useOrdersStore((s) => s.cancelOrder);

  const orders = useOrdersStore((s) => s.orders);
  const loading = useOrdersStore((s) => s.loading);
  const lastSyncError = useOrdersStore((s) => s.lastSyncError);
  const hydrate = useOrdersStore((s) => s.hydrate);
  const settledOrders = useOrdersStore((s) => s.settledOrders);
  const settledLoading = useOrdersStore((s) => s.settledLoading);
  const settledError = useOrdersStore((s) => s.settledError);
  const settledHasMore = useOrdersStore((s) => s.settledHasMore);
  const fetchSettledHistory = useOrdersStore((s) => s.fetchSettledHistory);

  const [tab, setTab] = useState<Tab>("open");
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 250);
  const [filter, setFilter] = useState<OrderFilterState>(EMPTY_FILTER);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live cross-device order sync. This standalone route does NOT render
  // PosLayout (the only place useOrdersBoot is otherwise mounted), so the
  // pos_orders realtime socket would tear down on navigation and Cashier B
  // would never see Cashier A's open/close/cancel until a manual refresh.
  // Mount it here too — the hook is reference-counted (start/stopCatalogWatch)
  // so it coexists with PosLayout, and it returns early when no tenant is set.
  useOrdersBoot();

  // useOrdersBoot's "orders" handler re-pulls the OPEN board only. Keep the
  // Closed tab live too: when a pos_orders event fires while the Closed tab is
  // active, refresh settled history so another register's close/cancel appears
  // without a manual refresh (pos_orders events only ever target our store).
  useEffect(() => {
    if (!hydrated || !currentCashier) return;
    if (tab !== "closed") return;
    const unsub = subscribeCatalogRefresh((reason) => {
      if (reason === "orders") void fetchSettledHistory();
    });
    return unsub;
  }, [tab, hydrated, currentCashier, fetchSettledHistory]);

  // Register-area guard: without a live cashier session there is nothing to
  // show — bounce to login like the register shell does.
  useEffect(() => {
    if (!hydrated) return;
    if (!currentCashier || currentCashier.sessionReady === false) {
      router.replace("/login");
    }
  }, [hydrated, currentCashier, router]);

  // Idempotent board hydration (boot cache → IDB → server).
  useEffect(() => {
    if (!hydrated || !currentCashier) return;
    void hydrate();
  }, [hydrated, currentCashier, hydrate]);

  // The Closed tab always pulls fresh history when activated, and re-pulls
  // whenever the window regains focus while still on it (a checkout closed
  // on another device must appear without a manual refresh). A mounted page
  // opened directly on the closed tab is covered by the focus listener too.
  useEffect(() => {
    if (!hydrated || !currentCashier) return;
    if (tab !== "closed") return;
    let cancelled = false;
    const refresh = () => {
      if (!cancelled) void fetchSettledHistory();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tab, hydrated, currentCashier, fetchSettledHistory]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  // Scanner-ready search: a USB barcode scanner behaves as a machine-fast
  // keyboard burst terminated by Enter. When the cashier scans a receipt
  // barcode (order_number / invoice_id) without focusing the search field, we
  // capture the burst and route it into the search as an exact match. Focused
  // field scans flow through the input's onChange naturally.
  useEffect(() => {
    let buffer: string[] = [];
    let start = 0;
    let last = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const el = document.activeElement;
      const inField =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          (el as HTMLElement).isContentEditable);
      // A scanner typing into a focused field is handled by the browser
      // itself; only capture bursts typed while nothing editable is focused.
      if (inField) return;

      if (e.key === "Enter" || e.key === "Tab") {
        if (buffer.length >= 3) {
          const now = performance.now();
          if (
            isWedgeBurst({
              length: buffer.length,
              start,
              now,
              avgKeyMs: (now - start) / buffer.length,
            })
          ) {
            e.preventDefault();
            const code = buffer.join("");
            setTab("closed");
            setQ(code);
            setExpandedId(null);
          }
        }
        buffer = [];
        start = 0;
        last = 0;
        return;
      }

      if (e.key.length !== 1) return;
      const now = performance.now();
      if (buffer.length === 0 || now - last > 60) {
        buffer = [];
        start = now;
      }
      last = now;
      buffer.push(e.key);
      if (buffer.length >= 128 || now - start > 600) {
        buffer = [];
        start = 0;
        last = 0;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openOrders = useMemo(() => orders.filter((o) => o.status === "OPEN"), [orders]);

  // Offline fallback for the Closed tab: surface whatever settled rows the
  // local cache holds instead of an empty screen.
  const settledRows = useMemo(() => {
    if (tab !== "closed") return [];
    if (settledError) return orders.filter((o) => o.status !== "OPEN");
    return settledOrders;
  }, [tab, orders, settledOrders, settledError]);

  const rows = tab === "open" ? openOrders : settledRows;

  const visible = useMemo(() => {
    const exactMatches = debouncedQ ? rows.filter((o) => isExactId(o, debouncedQ)) : [];
    const base = exactMatches.length > 0 ? exactMatches : rows;
    return base.filter((o) => {
      if (!matchesQuery(o, debouncedQ)) return false;
      return matchesFilters(o, filter);
    });
  }, [rows, debouncedQ, filter]);

  const handleCancelClick = (orderId: string) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmCancelId !== orderId) {
      setConfirmCancelId(orderId);
      confirmTimer.current = setTimeout(() => setConfirmCancelId(null), 3000);
      return;
    }
    setConfirmCancelId(null);
    cancelOrder(orderId, "أُلغي من صفحة الطلبات");
  };

  const handleResume = (order: LocalOrder) => {
    restoreInvoice(order.id);
    router.push("/pos");
  };

  // Fetch the next page of settled history. Offset pagination over `updated_at`
  // never skips a row, so every closed/cancelled invoice stays reachable even
  // past the first page (previously hard-capped at 100 and silently hidden).
  const handleLoadMore = () => {
    if (tab !== "closed" || settledLoading) return;
    void fetchSettledHistory(undefined, "more");
  };

  const refreshing = tab === "open" ? loading : settledLoading;
  const offlineNotice =
    tab === "closed" && settledError
      ? "تعذر جلب السجل من الخادم — تُعرض آخر الطلبات المخزّنة محلياً"
      : null;

  if (!hydrated || !currentCashier) return null;

  return (
    <div dir="rtl" lang="ar" className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto w-full max-w-7xl space-y-4 px-4 py-5 md:px-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Link
              href="/pos"
              aria-label="رجوع لنقطة البيع"
              title="رجوع لنقطة البيع"
              className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-surface text-muted transition hover:bg-surface-muted hover:text-foreground"
            >
              <ArrowRight className="h-5 w-5" />
            </Link>
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-black">
                <ClipboardList className="h-6 w-6 text-primary" />
                صفحة الطلبات
              </h1>
              <p className="mt-0.5 text-sm font-semibold text-muted">
                طلبات مفتوحة قابلة للاستكمال على أي جهاز، وسجل للطلبات المغلقة والملغاة
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void hydrate();
              if (tab === "closed") void fetchSettledHistory();
            }}
            disabled={refreshing}
            className="flex h-10 items-center justify-center gap-2 self-start rounded-xl border border-border bg-surface px-4 text-sm font-black transition hover:bg-surface-muted disabled:opacity-50 sm:self-auto"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            تحديث
          </button>
        </header>

        {/* ── Tabs + search ── */}
        <section className="rounded-2xl border border-border bg-surface p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-muted p-1 lg:w-fit">
              <button
                type="button"
                onClick={() => setTab("open")}
                aria-pressed={tab === "open"}
                className={`flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-black transition ${
                  tab === "open" ? "bg-white shadow-card" : "text-muted hover:text-foreground"
                }`}
              >
                طلبات مفتوحة
                <span
                  className={`grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs font-black ${
                    tab === "open" ? "bg-primary text-primary-foreground" : "bg-white/60 text-muted"
                  }`}
                >
                  {openOrders.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setTab("closed")}
                aria-pressed={tab === "closed"}
                className={`flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-black transition ${
                  tab === "closed" ? "bg-white shadow-card" : "text-muted hover:text-foreground"
                }`}
              >
                <History className={`h-4 w-4 ${tab === "closed" ? "text-primary" : ""}`} />
                طلبات مغلقة
              </button>
            </div>
            <div className="flex w-full items-center gap-2 lg:w-auto">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ابحث برقم الطلب أو الزبون أو الكاشير…"
                className="h-11 w-full flex-1 rounded-xl border border-border bg-white px-3 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30 lg:w-80"
              />
              <OrderFilter value={filter} onChange={setFilter} />
            </div>
          </div>
        </section>

        {lastSyncError && tab === "open" && (
          <p className="flex items-center gap-2 rounded-xl bg-warning/10 px-4 py-2.5 text-xs font-bold text-warning-strong">
            <CloudOff className="h-4 w-4 shrink-0" />
            دون اتصال بالخادم — تُعرض الطلبات المخزّنة على هذا الجهاز وستتحدث تلقائياً عند عودة الشبكة
          </p>
        )}
        {offlineNotice && (
          <p className="flex items-center gap-2 rounded-xl bg-warning/10 px-4 py-2.5 text-xs font-bold text-warning-strong">
            <CloudOff className="h-4 w-4 shrink-0" />
            {offlineNotice}
          </p>
        )}

        {/* ── Card grid ── */}
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface px-6 py-16 text-center">
            {tab === "open" ? (
              <>
                <ClipboardList className="h-12 w-12 text-muted-foreground/40" />
                <p className="text-base font-black">لا توجد طلبات مفتوحة</p>
                <p className="max-w-sm text-sm font-semibold text-muted">
                  استخدم زر «طلب مفتوح» في شاشة الكاشير لتسجيل سلة واستكمالها لاحقاً من أي جهاز
                </p>
              </>
            ) : (
              <>
                <History className="h-12 w-12 text-muted-foreground/40" />
                <p className="text-base font-black">لا توجد طلبات مغلقة أو ملغاة</p>
                <p className="text-sm font-semibold text-muted">
                  يظهر هنا سجل الطلبات بعد إتمام بيعها أو إلغائها
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((order) => {
              const total = orderTotal(order);
              const itemCount = order.items.reduce(
                (n, it) => n + (Number.isFinite(it.qty) ? it.qty : 0),
                0,
              );
              const isOpen = order.status === "OPEN";
              const cancelled = order.status === "CANCELLED";
              const expanded = expandedId === order.id;
              return (
                <article
                  key={order.id}
                  className={`flex flex-col rounded-2xl border bg-surface p-4 shadow-sm transition ${
                    cancelled ? "border-destructive/30" : "border-border"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black tabular-nums">{order.orderNumber}</p>
                      <p className="mt-0.5 truncate text-xs font-semibold text-muted">
                        {fmtDate(isOpen ? order.createdAt : order.closedAt)} ·{" "}
                        {fmtTime(isOpen ? order.createdAt : order.closedAt)}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-black leading-none ${
                        cancelled
                          ? "bg-destructive/10 text-destructive"
                          : isOpen
                            ? "bg-warning/15 text-warning-strong"
                            : "bg-success/10 text-success"
                      }`}
                    >
                      {cancelled ? "ملغي" : isOpen ? "مفتوح" : "مكتمل"}
                    </span>
                  </div>

                  <div className="mt-2 space-y-0.5 text-xs font-semibold text-muted">
                    {order.customerName && <p className="truncate">الزبون: {order.customerName}</p>}
                    <p className="truncate">
                      الكاشير: {order.cashierName ?? "—"}
                      {order.deviceName ? ` · ${order.deviceName}` : ""}
                    </p>
                    {!isOpen && order.invoiceSyncId && (
                      <p className="truncate">الفاتورة: {order.invoiceSyncId.slice(0, 13)}</p>
                    )}
                    {!isOpen && cancelled && order.cancelReason && (
                      <p className="truncate text-destructive">السبب: {order.cancelReason}</p>
                    )}
                  </div>

                  {expanded && (
                    <ul className="mt-2 space-y-1 rounded-xl bg-surface-muted/70 p-2.5 text-xs font-bold">
                      {order.items.map((item, idx) => (
                        <li key={`${item.barcode}-${idx}`} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate">
                            {formatProductDisplayName(item.name, item.variantLabel)}
                            <span className="text-muted">
                              {" "}
                              ×{Number.isFinite(item.qty) ? item.qty : 0} {item.unitName}
                            </span>
                          </span>
                          <span className="shrink-0 tabular-nums">{formatMoney(item.lineTotal)}</span>
                        </li>
                      ))}
                      {order.items.length === 0 && <li className="text-muted">لا أصناف</li>}
                    </ul>
                  )}

                  <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                    <div>
                      <p className="text-[11px] font-bold text-muted">
                        {itemCount} صنف
                        {order.pendingSync ? " · بانتظار المزامنة" : ""}
                      </p>
                      <p className="text-lg font-black tabular-nums leading-tight">{formatMoney(total)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <OrderPrintButton order={order} />
                      <OrderReturnButton order={order} />
                      <button
                        type="button"
                        aria-label={expanded ? "إخفاء الأصناف" : "عرض الأصناف"}
                        title={expanded ? "إخفاء الأصناف" : "عرض الأصناف"}
                        onClick={() => setExpandedId(expanded ? null : order.id)}
                        className={`grid h-9 w-9 place-items-center rounded-lg border border-border text-muted transition hover:bg-surface-muted hover:text-foreground ${
                          expanded ? "rotate-180" : ""
                        }`}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      {isOpen && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleResume(order)}
                            className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-black transition ${
                              confirmCancelId === order.id
                                ? "hidden"
                                : "bg-primary text-primary-foreground hover:bg-primary-hover"
                            }`}
                          >
                            <Play className="h-3.5 w-3.5" />
                            استكمال
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCancelClick(order.id)}
                            onMouseLeave={() => {
                              if (confirmCancelId === order.id) {
                                if (confirmTimer.current) clearTimeout(confirmTimer.current);
                                setConfirmCancelId(null);
                              }
                            }}
                            className={`flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-black transition active:scale-[0.97] ${
                              confirmCancelId === order.id
                                ? "border-rose-300 bg-rose-500 text-white hover:bg-rose-600"
                                : "border-border text-muted hover:border-rose-200 hover:bg-rose-50 hover:text-destructive"
                            }`}
                          >
                            <XCircle className="h-3.5 w-3.5 shrink-0" />
                            {confirmCancelId === order.id ? "تأكيد الإلغاء" : "إلغاء"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
            </div>

            {/* Keep the entire closed/cancelled history reachable — a fixed
                cap would silently hide older invoices. Page in the rest. */}
            {tab === "closed" && settledHasMore && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={settledLoading}
                  className="flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-6 text-sm font-black text-primary transition hover:bg-surface-muted disabled:opacity-50"
                >
                  {settledLoading ? "جارٍ التحميل..." : "تحميل طلبات أقدم"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
