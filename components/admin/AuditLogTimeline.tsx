"use client";

import { useEffect, useState } from "react";
import { Ban, Banknote, FileText, HandCoins, History, PackageSearch, RefreshCw, RotateCcw, ScrollText, ShieldCheck, Tag, UserCog, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { posFetch } from "@/lib/tenantClient";
import { STORE_HEADER } from "@/lib/tenant";
import { formatMoney } from "@/lib/format";
import type { AuditEntry } from "@/lib/audit";

const ACTION_META: Record<
  string,
  { label: string; icon: typeof Tag; badge: string; iconCls: string }
> = {
  OVERRIDE_PRICE: { label: "تعديل سعر صنف", icon: Tag, badge: "bg-sky-50 text-sky-600", iconCls: "bg-sky-100 text-sky-600" },
  CANCEL_INVOICE: { label: "إلغاء فاتورة", icon: Ban, badge: "bg-rose-50 text-rose-600", iconCls: "bg-rose-100 text-rose-600" },
  OPEN_DRAWER: { label: "فتح الدرج النقدي", icon: Banknote, badge: "bg-emerald-50 text-emerald-600", iconCls: "bg-emerald-100 text-emerald-600" },
  SAVE_CASHIER: { label: "حفظ موظف", icon: UserCog, badge: "bg-violet-50 text-violet-600", iconCls: "bg-violet-100 text-violet-600" },
  DELETE_CASHIER: { label: "حذف موظف", icon: UserCog, badge: "bg-amber-50 text-amber-600", iconCls: "bg-amber-100 text-amber-600" },
  ENTER_RETURN_MODE: { label: "تفعيل وضع المرتجع", icon: RotateCcw, badge: "bg-orange-50 text-orange-600", iconCls: "bg-orange-100 text-orange-600" },
  ADJUST_STOCK: { label: "تسوية مخزون", icon: PackageSearch, badge: "bg-indigo-50 text-indigo-600", iconCls: "bg-indigo-100 text-indigo-600" },
  CREATE_SUPPLIER_INVOICE: { label: "تسجيل فاتورة مورد", icon: FileText, badge: "bg-blue-50 text-blue-700", iconCls: "bg-blue-100 text-blue-700" },
  RECORD_SUPPLIER_PAYMENT: { label: "تسجيل دفعة مورد", icon: HandCoins, badge: "bg-emerald-50 text-emerald-700", iconCls: "bg-emerald-100 text-emerald-700" },
  SHIFT_VARIANCE: { label: "فرق صندوق وردية", icon: Banknote, badge: "bg-rose-50 text-rose-700", iconCls: "bg-rose-100 text-rose-700" },
  SHIFT_VARIANCE_APPROVED: { label: "اعتماد فرق الصندوق", icon: ShieldCheck, badge: "bg-emerald-50 text-emerald-700", iconCls: "bg-emerald-100 text-emerald-700" },
  SHIFT_STALE_RESOLVED: { label: "تسوية وردية معلقة", icon: ShieldCheck, badge: "bg-amber-50 text-amber-700", iconCls: "bg-amber-100 text-amber-700" },
  REVIEW_RISK_EVENT: { label: "مراجعة إشارة مخاطر", icon: ShieldCheck, badge: "bg-slate-100 text-slate-700", iconCls: "bg-slate-200 text-slate-700" },
};

const DETAIL_LABELS: Record<string, string> = {
  productName: "الصنف",
  from: "من السعر",
  to: "إلى السعر",
  qty: "الكمية",
  total: "الإجمالي",
  items: "عدد الأصناف",
  customerName: "الزبون",
  branchId: "الفرع",
  terminalId: "الكاشير",
  cashierId: "معرّف الكاشير",
  cashierName: "الكاشير",
  name: "الاسم",
  role: "الدور",
  supplierId: "المورد",
  invoiceNumber: "رقم فاتورة المورد",
  totalAmount: "إجمالي الفاتورة",
  taxAmount: "ضريبة المدخلات",
  amount: "قيمة الدفعة",
  method: "طريقة الدفع",
  balanceDue: "الرصيد المتبقي",
  expectedCash: "النقد المتوقع",
  actualCash: "النقد الفعلي",
  variance: "فرق الصندوق",
  note: "ملاحظة المراجعة",
  riskScore: "درجة الخطر",
  status: "الحالة",
  eventType: "نوع الإشارة",
};

const MONEY_KEYS = new Set(["from", "to", "total", "totalAmount", "taxAmount", "amount", "balanceDue", "expectedCash", "actualCash", "variance"]);

function formatValue(key: string, value: unknown): string {
  if (MONEY_KEYS.has(key) && typeof value === "number") return formatMoney(value);
  return String(value);
}

async function fetchAuditEntries(email?: string | null, storeId?: string | null): Promise<AuditEntry[]> {
  if (!email) return [];
  const headers = new Headers({ "x-pos-admin-email": email });
  if (storeId) headers.set(STORE_HEADER, storeId);
  const res = await posFetch("/api/admin/audit", {
    headers,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `audit ${res.status}`);
  }
  const data = (await res.json()) as { entries: AuditEntry[] };
  return data.entries ?? [];
}

/**
 * P3 — Admin Audit Log timeline (سجل الرقابة).
 *
 * Read-only chronological record of every sensitive intervention executed
 * from Admin Mode: price overrides, invoice cancellations, manual drawer
 * opens and cashier roster changes. Pulls the append-only server ledger
 * (newest first) through /api/admin/audit; the acting admin is resolved
 * server-side so the timeline can never be forged with a fake identity.
 */
export default function AuditLogTimeline() {
  const isOpen = usePosStore((s) => s.isAuditLogOpen);
  const close = usePosStore((s) => s.closeAuditLogModal);
  const adminSession = usePosStore((s) => s.adminSession);
  const currentStore = usePosStore((s) => s.currentStore);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const storeId = adminSession?.storeId ?? currentStore?.id ?? null;

  const refresh = () => {
    setLoading(true);
    setError("");
    fetchAuditEntries(adminSession?.email, storeId)
      .then((resolved) => {
        setEntries(resolved);
        setError("");
      })
      .catch((err) => {
        setEntries([]);
        setError(err instanceof Error ? err.message : "تعذّر جلب السجل");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      fetchAuditEntries(adminSession?.email, storeId)
        .then((resolved) => {
          if (!cancelled) {
            setEntries(resolved);
            setError("");
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setEntries([]);
            setError(err instanceof Error ? err.message : "تعذّر جلب السجل");
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, adminSession?.email, storeId]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[8vh]"
      dir="rtl"
      onClick={close}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-slate-900 text-sky-400">
              <ScrollText className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-black">سجل الرقابة</h2>
              <p className="text-xs font-semibold text-muted">
                كل تدخل حساس في وضع المدير — سجل دائم لا يُعدَّل
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

        <div className="max-h-[60vh] min-h-[200px] overflow-y-auto scrollbar-hidden px-6 py-4">
          {error ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <History className="h-10 w-10 text-slate-300" />
              <p className="text-sm font-bold text-muted">
                تعذّر جلب السجل — {error}
              </p>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <History className="h-10 w-10 text-slate-300" />
              <p className="text-sm font-bold text-muted">
                {loading ? "جارٍ التحميل…" : "لا توجد تدخلات مسجلة بعد"}
              </p>
            </div>
          ) : (
            <ol className="relative space-y-1 border-r-2 border-slate-100 pr-5">
              {entries.map((entry) => {
                const meta = ACTION_META[entry.action_type] ?? {
                  label: entry.action_type,
                  icon: History,
                  badge: "bg-slate-50 text-slate-600",
                  iconCls: "bg-slate-100 text-slate-600",
                };
                const Icon = meta.icon;
                const details = Object.entries(entry.details ?? {}).filter(
                  ([, v]) => v !== undefined && v !== null && v !== "",
                );
                return (
                  <li key={entry.id} className="relative pb-5">
                    <span
                      className={`absolute -right-[27px] top-1 grid h-7 w-7 place-items-center rounded-full ring-4 ring-white ${meta.iconCls}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="rounded-2xl border border-border bg-surface-muted/40 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-black">{meta.label}</p>
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-black ${meta.badge}`}>
                          {new Date(entry.created_at).toLocaleString("ar-EG")}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs font-bold text-muted">
                        {entry.admin_name || entry.admin_id || "مدير"}
                      </p>
                      {entry.target_id && (
                        <p className="mt-1 text-[11px] font-semibold text-muted">
                          الهدف: <span className="font-black text-slate-700" dir="ltr">{entry.target_id}</span>
                        </p>
                      )}
                      {details.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {details.map(([key, value]) => (
                            <span
                              key={key}
                              className="rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm"
                            >
                              {DETAIL_LABELS[key] ?? key}:{" "}
                              <span className="font-black">{formatValue(key, value)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-border px-6 py-4">
          <p className="text-xs font-semibold text-muted">
            السجل محمي ضد التعديل — لا يمكن حذف أو تعديل أي تدخل
          </p>
        </footer>
      </div>
    </div>
  );
}
