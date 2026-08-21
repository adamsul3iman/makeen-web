"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote,
  CalendarDays,
  CheckCircle2,
  Clock3,
  CreditCard,
  History,
  LockKeyhole,
  Printer,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Store,
  TicketPercent,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";
import { ListPagination } from "@/components/admin/ListPagination";
import { SearchInput } from "@/components/admin/SearchInput";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatMoney } from "@/lib/format";
import { posFetch } from "@/lib/tenantClient";
import { hasCapability } from "@/lib/permissions";
import { usePosStore } from "@/store/usePosStore";
import type { OpenShiftAudit, OpenShiftResponse, ShiftAudit, ShiftAuditResponse } from "@/types/shifts.types";
import { formatShiftTime } from "@/lib/dateTime";
import ShiftDetailModal from "@/components/admin/ShiftDetailModal";
import ShiftPrintView from "@/components/admin/ShiftPrintView";
import ThermalShiftPrintView from "@/components/admin/ThermalShiftPrintView";
import { smartPrint } from "@/lib/printAgent";

interface Option {
  id: string;
  name: string;
}

function VarianceBadge({ variance }: { variance: number }) {
  const tone =
    variance > 0 ? "bg-success/10 text-success" : variance < 0 ? "bg-destructive/10 text-destructive" : "bg-surface-muted text-muted";
  const label = variance > 0 ? "زيادة" : variance < 0 ? "عجز" : "مطابق";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-black tabular-nums ${tone}`}>
      {label} {formatMoney(Math.abs(variance))}
    </span>
  );
}

export default function AdminShiftsPage() {
  const adminSession = usePosStore((state) => state.adminSession);
  const currentCashier = usePosStore((state) => state.currentCashier);
  const activeTerminalId = usePosStore((state) => state.activeTerminalId);
  const canViewX = Boolean(adminSession || hasCapability(currentCashier, "shifts.x_report"));
  const [shifts, setShifts] = useState<ShiftAudit[]>([]);
  const [openShifts, setOpenShifts] = useState<OpenShiftAudit[]>([]);
  const [openLoading, setOpenLoading] = useState(canViewX);
  const [openError, setOpenError] = useState("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [summary, setSummary] = useState<ShiftAuditResponse["summary"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSeq = useRef(0);

  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [branchId, setBranchId] = useState("");
  const [terminalId, setTerminalId] = useState("");
  const [branches, setBranches] = useState<Option[]>([]);
  const [terminals, setTerminals] = useState<Option[]>([]);
  const [approvalTarget, setApprovalTarget] = useState<ShiftAudit | null>(null);
  const [approvalPassword, setApprovalPassword] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [approving, setApproving] = useState(false);
  const [resolutionTarget, setResolutionTarget] = useState<OpenShiftAudit | null>(null);
  const [resolutionActualCash, setResolutionActualCash] = useState("");
  const [resolutionPassword, setResolutionPassword] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [resolutionError, setResolutionError] = useState("");
  const [resolving, setResolving] = useState(false);
  const [selectedShift, setSelectedShift] = useState<ShiftAudit | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [printTarget, setPrintTarget] = useState<ShiftAudit | null>(null);
  const [printMode, setPrintMode] = useState<"a4" | "thermal">("a4");
  const [printNotice, setPrintNotice] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const printGuardRef = useRef(false);

  const handlePrint = async (shift: ShiftAudit, mode: "a4" | "thermal") => {
    if (printGuardRef.current) return;
    printGuardRef.current = true;
    setPrintNotice(null);

    // Try silent agent print first (no browser dialog).
    if (activeTerminalId) {
      try {
        const usedAgent = await smartPrint({
          terminalId: activeTerminalId,
          jobType: "Z_REPORT",
          shift,
          printerKind: mode === "thermal" ? "THERMAL" : "A4",
          onAgentSuccess: () => {
            printGuardRef.current = false;
            setPrintNotice({ message: "تم إرسال التقرير للطابعة بنجاح", tone: "success" });
            setTimeout(() => setPrintNotice(null), 3000);
          },
        });
        if (usedAgent) return;
      } catch {
        // Agent unavailable — fall through to window.print()
      }
    }

    // Fallback: mount the print view, paint, then window.print().
    setPrintMode(mode);
    setPrintTarget(shift);
  };

  useEffect(() => {
    if (!printTarget) return;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      printGuardRef.current = false;
      setPrintTarget(null);
    };
    // Give React 200ms to mount + browser to paint the print DOM, then print.
    const timer = window.setTimeout(() => {
      window.addEventListener("afterprint", cleanup, { once: true });
      window.print();
      // Fallback: if afterprint never fires (dialog cancelled or unsupported), clean up.
      const fallback = window.setTimeout(cleanup, 3000);
      window.addEventListener("afterprint", () => window.clearTimeout(fallback), { once: true });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      cleanup();
    };
  }, [printTarget]);

  useEffect(() => {
    posFetch("/api/branches", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.branches)) setBranches(data.branches);
      })
      .catch(() => {});
    posFetch("/api/terminals", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.terminals)) setTerminals(data.terminals);
      })
      .catch(() => {});
  }, []);

  const loadOpenShifts = useCallback(async () => {
    if (!canViewX) {
      setOpenShifts([]);
      setOpenLoading(false);
      return;
    }
    setOpenLoading(true);
    try {
      const response = await posFetch("/api/shifts/open", { cache: "no-store" });
      const data = response.ok ? await response.json() as OpenShiftResponse : null;
      if (!data || !Array.isArray(data.shifts)) throw new Error("x_report_failed");
      setOpenShifts(data.shifts);
      setOpenError("");
    } catch {
      setOpenShifts([]);
      setOpenError("تعذر تحميل تقارير X للورديات المفتوحة");
    } finally {
      setOpenLoading(false);
    }
  }, [canViewX]);

  const loadShifts = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (branchId) params.set("branchId", branchId);
    if (terminalId) params.set("terminalId", terminalId);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    try {
      const res = await posFetch(`/api/shifts?${params.toString()}`, { cache: "no-store" });
      const data = res.ok ? ((await res.json()) as ShiftAuditResponse | null) : null;
      if (seq !== requestSeq.current) return;
      if (data && Array.isArray(data.shifts)) {
        setShifts(data.shifts);
        setTotal(data.total);
        setPage(data.page);
        setSummary(data.summary);
        setError("");
      } else {
        setShifts([]);
        setError("تعذر تحميل تقارير الورديات");
      }
    } catch {
      if (seq !== requestSeq.current) return;
      setShifts([]);
      setError("تعذر تحميل تقارير الورديات — تحقق من الاتصال");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [debouncedQ, from, to, branchId, terminalId, page, pageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadShifts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadShifts]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOpenShifts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadOpenShifts]);

  const refreshAll = () => {
    void loadShifts();
    void loadOpenShifts();
  };

  const approveVariance = async () => {
    if (!approvalTarget || approving || approvalNote.trim().length < 3 || !approvalPassword) return;
    setApproving(true);
    setApprovalError("");
    try {
      const response = await posFetch(`/api/shifts/${approvalTarget.shiftId}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: approvalPassword, note: approvalNote.trim() }),
      });
      const data = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(response.status === 401 ? "كلمة مرور المالك غير صحيحة" : data?.error ?? "تعذر اعتماد الفرق");
      }
      setApprovalTarget(null);
      setApprovalPassword("");
      setApprovalNote("");
      await loadShifts();
    } catch (approvalFailure) {
      setApprovalError(approvalFailure instanceof Error ? approvalFailure.message : "تعذر اعتماد الفرق");
    } finally {
      setApproving(false);
    }
  };

  const closeResolution = () => {
    setResolutionTarget(null);
    setResolutionActualCash("");
    setResolutionPassword("");
    setResolutionNote("");
    setResolutionError("");
  };

  const resolveStaleShift = async () => {
    if (!resolutionTarget || resolving) return;
    const actualCash = Number(resolutionActualCash);
    if (!resolutionActualCash.trim() || !Number.isFinite(actualCash) || actualCash < 0) return;
    if (!resolutionPassword || resolutionNote.trim().length < 3) return;
    setResolving(true);
    setResolutionError("");
    try {
      const response = await posFetch(`/api/shifts/${resolutionTarget.shiftId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actualCash,
          password: resolutionPassword,
          note: resolutionNote.trim(),
        }),
      });
      const data = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        const message = response.status === 401
          ? "كلمة مرور المالك غير صحيحة"
          : response.status === 409
            ? "هذه الوردية لم تعد معلقة أو تمت تسويتها مسبقاً"
            : data?.error ?? "تعذر تسوية الوردية";
        throw new Error(message);
      }
      closeResolution();
      await Promise.all([loadOpenShifts(), loadShifts()]);
    } catch (resolutionFailure) {
      setResolutionError(resolutionFailure instanceof Error ? resolutionFailure.message : "تعذر تسوية الوردية");
    } finally {
      setResolving(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const openCount = openShifts.filter((shift) => shift.status === "OPEN").length;
  const staleCount = openShifts.length - openCount;
  const resolutionActualValue = Number(resolutionActualCash);
  const resolutionVariance = resolutionTarget && resolutionActualCash.trim() && Number.isFinite(resolutionActualValue)
    ? resolutionActualValue - resolutionTarget.expectedCashInDrawer
    : null;

  const groups = useMemo(() => {
    const map = new Map<string, ShiftAudit[]>();
    for (const shift of shifts) {
      const key = shift.date || "بدون تاريخ";
      const list = map.get(key) ?? [];
      list.push(shift);
      map.set(key, list);
    }
    return Array.from(map.entries()).map(([date, list]) => ({ date, shifts: list }));
  }, [shifts]);

  return (
    <>
      <div className="no-print space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-black text-foreground">تدقيق الورديات وتقفيل الصندوق</h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            خط زمني لتسليم الورديات مع التفاوت المالي لكل صندوق، وبحث وتحليل على كامل النطاق
          </p>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          className="flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-black text-foreground transition hover:bg-surface-muted"
        >
          <RefreshCw className={`h-4 w-4 ${loading || openLoading ? "animate-spin" : ""}`} />
          تحديث
        </button>
      </header>

      {printNotice && (
        <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold shadow-lg ${printNotice.tone === "success" ? "bg-success text-success-foreground" : "bg-destructive text-destructive-foreground"}`}>
          {printNotice.message}
        </div>
      )}

      {canViewX && (
        <section className="border-y border-border bg-surface px-4 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-base font-black text-foreground">
                <Clock3 className="h-4 w-4 text-primary" />
                حالة الورديات • تقرير X
              </h2>
              <p className="mt-0.5 text-xs font-semibold text-muted">لقطة تشغيلية من الدفتر الحالي دون إغلاق الصندوق</p>
            </div>
            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-black text-primary">
              {openLoading ? "جارٍ التحديث" : `${openCount} مفتوحة${staleCount ? ` • ${staleCount} معلقة` : ""}`}
            </span>
          </div>
          {openError ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive">{openError}</p>
          ) : openLoading ? (
            <p className="py-5 text-center text-sm font-semibold text-muted">جارٍ إعداد تقارير X…</p>
          ) : openShifts.length === 0 ? (
            <p className="py-4 text-center text-sm font-semibold text-muted">لا توجد ورديات مفتوحة على أي جهاز</p>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {openShifts.map((shift) => (
                <article key={shift.shiftId} className={`rounded-lg border px-4 py-3 ${shift.status === "STALE" ? "border-amber-300 bg-amber-50/60" : "border-border bg-surface-muted/40"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-black text-foreground">{shift.cashier || "—"}</span>
                    <span className={`rounded-md px-2 py-0.5 text-[11px] font-black ${shift.status === "STALE" ? "bg-amber-100 text-amber-800" : "bg-success/10 text-success"}`}>
                      {shift.status === "STALE" ? "معلقة" : "مفتوحة"}
                    </span>
                    <span className="text-xs font-bold text-muted">
                      منذ {Math.floor(shift.ageMinutes / 60)}س {shift.ageMinutes % 60}د
                    </span>
                    <span className="ms-auto text-xs font-bold text-muted">
                      {shift.branch || "—"}{shift.terminal ? ` • ${shift.terminal}` : ""}
                    </span>
                  </div>
                  {shift.status === "STALE" && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-bold text-amber-800">افتتاح قديم بلا تقرير Z مقابل؛ يحتاج مراجعة المدير قبل اعتباره وردية نشطة.</p>
                      {adminSession && (
                        <button
                          type="button"
                          onClick={() => {
                            setResolutionTarget(shift);
                            setResolutionActualCash("");
                            setResolutionPassword("");
                            setResolutionNote("");
                            setResolutionError("");
                          }}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-xs font-black text-white hover:bg-amber-700"
                        >
                          <ShieldCheck className="h-4 w-4" />
                          تسوية إدارية
                        </button>
                      )}
                    </div>
                  )}
                  <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 text-xs sm:grid-cols-6">
                    <div><p className="font-bold text-muted">الفواتير</p><p className="font-black tabular-nums">{shift.invoiceCount}</p></div>
                    <div><p className="font-bold text-muted">المبيعات</p><p className="font-black tabular-nums">{formatMoney(shift.totalSales)}</p></div>
                    <div><p className="font-bold text-muted">النقد</p><p className="font-black tabular-nums text-success">{formatMoney(shift.cashSales)}</p></div>
                    <div><p className="font-bold text-muted">بطاقة + كليك</p><p className="font-black tabular-nums text-primary">{formatMoney(shift.visaSales + shift.cliqSales)}</p></div>
                    <div><p className="font-bold text-muted">المصروفات</p><p className="font-black tabular-nums text-amber-600">{formatMoney(shift.expenses)}</p></div>
                    <div><p className="font-bold text-muted">متوقع الصندوق</p><p className="font-black tabular-nums">{formatMoney(shift.expectedCashInDrawer)}</p></div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-border bg-surface p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_repeat(4,minmax(0,190px))]">
          <SearchInput
            value={q}
            onChange={(value) => {
              setQ(value);
              setPage(1);
            }}
            placeholder="ابحث باسم الكاشير…"
          />
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-muted">من</span>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-muted">إلى</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-muted">الفرع</span>
            <select
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            >
              <option value="">كل الفروع</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-muted">الطرفية</span>
            <select
              value={terminalId}
              onChange={(e) => {
                setTerminalId(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            >
              <option value="">كل الطرفيات</option>
              {terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>
                  {terminal.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {summary && (
        <>
          <section className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-4">
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <History className="h-3.5 w-3.5" /> ورديات مغلقة
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums">{summary.shiftCount}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-xs font-bold text-muted">إجمالي المبيعات</p>
              <p className="mt-1 text-2xl font-black tabular-nums">{formatMoney(summary.totalSales)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <Banknote className="h-3.5 w-3.5" /> نقداً
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-success">{formatMoney(summary.cash)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <CreditCard className="h-3.5 w-3.5" /> بطاقة
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-primary">{formatMoney(summary.visa)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <Send className="h-3.5 w-3.5" /> كليك
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-primary">{formatMoney(summary.cliq)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <ReceiptText className="h-3.5 w-3.5" /> مبيعات ذمم
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-muted">{formatMoney(summary.debt)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <TicketPercent className="h-3.5 w-3.5" /> خصومات
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-amber-600">{formatMoney(summary.discounts)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <RotateCcw className="h-3.5 w-3.5" /> مرتجعات
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-destructive">{formatMoney(summary.returns)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <Wallet className="h-3.5 w-3.5" /> مصروفات
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-amber-600">{formatMoney(summary.expenses)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-xs font-bold text-muted">تفاوت الصندوق</p>
              <p
                className={`mt-1 text-2xl font-black tabular-nums ${
                  summary.variance > 0
                    ? "text-success"
                    : summary.variance < 0
                      ? "text-destructive"
                      : "text-muted"
                }`}
              >
                {formatMoney(summary.variance)}
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <CreditCard className="h-3.5 w-3.5" /> بطاقة — فرق
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-primary">{formatMoney(summary.cardVariance)}</p>
              <p className="text-xs text-muted tabular-nums">متوقع {formatMoney(summary.expectedCard)} • فعلي {formatMoney(summary.actualCard)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <Send className="h-3.5 w-3.5" /> كليك — فرق
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-primary">{formatMoney(summary.cliqVariance)}</p>
              <p className="text-xs text-muted tabular-nums">متوقع {formatMoney(summary.expectedCliq)} • فعلي {formatMoney(summary.actualCliq)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1 text-xs font-bold text-muted">
                <Wallet className="h-3.5 w-3.5" /> سحب/إيداع الصندوق
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums">{formatMoney(summary.cashIn - summary.cashOut)}</p>
              <p className="text-xs text-muted tabular-nums">إيداع {formatMoney(summary.cashIn)} • سحب {formatMoney(summary.cashOut)}</p>
            </div>
          </section>

          {summary.topCashiers.length > 0 && (
            <section className="rounded-2xl border border-border bg-surface p-4">
              <h2 className="mb-3 text-sm font-black text-foreground">أكثر الكاشيرات تسليماً للورديات</h2>
              <div className="flex flex-wrap gap-2">
                {summary.topCashiers.map((entry) => (
                  <span
                    key={entry.name}
                    className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface-muted px-3 py-2 text-xs font-bold"
                  >
                    <span className="text-foreground">{entry.name}</span>
                    <span className="rounded-full bg-slate-900/5 px-2 py-0.5 tabular-nums text-muted">
                      {entry.count} وردية
                    </span>
                    <span className="tabular-nums text-primary">{formatMoney(entry.totalSales)}</span>
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">{error}</p>}

      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-black text-foreground">
            <CalendarDays className="h-4 w-4" />
            الخط الزمني للورديات
          </h2>
        </div>
        {loading ? (
          <p className="px-5 py-8 text-center text-sm font-semibold text-muted">جارٍ تحميل الورديات…</p>
        ) : groups.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm font-semibold text-muted">
            لا توجد ورديات ضمن النطاق المحدد
          </p>
        ) : (
          <div className="space-y-5 p-5">
            {groups.map((group) => (
              <div key={group.date} className="rounded-xl border border-border bg-surface-muted/40">
                <div className="border-b border-border/60 px-4 py-2.5 text-sm font-black text-foreground">
                  {group.date}
                  <span className="ms-2 text-xs font-bold text-muted">({group.shifts.length} وردية)</span>
                </div>
                <div className="space-y-0">
                  {group.shifts.map((shift, index) => {
                    const isLast = index === group.shifts.length - 1;
                    const nextCashier = !isLast ? group.shifts[index + 1].cashier : "";
                    return (
                        <div
                          key={shift.id}
                          className="relative cursor-pointer ps-8"
                          onClick={() => { setSelectedShift(shift); setIsDetailOpen(true); }}
                        >
                        {!isLast && (
                          <span
                            aria-hidden
                            className="absolute bottom-0 start-[15px] top-0 w-px bg-border"
                          />
                        )}
                        <span
                          aria-hidden
                          className={`absolute start-2.5 top-5 h-2.5 w-2.5 rounded-full ring-4 ${
                            shift.variance > 0
                              ? "bg-success ring-success/15"
                              : shift.variance < 0
                                ? "bg-destructive ring-destructive/15"
                                : "bg-slate-400 ring-slate-200/50"
                          }`}
                        />
                        <div className="flex flex-col gap-3 border-b border-border/50 px-4 py-4 last:border-b-0">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <span className="text-base font-black text-foreground">{shift.cashier || "—"}</span>
                            <span className="inline-flex items-center gap-1 rounded-lg bg-surface px-2.5 py-1 text-xs font-bold tabular-nums text-muted">
                              {formatShiftTime(shift.openedAt)} ← {formatShiftTime(shift.closedAt)}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-lg bg-surface px-2.5 py-1 text-xs font-bold text-muted">
                              <Store className="h-3.5 w-3.5" />
                              {shift.branch || "—"}
                              {shift.terminal ? ` • ${shift.terminal}` : ""}
                            </span>
                            <span className="ms-auto">
                              <VarianceBadge variance={shift.variance} />
                            </span>
                            {shift.closeSource === "ADMIN_RECOVERY" && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-800">
                                <ShieldCheck className="h-3.5 w-3.5" /> تسوية إدارية
                              </span>
                            )}
                            {shift.approvalStatus === "APPROVED" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-black text-success">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                معتمد{shift.approvedByName ? ` • ${shift.approvedByName}` : ""}
                              </span>
                            ) : shift.approvalStatus === "PENDING" ? (
                              adminSession ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setApprovalTarget(shift);
                                    setApprovalPassword("");
                                    setApprovalNote("");
                                    setApprovalError("");
                                  }}
                                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-amber-500 px-3 text-xs font-black text-white transition hover:bg-amber-600"
                                >
                                  <TriangleAlert className="h-3.5 w-3.5" />
                                  اعتماد الفرق
                                </button>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-800">
                                  <TriangleAlert className="h-3.5 w-3.5" /> بانتظار المالك
                                </span>
                              )
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-black text-muted">
                                <CheckCircle2 className="h-3.5 w-3.5" /> لا يحتاج اعتماداً
                              </span>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 xl:grid-cols-10">
                            <div className="rounded-lg bg-surface px-2.5 py-2">
                              <p className="font-bold text-muted">العهدة</p>
                              <p className="mt-0.5 font-black tabular-nums">{formatMoney(shift.startingCash)}</p>
                            </div>
                            <div className="rounded-lg bg-surface px-2.5 py-2">
                              <p className="font-bold text-muted">نقداً</p>
                              <p className="mt-0.5 font-black tabular-nums text-success">{formatMoney(shift.cashSales)}</p>
                            </div>
                            <div className="rounded-lg bg-surface px-2.5 py-2">
                              <p className="font-bold text-muted">بطاقة</p>
                              <p className="mt-0.5 font-black tabular-nums text-primary">{formatMoney(shift.visaSales)}</p>
                            </div>
                            <div className="rounded-lg bg-surface px-2.5 py-2">
                              <p className="font-bold text-muted">كليك</p>
                              <p className="mt-0.5 font-black tabular-nums text-primary">{formatMoney(shift.cliqSales)}</p>
                            </div>
                            <div className="rounded-lg bg-surface px-2.5 py-2">
                              <p className="font-bold text-muted">خصومات</p>
                              <p className="mt-0.5 font-black tabular-nums text-amber-600">{formatMoney(shift.discounts)}</p>
                            </div>
                            <div className="rounded-lg bg-surface px-2.5 py-2">
                              <p className="font-bold text-muted">مرتجعات</p>
                              <p className="mt-0.5 font-black tabular-nums text-destructive">{formatMoney(shift.returns)}</p>
                            </div>
                            <div className="rounded-lg bg-surface px-2.5 py-2">
                              <p className="font-bold text-muted">مصروفات</p>
                              <p className="mt-0.5 font-black tabular-nums text-amber-600">{formatMoney(shift.expenses)}</p>
                            </div>
                            <div className="rounded-lg bg-surface px-2.5 py-2">
                              <p className="font-bold text-muted">الإجمالي</p>
                              <p className="mt-0.5 font-black tabular-nums">{formatMoney(shift.totalSales)}</p>
                            </div>
                            <div className={`rounded-lg px-2.5 py-2 ${shift.cardVariance !== 0 ? "bg-primary/5 border border-primary/20" : "bg-surface"}`}>
                              <p className="font-bold text-muted">فرق البطاقة</p>
                              <p className={`mt-0.5 font-black tabular-nums ${shift.cardVariance === 0 ? "text-muted" : shift.cardVariance > 0 ? "text-success" : "text-destructive"}`}>{formatMoney(shift.cardVariance)}</p>
                            </div>
                            <div className={`rounded-lg px-2.5 py-2 ${shift.cliqVariance !== 0 ? "bg-primary/5 border border-primary/20" : "bg-surface"}`}>
                              <p className="font-bold text-muted">فرق كليك</p>
                              <p className={`mt-0.5 font-black tabular-nums ${shift.cliqVariance === 0 ? "text-muted" : shift.cliqVariance > 0 ? "text-success" : "text-destructive"}`}>{formatMoney(shift.cliqVariance)}</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-bold text-muted">
                            <span>
                              متوقع الصندوق: <span className="tabular-nums">{formatMoney(shift.expectedCashInDrawer)}</span>
                            </span>
                            <span>
                              الفعلي: <span className="tabular-nums">{formatMoney(shift.actualCash)}</span>
                            </span>
                            <span>
                              فرق البطاقة: <span className={`tabular-nums ${shift.cardVariance === 0 ? "" : shift.cardVariance > 0 ? "text-success" : "text-destructive"}`}>{formatMoney(shift.cardVariance)}</span>
                            </span>
                            <span>
                              فرق كليك: <span className={`tabular-nums ${shift.cliqVariance === 0 ? "" : shift.cliqVariance > 0 ? "text-success" : "text-destructive"}`}>{formatMoney(shift.cliqVariance)}</span>
                            </span>
                            {shift.drawerOpenCount > 0 && (
                              <span className="text-amber-600">
                                فتح الصندوق: {shift.drawerOpenCount} مرة
                              </span>
                            )}
                            {shift.cashIn > 0 || shift.cashOut > 0 ? (
                              <span>
                                إيداع: <span className="tabular-nums text-success">{formatMoney(shift.cashIn)}</span> • سحب: <span className="tabular-nums text-destructive">{formatMoney(shift.cashOut)}</span>
                              </span>
                            ) : null}
                            <span>
                              التفاوت = الفعلي − (العهدة + النقد + تحصيل الذمم − المصروفات)
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setSelectedShift(shift); setIsDetailOpen(true); }}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-black text-foreground transition hover:bg-surface-muted"
                            >
                              <ReceiptText className="h-3.5 w-3.5" />
                              التفاصيل
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handlePrint(shift, "a4"); }}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-black text-foreground transition hover:bg-surface-muted"
                            >
                              <Printer className="h-3.5 w-3.5" />
                              طباعة A4
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handlePrint(shift, "thermal"); }}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-black text-foreground transition hover:bg-surface-muted"
                            >
                              <Printer className="h-3.5 w-3.5" />
                              طباعة حرارية
                            </button>
                          </div>
                          {!isLast && nextCashier && (
                            <p className="flex items-center gap-1.5 text-xs font-black text-primary">
                              ← تسليم الوردية إلى: {nextCashier}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        <ListPagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </section>

      {resolutionTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" dir="rtl">
          <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="flex items-center gap-2 text-base font-black">
                  <ShieldCheck className="h-5 w-5 text-amber-600" /> تسوية وردية معلقة
                </h2>
                <p className="mt-1 text-xs font-bold text-muted">
                  {resolutionTarget.cashier || "—"} • {resolutionTarget.branch || "—"}{resolutionTarget.terminal ? ` • ${resolutionTarget.terminal}` : ""}
                </p>
              </div>
              <button type="button" aria-label="إغلاق" onClick={closeResolution} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-muted">
                <X className="h-5 w-5" />
              </button>
            </header>
            <div className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-3 gap-2 rounded-lg bg-surface-muted p-3 text-sm">
                <div><p className="text-xs font-bold text-muted">الفواتير</p><p className="font-black tabular-nums">{resolutionTarget.invoiceCount}</p></div>
                <div><p className="text-xs font-bold text-muted">المبيعات</p><p className="font-black tabular-nums">{formatMoney(resolutionTarget.totalSales)}</p></div>
                <div><p className="text-xs font-bold text-muted">المتوقع</p><p className="font-black tabular-nums">{formatMoney(resolutionTarget.expectedCashInDrawer)}</p></div>
              </div>
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                سيعيد الخادم حساب تقرير Z من دفاتر البيع والمصروفات. أدخل النقد الذي عُد فعلياً، لا الرقم المتوقع أعلاه.
              </p>
              <label className="block text-sm font-bold">
                النقد الفعلي المعدود
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  inputMode="decimal"
                  value={resolutionActualCash}
                  onChange={(event) => setResolutionActualCash(event.target.value)}
                  autoFocus
                  placeholder="0.000"
                  className="mt-1.5 h-12 w-full rounded-lg border border-border px-3 text-lg font-black tabular-nums outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                <span className="font-bold text-muted">الفرق المتوقع قبل التأكيد</span>
                <span className={`font-black tabular-nums ${resolutionVariance === null || resolutionVariance === 0 ? "text-foreground" : resolutionVariance < 0 ? "text-destructive" : "text-success"}`}>
                  {resolutionVariance === null ? "—" : formatMoney(resolutionVariance)}
                </span>
              </div>
              <label className="block text-sm font-bold">
                سبب التسوية ونتيجة المراجعة
                <textarea
                  value={resolutionNote}
                  onChange={(event) => setResolutionNote(event.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="مثال: انقطع الجهاز بعد نهاية الوردية وتمت مطابقة النقد مع سجل الصندوق"
                  className="mt-1.5 w-full resize-none rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
              <label className="block text-sm font-bold">
                كلمة مرور مالك المتجر
                <input
                  type="password"
                  value={resolutionPassword}
                  onChange={(event) => setResolutionPassword(event.target.value)}
                  autoComplete="current-password"
                  className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
              {resolutionError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive">{resolutionError}</p>}
            </div>
            <footer className="flex gap-2 border-t border-border px-5 py-4">
              <button
                type="button"
                onClick={() => void resolveStaleShift()}
                disabled={resolving || !resolutionActualCash.trim() || !Number.isFinite(resolutionActualValue) || resolutionActualValue < 0 || !resolutionPassword || resolutionNote.trim().length < 3}
                className="h-11 flex-1 rounded-lg bg-amber-600 text-sm font-black text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {resolving ? "جارٍ إنشاء تقرير Z…" : "تسوية وإغلاق الوردية"}
              </button>
              <button type="button" onClick={closeResolution} className="h-11 rounded-lg border border-border px-4 text-sm font-black">إلغاء</button>
            </footer>
          </div>
        </div>
      )}

      {approvalTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" dir="rtl">
          <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="flex items-center gap-2 text-base font-black">
                  <LockKeyhole className="h-5 w-5 text-amber-600" /> اعتماد فرق الصندوق
                </h2>
                <p className="mt-1 text-xs font-bold text-muted">وردية {approvalTarget.cashier || "—"} • فرق {formatMoney(approvalTarget.variance)}</p>
              </div>
              <button type="button" aria-label="إغلاق" onClick={() => { setApprovalTarget(null); setApprovalPassword(""); setApprovalNote(""); }} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-muted">
                <X className="h-5 w-5" />
              </button>
            </header>
            <div className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-surface-muted p-3 text-sm">
                <div><p className="text-xs font-bold text-muted">المتوقع</p><p className="font-black tabular-nums">{formatMoney(approvalTarget.expectedCashInDrawer)}</p></div>
                <div><p className="text-xs font-bold text-muted">الفعلي</p><p className="font-black tabular-nums">{formatMoney(approvalTarget.actualCash)}</p></div>
              </div>
              <label className="block text-sm font-bold">
                سبب الاعتماد أو نتيجة المراجعة
                <textarea
                  value={approvalNote}
                  onChange={(event) => setApprovalNote(event.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="مثال: تمت مراجعة سند الصرف والعد اليدوي"
                  className="mt-1.5 w-full resize-none rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
              <label className="block text-sm font-bold">
                كلمة مرور مالك المتجر
                <input
                  type="password"
                  value={approvalPassword}
                  onChange={(event) => setApprovalPassword(event.target.value)}
                  autoComplete="current-password"
                  className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
              {approvalError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive">{approvalError}</p>}
            </div>
            <footer className="flex gap-2 border-t border-border px-5 py-4">
              <button
                type="button"
                onClick={() => void approveVariance()}
                disabled={approving || !approvalPassword || approvalNote.trim().length < 3}
                className="h-11 flex-1 rounded-lg bg-amber-500 text-sm font-black text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {approving ? "جارٍ الاعتماد…" : "اعتماد وتسجيل المراجعة"}
              </button>
              <button type="button" onClick={() => { setApprovalTarget(null); setApprovalPassword(""); setApprovalNote(""); }} className="h-11 rounded-lg border border-border px-4 text-sm font-black">إلغاء</button>
            </footer>
          </div>
        </div>
      )}

      <ShiftDetailModal
        shift={selectedShift}
        open={isDetailOpen}
        onClose={() => { setIsDetailOpen(false); setSelectedShift(null); }}
      />
      </div>
      {printTarget && printMode === "thermal" && <ThermalShiftPrintView shift={printTarget} />}
      {printTarget && printMode === "a4" && <ShiftPrintView shift={printTarget} />}
    </>
  );
}
