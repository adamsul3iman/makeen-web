"use client";

import { useEffect, useState } from "react";
import { Gem, Loader2, Minus, Phone, Plus, Search, User } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { fetchLoyaltyCustomers, fetchLoyaltyEvents, earnLoyaltyPoints, redeemLoyaltyPoints, adjustLoyaltyPoints, type LoyaltyCustomer, type LoyaltyEvent, type LoyaltyConfig } from "@/lib/loyaltyClient";

const EVENT_LABEL: Record<string, string> = {
  EARN: "كسب",
  REDEEM: "استبدال",
  ADJUST: "تعديل",
};

/**
 * Smart marketing / loyalty. Reads are store-scoped (x-pos-store-id); all
 * write actions (earn / redeem / adjust) require the admin cashier role like
 * the other back-office routes. When offline or in mock mode the page shows
 * an empty ledger instead of inventing numbers.
 */
export default function AdminLoyaltyPage() {
  const [customers, setCustomers] = useState<LoyaltyCustomer[]>([]);
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<LoyaltyCustomer | null>(null);
  const [events, setEvents] = useState<LoyaltyEvent[]>([]);
  const [amount, setAmount] = useState("");
  const [pointsInput, setPointsInput] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const load = async (search = "") => {
    try {
      const list = await fetchLoyaltyCustomers(search || undefined);
      setCustomers(list);
    } catch (err) {
      setCustomers([]);
      setStatus({ tone: "error", message: err instanceof Error ? err.message : "تعذر التحميل" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchLoyaltyCustomers()
      .then((list) => {
        if (!cancelled) setCustomers(list);
      })
      .catch(() => {
        if (!cancelled) setStatus({ tone: "error", message: "تعذر التحميل" });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = () => {
    setLoading(true);
    void load(q);
  };

  const selectCustomer = async (customer: LoyaltyCustomer) => {
    setSelected(customer);
    setEvents([]);
    setStatus(null);
    try {
      const evts = await fetchLoyaltyEvents(customer.id);
      setEvents(evts);
    } catch {
      /* keep the selected row; events stay empty */
    }
  };

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setStatus(null);
    try {
      const action = body.action as string;
      const customerId = body.customer_id as string;
      if (action === "earn") {
        await earnLoyaltyPoints(customerId, { amount: body.amount as number, reference: body.reference as string, note: (body.note as string) || undefined });
      } else if (action === "redeem") {
        await redeemLoyaltyPoints(customerId, { points: body.points as number, note: (body.note as string) || undefined });
      } else if (action === "adjust") {
        await adjustLoyaltyPoints(customerId, { points: body.points as number, note: (body.note as string) || undefined });
      }
      await load(q);
      if (selected) await selectCustomer(selected);
      setAmount("");
      setPointsInput("");
      setNote("");
      setStatus({ tone: "success", message: "تم الحفظ بنجاح" });
    } catch (err) {
      setStatus({ tone: "error", message: err instanceof Error ? err.message : "فشل الإجراء" });
    } finally {
      setBusy(false);
    }
  };

  const pointsValue = (p: number) => {
    const rate = config?.pointValue ?? 0.01;
    return Math.round((p * rate + Number.EPSILON) * 100) / 100;
  };

  const pointsPerSpend = config?.pointsPerSpend ?? 1;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-black text-foreground">
          <Gem className="h-6 w-6 text-primary" />
          نقاط الولاء
        </h1>
        <p className="mt-1 text-sm font-semibold text-muted">
          {config?.enabled === false
            ? "البرنامج معطّل — فعّله من إعدادات المتجر."
            : `يكسب الزبون نقطة لكل ${pointsPerSpend.toFixed(2)} من المدفوع، وقيمة النقطة ${formatMoney(pointsValue(1))}.`}
        </p>
      </header>

      {status && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm font-bold ${
            status.tone === "success" ? "border-success/40 bg-success/10 text-success" : "border-destructive/40 bg-destructive/10 text-destructive"
          }`}
        >
          {status.message}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
            <User className="h-4 w-4 text-primary" />
            العملاء
          </h2>
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-surface-muted px-3 py-2">
            <Search className="h-4 w-4 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch();
              }}
              placeholder="بحث بالاسم أو رقم الهاتف..."
              className="w-full bg-transparent text-sm font-bold text-foreground outline-none"
            />
            <button
              type="button"
              onClick={runSearch}
              className="rounded-lg bg-primary px-3 py-1 text-xs font-black text-primary-foreground"
            >
              بحث
            </button>
          </div>
          <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
            {loading && (
              <li className="flex items-center justify-center gap-2 py-6 text-sm font-bold text-muted">
                <Loader2 className="h-5 w-5 animate-spin" />
                جارٍ التحميل…
              </li>
            )}
            {!loading && customers.length === 0 && (
              <li className="py-6 text-center text-sm font-semibold text-muted">لا يوجد عملاء بعد</li>
            )}
            {customers.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => void selectCustomer(c)}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm font-bold transition hover:bg-surface-muted ${
                    selected?.id === c.id ? "border-primary bg-primary/10" : "border-border"
                  }`}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="flex shrink-0 items-center gap-2 text-muted">
                    {c.phone && (
                      <span className="flex items-center gap-1 text-xs" dir="ltr">
                        <Phone className="h-3 w-3" />
                        {c.phone}
                      </span>
                    )}
                    <span className="rounded-lg bg-primary/10 px-2 py-0.5 text-xs font-black text-primary tabular-nums">
                      {c.loyalty_points ?? 0} نقطة
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="text-sm font-black text-foreground">
            {selected ? selected.name : "اختر زبوناً لعرض رصيده"}
          </h2>
          {selected && (
            <div className="mt-4 space-y-4">
              <div className="rounded-xl bg-surface-muted px-4 py-3">
                <p className="text-sm font-semibold text-muted">الرصيد الحالي</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="text-3xl font-black tabular-nums text-primary">
                    {selected.loyalty_points ?? 0}
                  </span>
                  <span className="text-sm font-bold text-muted">نقطة</span>
                  <span className="text-sm font-bold text-muted">
                    ≈ {formatMoney(pointsValue(selected.loyalty_points ?? 0))}
                  </span>
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="block text-xs font-bold text-muted">
                  كسب — مبلغ الفاتورة
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      inputMode="decimal"
                      dir="ltr"
                      placeholder="0.00"
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm font-bold outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void post({ action: "earn", customer_id: selected.id, amount: parseFloat(amount) || 0, reference: `manual:${Date.now()}`, note })}
                      className="flex items-center gap-1 rounded-xl bg-success px-3 py-2 text-sm font-black text-success-foreground disabled:opacity-40"
                    >
                      <Plus className="h-4 w-4" /> كسب
                    </button>
                  </div>
                </label>

                <label className="block text-xs font-bold text-muted">
                  استبدال — عدد النقاط
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={pointsInput}
                      onChange={(e) => setPointsInput(e.target.value)}
                      inputMode="numeric"
                      dir="ltr"
                      placeholder="0"
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm font-bold outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void post({ action: "redeem", customer_id: selected.id, points: parseInt(pointsInput, 10) || 0, note })}
                      className="flex items-center gap-1 rounded-xl bg-primary px-3 py-2 text-sm font-black text-primary-foreground disabled:opacity-40"
                    >
                      <Minus className="h-4 w-4" /> صرف
                    </button>
                  </div>
                </label>
              </div>

              <label className="block text-xs font-bold text-muted">
                ملاحظة (اختياري)
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="مثال: خصم نقاط على عملية شراء"
                  className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm font-bold outline-none focus:border-primary"
                />
              </label>

              <div>
                <p className="text-xs font-black text-muted">سجل النقاط</p>
                <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {events.length === 0 && (
                    <li className="py-3 text-center text-sm font-semibold text-muted">لا توجد حركات بعد</li>
                  )}
                  {events.map((e) => (
                    <li key={e.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                      <span>
                        <span className={`font-black ${e.points > 0 ? "text-success" : "text-destructive"}`}>
                          {e.points > 0 ? "+" : ""}
                          {e.points}
                        </span>
                        <span className="mx-2 font-bold text-muted">{EVENT_LABEL[e.type] ?? e.type}</span>
                        <span className="text-xs font-semibold text-muted">{e.description}</span>
                      </span>
                      <span className="text-xs font-bold text-muted tabular-nums">
                        {new Date(e.created_at).toLocaleDateString("ar-EG")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {!selected && (
            <p className="mt-4 text-sm font-semibold text-muted">
              من قائمة العملاء على اليمين، ثم كسب أو استبدال النقاط. يُخصم الاستبدال من رصيد ذمم الزبون بقيمة النقطة المحددة في
              الإعدادات.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
