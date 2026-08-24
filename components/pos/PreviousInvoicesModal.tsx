"use client";

import { useEffect, useState } from "react";
import { Ban, ReceiptText, RefreshCw, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { findReturnedOriginals, listInvoices, type SyncQueueRecord } from "@/lib/idb";
import { getTenantStoreId } from "@/lib/tenantClient";
import { formatMoney } from "@/lib/format";
import { useModalEscape } from "@/hooks/useModalEscape";

interface InvoiceRow {
  syncId: string;
  total: number;
  paymentMethod: string;
  completedAt: string;
  synced: boolean;
  voided: boolean;
  isReversal: boolean;
}

const METHOD_LABELS: Record<string, string> = {
  CASH: "نقدي",
  VISA: "كارت",
  CLIQ: "كليك",
  SPLIT: "مقسم",
  DEBT: "ذمم",
};

function toRow(r: SyncQueueRecord): InvoiceRow {
  const p = r.payload as {
    total?: number;
    paymentMethod?: string;
    completed_at?: string;
    originalInvoiceId?: string;
  };
  return {
    syncId: r.sync_id,
    total: Number(p?.total) || 0,
    paymentMethod: (p?.paymentMethod as string) ?? "CASH",
    completedAt: p?.completed_at ?? r.created_at,
    synced: r.status === "SYNCED",
    voided: Boolean(p?.originalInvoiceId),
    isReversal: Boolean(p?.originalInvoiceId),
  };
}

/**
 * Previous invoices screen for Admin Mode. Lists every locally settled
 * invoice (newest first); the owner can void a completed invoice, which
 * enqueues a reversing document (negated items + totals, originalInvoiceId
 * reference) that restores stock on the next sync. Voiding goes through the
 * secondary-auth password gate.
 */
export default function PreviousInvoicesModal() {
  const isOpen = usePosStore((s) => s.isPreviousInvoicesModalOpen);
  const close = usePosStore((s) => s.closePreviousInvoicesModal);
  const requestSecondaryAuth = usePosStore((s) => s.requestSecondaryAuth);
  const pendingSyncCount = usePosStore((s) => s.pendingSyncCount);

  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRows = async (): Promise<InvoiceRow[]> => {
    const records = await listInvoices(getTenantStoreId());
    // MEM-1: one readonly transaction resolves every void status, replacing
    // the per-row IndexedDB lookups (a whole-queue scan per row pre-v10).
    let returnedIds = new Set<string>();
    try {
      returnedIds = await findReturnedOriginals(records.map((r) => r.sync_id));
    } catch {
      // Same degradation as the old per-row catch: surface the list with
      // "not returned" rather than blocking it.
    }
    return records.map((r) => {
      const base = toRow(r);
      if (base.isReversal) return base;
      base.voided = returnedIds.has(r.sync_id);
      return base;
    });
  };

  const refresh = async () => {
    setLoading(true);
    try {
      setRows(await loadRows());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    loadRows().then((resolved) => {
      if (!cancelled) setRows(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, pendingSyncCount]);

  useModalEscape(close, isOpen);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[8vh]"
      dir="rtl"
      onClick={close}
    >
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-slate-900 text-sky-400">
              <ReceiptText className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-black">الفواتير السابقة</h2>
              <p className="text-xs font-semibold text-muted">
                إلغاء فاتورة مكتملة يعكسها تلقائياً عند المزامنة
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="تحديث"
              onClick={() => void refresh()}
              className="grid h-10 w-10 cursor-pointer place-items-center rounded-xl text-muted transition hover:bg-surface-muted"
            >
              <RefreshCw className={`h-5 w-5 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              aria-label="إغلاق"
              onClick={close}
              className="grid h-10 w-10 cursor-pointer place-items-center rounded-xl text-muted transition hover:bg-surface-muted"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="max-h-[60vh] min-h-[160px] overflow-y-auto scrollbar-hidden">
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
              <ReceiptText className="h-10 w-10 text-slate-300" />
              <p className="text-sm font-bold text-muted">
                {loading ? "جارٍ التحميل…" : "لا توجد فواتير محلية بعد"}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.syncId} className="flex items-center gap-3 px-6 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-black">
                      فاتورة # {r.syncId.slice(0, 8)}
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-black ${
                          r.voided
                            ? "bg-rose-100 text-rose-600"
                            : r.synced
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {r.voided ? "مُلغاة" : r.synced ? "متزامنة" : "بانتظار المزامنة"}
                      </span>
                    </p>
                    <p className="text-xs font-semibold text-muted">
                      {new Date(r.completedAt).toLocaleString("ar-EG")} •{" "}
                      {METHOD_LABELS[r.paymentMethod] ?? r.paymentMethod}
                    </p>
                  </div>
                  <p
                    className={`text-base font-black tabular-nums ${
                      r.total < 0 ? "text-destructive" : ""
                    }`}
                  >
                    {formatMoney(r.total)}
                  </p>
                  {r.isReversal ? (
                    <span className="w-24 text-center text-xs font-black text-muted">
                      إرجاع/إلغاء
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={r.voided}
                      onClick={() =>
                        requestSecondaryAuth({
                          type: "cancel_invoice",
                          syncId: r.syncId,
                          label: `فاتورة # ${r.syncId.slice(0, 8)}`,
                        })
                      }
                      className={`flex w-24 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-black transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        r.voided
                          ? "bg-surface-muted text-muted"
                          : "bg-rose-50 text-rose-600 hover:bg-rose-100"
                      }`}
                    >
                      <Ban className="h-3.5 w-3.5" />
                      إلغاء
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-border px-6 py-4">
          <p className="text-xs font-semibold text-muted">
            الإلغاء يتطلب كلمة مرور المدير ويظهر في التقارير كمرتجع
          </p>
        </footer>
      </div>
    </div>
  );
}
