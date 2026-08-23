"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { Loader2, Minus, PanelsTopLeft, Plus, Printer, Search, Send, Trash2 } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { setTenantStoreId } from "@/lib/tenantClient";
import { generateLabels } from "@/lib/printClient";
import { normalizeArabicText } from "@/lib/arabic";
import { enqueueLabelPrint } from "@/lib/idb";
import BarcodeLabel from "@/components/print/BarcodeLabel";
import { useDefaultPrintTemplate } from "@/hooks/useDefaultPrintTemplate";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePosStore } from "@/store/usePosStore";

interface LabelVariant {
  barcode: string;
  unitName: string;
  multiplier: number;
  price: number;
}

interface LabelProduct {
  id: string;
  name: string;
  variants: LabelVariant[];
}

interface LabelJob {
  key: string;
  name: string;
  barcode: string;
  price: number;
  unitName: string;
  count: number;
}

const LABEL_SEARCH_LIMIT = 50;

const freshKey = (): string =>
  "job-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const genBarcode = (): string =>
  "L" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();

/**
 * Search the label catalog via generateLabels (direct Supabase read of the
 * store's products with their active barcodes), applying the Arabic-normalized
 * text filter and limit on the client.
 */
async function fetchLabelProducts(q: string, limit: number): Promise<{ products: LabelProduct[]; total: number }> {
  const catalog = await generateLabels();
  const needle = normalizeArabicText(q.trim());
  const barcodeNeedle = q.trim().toLowerCase();
  const matches =
    needle || barcodeNeedle
      ? catalog.filter(
          (product) =>
            normalizeArabicText(product.name).includes(needle) ||
            product.variants.some((variant) => variant.barcode.toLowerCase().includes(barcodeNeedle)),
        )
      : catalog;
  return { products: matches.slice(0, limit), total: matches.length };
}

export default function AdminBarcodesPage() {
  const currentStore = usePosStore((state) => state.currentStore);
  const labelTemplate = useDefaultPrintTemplate("BARCODE_LABEL", currentStore?.id);
  const [products, setProducts] = useState<LabelProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [jobs, setJobs] = useState<LabelJob[]>([]);
  const [sendState, setSendState] = useState<"idle" | "sending" | "done">("idle");
  const [sendError, setSendError] = useState<string | null>(null);

  // Custom sticker form.
  const [customName, setCustomName] = useState("");
  const [customBarcode, setCustomBarcode] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customCount, setCustomCount] = useState(1);

  const debouncedQuery = useDebouncedValue(query, 300);

  useEffect(() => {
    let cancelled = false;
    fetchLabelProducts(debouncedQuery, LABEL_SEARCH_LIMIT)
      .then((data) => {
        if (cancelled) return;
        setError(null);
        setProducts(data.products);
        setTotal(data.total);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "فشل التحميل");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const addVariant = (product: LabelProduct, variant: LabelVariant) => {
    setSendState("idle");
    setSendError(null);
    setJobs((prev) => [
      ...prev,
      {
        key: freshKey(),
        name: product.name,
        barcode: variant.barcode,
        price: variant.price,
        unitName: variant.unitName,
        count: 1,
      },
    ]);
  };

  const addCustom = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const price = parseFloat(customPrice);
    const count = Math.max(1, Math.floor(customCount) || 1);
    if (!customName.trim()) {
      setError("أدخل اسم الصنف");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setError("أدخل سعراً صحيحاً");
      return;
    }
    setError(null);
    setSendState("idle");
    setSendError(null);
    setJobs((prev) => [
      ...prev,
      {
        key: freshKey(),
        name: customName.trim(),
        barcode: customBarcode.trim() || genBarcode(),
        price,
        unitName: "حبة",
        count,
      },
    ]);
    setCustomName("");
    setCustomBarcode("");
    setCustomPrice("");
    setCustomCount(1);
  };

  const setJobCount = (key: string, count: number) => {
    setSendState("idle");
    setSendError(null);
    setJobs((prev) =>
      prev.map((j) => (j.key === key ? { ...j, count: Math.max(1, Math.floor(count) || 1) } : j)),
    );
  };

  const removeJob = (key: string) => {
    setSendState("idle");
    setSendError(null);
    setJobs((prev) => prev.filter((j) => j.key !== key));
  };

  /** Queue every label in the sheet to the /print-server kiosk queue. */
  const sendToKiosk = async () => {
    if (jobs.length === 0 || sendState === "sending") return;
    setSendState("sending");
    setSendError(null);
    try {
      if (currentStore?.id) setTenantStoreId(currentStore.id);
      for (const job of jobs) {
        await enqueueLabelPrint({
          barcode: job.barcode,
          name: job.name,
          unitName: job.unitName,
          price: job.price,
          quantity: job.count,
          templateSize: { widthMm: labelTemplate.widthMm, heightMm: labelTemplate.heightMm },
        });
      }
      setSendState("done");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "تعذر إرسال أوامر الطباعة");
      setSendState("idle");
    }
  };

  const sheet = useMemo(
    () => jobs.flatMap((j) => Array.from({ length: j.count }, () => j)),
    [jobs],
  );
  const totalLabels = sheet.length;

  return (
    <div className="space-y-6" dir="rtl">
      {/* Print page size must match the label pitch exactly, otherwise the
          printer feeds a full A4/Letter sheet per label (blank-label overrun)
          and browser margins shift the barcode off the sticker. */}
      <style>{`
        @media print {
          @page {
            size: ${labelTemplate.widthMm}mm ${labelTemplate.heightMm}mm;
            margin: 0;
          }
        }
      `}</style>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-foreground">ملصقات الباركود</h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            توليد وطباعة ملصقات باركود للمنتجات أو أصناف مخصصة
          </p>
        </div>
        <div className="flex items-center gap-2">
        <Link href="/admin/print-studio" className="flex h-12 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black text-primary"><PanelsTopLeft className="h-4 w-4" />تصميم الملصق</Link>
        <button
          type="button"
          disabled={jobs.length === 0 || sendState === "sending"}
          onClick={() => void sendToKiosk()}
          className="flex h-12 items-center gap-2 rounded-xl border border-primary/40 bg-white px-4 text-sm font-black text-primary transition hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send className="h-5 w-5" />
          {sendState === "sending" ? "جارٍ الإرسال…" : sendState === "done" ? "أُرسلت لطابعة الملصقات" : "إرسال لطابعة الملصقات"}
        </button>
        <button
          type="button"
          disabled={jobs.length === 0}
          onClick={() => window.print()}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-base font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Printer className="h-5 w-5" />
          طباعة {totalLabels > 0 ? `(${totalLabels} ملصق)` : ""}
        </button>
        </div>
      </header>

      {error && (
        <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">
          {error}
        </p>
      )}
      {sendError && (
        <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">
          {sendError}
        </p>
      )}
      {sendState === "done" && (
        <p className="rounded-xl bg-green-500/10 px-4 py-3 text-sm font-bold text-green-600">
          أُرسلت {totalLabels} ملصق لقائمة انتظار طابعة الملصقات — افتح صفحة الطابعة على جهاز الملصقات.
        </p>
      )}

      <section className="grid gap-6 lg:grid-cols-2">
        {/* Product picker */}
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h2 className="mb-3 text-base font-black">من الكتالوج</h2>
          <div className="mb-3 flex items-center gap-2 rounded-xl bg-surface-muted px-3 py-2 focus-within:ring-2 focus-within:ring-primary/30">
            <Search className="h-4 w-4 shrink-0 text-muted" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLoading(true);
                setError(null);
              }}
              placeholder="ابحث بالاسم أو الباركود..."
              autoComplete="off"
              className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="scrollbar-hidden max-h-80 space-y-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm font-semibold text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                جارٍ التحميل...
              </div>
            ) : products.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">لا توجد نتائج</p>
            ) : (
              <>
                {!debouncedQuery && total > products.length && (
                  <p className="px-1 pb-1 text-xs font-semibold text-muted">
                    يعرض أول {products.length} من أصل {total} — اكتب في البحث للوصول لباقي الأصناف
                  </p>
                )}
                {products.map((p) => (
                <div key={p.id} className="rounded-xl border border-border px-3 py-2.5">
                  <p className="text-sm font-bold">{p.name}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.variants.map((v) => (
                      <button
                        key={v.barcode}
                        type="button"
                        onClick={() => addVariant(p, v)}
                        className="flex items-center gap-1.5 rounded-lg bg-surface-muted px-2.5 py-1 text-xs font-bold text-muted transition hover:bg-primary hover:text-primary-foreground"
                      >
                        <Plus className="h-3 w-3" />
                        {v.unitName} • {formatMoney(v.price)}
                        <span className="tabular-nums text-muted-foreground">{v.barcode}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              </>
            )}
          </div>
        </div>

        {/* Custom sticker + job list */}
        <div className="space-y-4">
          <form onSubmit={addCustom} className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <h2 className="mb-3 text-base font-black">صنف مخصص</h2>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="اسم الصنف *"
                className="col-span-2 rounded-xl border border-border bg-white px-3 py-2 text-sm font-medium outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
              <input
                value={customBarcode}
                onChange={(e) => setCustomBarcode(e.target.value)}
                placeholder="الباركود (يُولّد تلقائياً إن تُرك فارغاً)"
                dir="ltr"
                className="rounded-xl border border-border bg-white px-3 py-2 text-left text-sm font-medium tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  value={customPrice}
                  onChange={(e) => setCustomPrice(e.target.value)}
                  placeholder="السعر *"
                  dir="ltr"
                  className="rounded-xl border border-border bg-white px-3 py-2 text-left text-sm font-medium tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={customCount}
                  onChange={(e) => setCustomCount(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                  dir="ltr"
                  className="rounded-xl border border-border bg-white px-3 py-2 text-left text-sm font-medium tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
            <button
              type="submit"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white transition hover:bg-slate-700"
            >
              <Plus className="h-4 w-4" />
              إضافة الملصقات
            </button>
          </form>

          <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <h2 className="mb-3 text-base font-black">
              قائمة الطباعة <span className="text-muted-foreground">({jobs.length} صنف / {totalLabels} ملصق)</span>
            </h2>
            <div className="scrollbar-hidden max-h-80 space-y-2 overflow-y-auto">
              {jobs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  اختر منتجات أو أضف أصنافاً مخصصة لتبدأ
                </p>
              ) : (
                jobs.map((j) => (
                  <div key={j.key} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{j.name}</p>
                      <p className="truncate text-xs text-muted tabular-nums">
                        {j.unitName} • {formatMoney(j.price)} • {j.barcode}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label="إنقاص العدد"
                        onClick={() => setJobCount(j.key, j.count - 1)}
                        className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-surface-muted"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-8 text-center text-base font-bold tabular-nums">{j.count}</span>
                      <button
                        type="button"
                        aria-label="زيادة العدد"
                        onClick={() => setJobCount(j.key, j.count + 1)}
                        className="grid h-8 w-8 place-items-center rounded-lg border border-border text-primary transition hover:bg-surface-muted"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label={`حذف ${j.name}`}
                      onClick={() => removeJob(j.key)}
                      className="grid h-8 w-8 place-items-center rounded-lg text-destructive transition hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Live preview — the same sheet that prints. */}
      <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <h2 className="mb-3 text-base font-black">معاينة الملصقات</h2>
        {totalLabels === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            أضف أصنافاً لعرض الملصقات هنا
          </p>
        ) : (
          <div id="barcode-sheet" className="flex flex-wrap" style={{ gap: `${labelTemplate.gapMm}mm`, "--barcode-label-gap": `${labelTemplate.gapMm}mm` } as CSSProperties}>
            {sheet.map((j, i) => (
              <BarcodeLabel key={`${j.key}-${i}`} data={j} config={labelTemplate} storeName={currentStore?.name ?? ""} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
