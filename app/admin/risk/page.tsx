"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertOctagon,
  BadgeAlert,
  Banknote,
  CheckCircle2,
  RefreshCw,
  Search,
  ShieldAlert,
  UserRoundSearch,
  X,
} from "lucide-react";
import { ListPagination } from "@/components/admin/ListPagination";
import { formatMoney } from "@/lib/format";
import { hasCapability } from "@/lib/permissions";
import { posFetch } from "@/lib/tenantClient";
import { usePosStore } from "@/store/usePosStore";
import type { RiskEvent, RiskResponse, RiskSeverity, RiskStatus } from "@/types/risk.types";

const EVENT_LABELS: Record<string, string> = {
  SHIFT_VARIANCE: "فرق صندوق",
  STALE_SHIFT: "وردية معلقة تمت تسويتها",
  INVOICE_RETURN: "مرتجع",
  INVOICE_VOID: "إلغاء فاتورة",
  HIGH_DISCOUNT: "خصم مرتفع",
  OPEN_DRAWER: "فتح درج يدوي",
  PRICE_OVERRIDE: "تعديل سعر",
  RETURN_MODE: "تفعيل المرتجع",
  FAILED_APPROVAL: "محاولة اعتماد فاشلة",
};

const SEVERITY_LABELS: Record<RiskSeverity, string> = {
  LOW: "منخفضة",
  MEDIUM: "متوسطة",
  HIGH: "عالية",
  CRITICAL: "حرجة",
};

const STATUS_LABELS: Record<RiskStatus, string> = {
  OPEN: "تحتاج مراجعة",
  REVIEWED: "تمت المراجعة",
  DISMISSED: "مستبعدة",
  ESCALATED: "مصعّدة",
};

const severityClass: Record<RiskSeverity, string> = {
  LOW: "bg-slate-100 text-slate-700",
  MEDIUM: "bg-amber-100 text-amber-800",
  HIGH: "bg-orange-100 text-orange-800",
  CRITICAL: "bg-rose-100 text-rose-800",
};

function defaultFrom(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}

function emptyResponse(): RiskResponse {
  return {
    events: [], total: 0, page: 1, pageSize: 30, truncated: false,
    summary: { total: 0, open: 0, escalated: 0, highAndCritical: 0, critical: 0, amountAtRisk: 0, averageScore: 0, topActors: [] },
  };
}

export default function RiskPage() {
  const adminSession = usePosStore((state) => state.adminSession);
  const currentCashier = usePosStore((state) => state.currentCashier);
  const canReview = Boolean(hasCapability(currentCashier, "risk.review"));
  const [data, setData] = useState<RiskResponse>(emptyResponse);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [reviewTarget, setReviewTarget] = useState<RiskEvent | null>(null);
  const [reviewStatus, setReviewStatus] = useState<RiskStatus>("REVIEWED");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ from, to, page: String(page), pageSize: String(pageSize) });
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    if (severity) params.set("severity", severity);
    try {
      const response = await posFetch(`/api/risk?${params.toString()}`, { cache: "no-store" });
      const next = response.ok ? await response.json() as RiskResponse : null;
      if (!next || !Array.isArray(next.events)) throw new Error("risk_load_failed");
      setData(next);
      setPage(next.page);
      setError("");
    } catch {
      setData(emptyResponse());
      setError("تعذر تحميل سجل المخاطر — تحقق من الاتصال والصلاحيات");
    } finally {
      setLoading(false);
    }
  }, [from, page, pageSize, q, severity, status, to]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const submitReview = async () => {
    if (!reviewTarget || reviewing || reviewNote.trim().length < 3) return;
    setReviewing(true);
    setReviewError("");
    try {
      const response = await posFetch("/api/risk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-pos-role": "admin" },
        body: JSON.stringify({ id: reviewTarget.id, status: reviewStatus, note: reviewNote.trim() }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "تعذر حفظ المراجعة");
      setReviewTarget(null);
      setReviewNote("");
      await load();
    } catch (reviewFailure) {
      setReviewError(reviewFailure instanceof Error ? reviewFailure.message : "تعذر حفظ المراجعة");
    } finally {
      setReviewing(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black text-foreground">
            <ShieldAlert className="h-6 w-6 text-rose-600" /> الرقابة ومكافحة الاحتيال
          </h1>
          <p className="mt-1 text-sm font-semibold text-muted">إشارات مبنية من الدفتر الفعلي حسب الموظف والوردية والجهاز</p>
        </div>
        <button type="button" onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black hover:bg-surface-muted">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> تحديث
        </button>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="border-r-4 border-rose-500 bg-white px-4 py-3 shadow-sm"><p className="flex items-center gap-1 text-xs font-bold text-muted"><AlertOctagon className="h-4 w-4" /> مفتوحة</p><p className="mt-1 text-2xl font-black tabular-nums">{data.summary.open}</p></div>
        <div className="border-r-4 border-orange-500 bg-white px-4 py-3 shadow-sm"><p className="flex items-center gap-1 text-xs font-bold text-muted"><BadgeAlert className="h-4 w-4" /> عالية وحرجة</p><p className="mt-1 text-2xl font-black tabular-nums">{data.summary.highAndCritical}</p></div>
        <div className="border-r-4 border-amber-500 bg-white px-4 py-3 shadow-sm"><p className="flex items-center gap-1 text-xs font-bold text-muted"><Banknote className="h-4 w-4" /> قيمة مرتبطة</p><p className="mt-1 text-2xl font-black tabular-nums">{formatMoney(data.summary.amountAtRisk)}</p></div>
        <div className="border-r-4 border-slate-700 bg-white px-4 py-3 shadow-sm"><p className="flex items-center gap-1 text-xs font-bold text-muted"><UserRoundSearch className="h-4 w-4" /> متوسط الخطر</p><p className="mt-1 text-2xl font-black tabular-nums">{data.summary.averageScore}/100</p></div>
      </section>

      <section className="grid gap-3 border-y border-border bg-white px-4 py-3 md:grid-cols-3 xl:grid-cols-[minmax(190px,1fr)_repeat(4,minmax(0,150px))]">
        <label className="relative block">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder="اسم الموظف…" className="h-10 w-full rounded-lg border border-border pr-9 pl-3 text-sm font-bold outline-none focus:border-primary" />
        </label>
        <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="h-10 rounded-lg border border-border px-3 text-sm font-bold"><option value="">كل الحالات</option><option value="OPEN">تحتاج مراجعة</option><option value="ESCALATED">مصعّدة</option><option value="REVIEWED">تمت المراجعة</option><option value="DISMISSED">مستبعدة</option></select>
        <select value={severity} onChange={(event) => { setSeverity(event.target.value); setPage(1); }} className="h-10 rounded-lg border border-border px-3 text-sm font-bold"><option value="">كل الدرجات</option><option value="CRITICAL">حرجة</option><option value="HIGH">عالية</option><option value="MEDIUM">متوسطة</option><option value="LOW">منخفضة</option></select>
        <input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="h-10 rounded-lg border border-border px-2 text-sm font-bold" />
        <input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="h-10 rounded-lg border border-border px-2 text-sm font-bold" />
      </section>

      {data.summary.topActors.length > 0 && (
        <section className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-black text-muted">الأعلى خطراً:</span>
          {data.summary.topActors.map((actor) => <span key={actor.name} className="rounded-full border border-border bg-white px-3 py-1.5 font-bold">{actor.name} • {actor.count} • {actor.averageScore}/100</span>)}
        </section>
      )}

      {error && <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">{error}</p>}

      {data.truncated && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-800">
          تنبيه: النتائج مقتطعة — أكثر من {data.total.toLocaleString("ar-JO")} حدث. عدّل الفلتر لتضييق النطاق.
        </div>
      )}

      <section className="overflow-hidden border border-border bg-white shadow-sm">
        <div className="grid grid-cols-[minmax(150px,1.5fr)_minmax(120px,1fr)_120px_150px] gap-3 border-b border-border bg-surface-muted px-4 py-2.5 text-xs font-black text-muted">
          <span>الإشارة</span><span>الموظف والموقع</span><span>الخطر والقيمة</span><span>الحالة والإجراء</span>
        </div>
        {loading ? (
          <p className="py-10 text-center text-sm font-bold text-muted">جارٍ تحليل الإشارات…</p>
        ) : data.events.length === 0 ? (
          <p className="py-10 text-center text-sm font-bold text-muted">لا توجد إشارات ضمن المرشحات الحالية</p>
        ) : (
          <div className="divide-y divide-border">
            {data.events.map((event) => (
              <article key={event.id} className="grid grid-cols-[minmax(150px,1.5fr)_minmax(120px,1fr)_120px_150px] items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0"><p className="truncate font-black">{EVENT_LABELS[event.eventType] ?? event.eventType}</p><p className="mt-0.5 text-xs font-semibold text-muted">{new Date(event.occurredAt).toLocaleString("ar-JO")}</p></div>
                <div className="min-w-0"><p className="truncate font-bold">{event.actorName || "غير معروف"}</p><p className="truncate text-xs text-muted">{event.shiftId ? `وردية ${event.shiftId.slice(0, 8)}` : "دون وردية"}</p></div>
                <div><span className={`inline-block rounded-md px-2 py-1 text-xs font-black ${severityClass[event.severity]}`}>{SEVERITY_LABELS[event.severity]} • {event.score}</span><p className="mt-1 text-xs font-black tabular-nums">{event.amount ? formatMoney(event.amount) : "—"}</p></div>
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-black text-muted">{STATUS_LABELS[event.status]}</span>{canReview ? <button type="button" onClick={() => { setReviewTarget(event); setReviewStatus(event.status === "ESCALATED" ? "ESCALATED" : "REVIEWED"); setReviewNote(""); setReviewError(""); }} className="h-8 rounded-lg border border-border px-3 text-xs font-black hover:bg-surface-muted">مراجعة</button> : <span className="text-xs font-bold text-muted">قراءة فقط</span>}</div>
              </article>
            ))}
          </div>
        )}
        <ListPagination page={page} totalPages={totalPages} total={data.total} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
      </section>

      {reviewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" dir="rtl">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="text-base font-black">مراجعة إشارة</h2><p className="text-xs font-bold text-muted">{EVENT_LABELS[reviewTarget.eventType] ?? reviewTarget.eventType} • {reviewTarget.actorName || "غير معروف"}</p></div><button type="button" aria-label="إغلاق" onClick={() => { setReviewTarget(null); setReviewNote(""); }} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-surface-muted"><X className="h-5 w-5" /></button></header>
            <div className="space-y-4 px-5 py-4">
              <label className="block text-sm font-bold">القرار<select value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as RiskStatus)} className="mt-1.5 h-11 w-full rounded-lg border border-border px-3"><option value="REVIEWED">تمت المراجعة</option><option value="DISMISSED">استبعاد الإشارة</option><option value="ESCALATED">تصعيد للتحقيق</option></select></label>
              <label className="block text-sm font-bold">نتيجة المراجعة<textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={500} rows={4} placeholder="ما الذي تمت مراجعته وما النتيجة؟" className="mt-1.5 w-full resize-none rounded-lg border border-border px-3 py-2 outline-none focus:border-primary" /></label>
              {reviewError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive">{reviewError}</p>}
            </div>
            <footer className="flex gap-2 border-t border-border px-5 py-4"><button type="button" onClick={() => void submitReview()} disabled={reviewing || reviewNote.trim().length < 3} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-slate-900 text-sm font-black text-white disabled:opacity-40"><CheckCircle2 className="h-4 w-4" />{reviewing ? "جارٍ الحفظ…" : "حفظ نتيجة المراجعة"}</button><button type="button" onClick={() => { setReviewTarget(null); setReviewNote(""); }} className="h-11 rounded-lg border border-border px-4 text-sm font-black">إلغاء</button></footer>
          </div>
        </div>
      )}
    </div>
  );
}
