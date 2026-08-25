"use client";

import { useMemo, useState } from "react";
import {
  Barcode,
  Check,
  Copy,
  Lock,
  Printer,
  RefreshCw,
  ScanLine,
  Tag,
  X,
  Zap,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { hasCapability } from "@/lib/permissions";
import { getTenantStoreId } from "@/lib/tenantClient";
import { quickUpdateProductPrice } from "@/lib/catalogProducts";
import { runManualSync } from "@/hooks/useBackgroundSync";
import { useDeviceHardware } from "@/hooks/useDeviceHardware";
import { formatMoney } from "@/lib/format";
import { useModalEscape } from "@/hooks/useModalEscape";
import type { LocalProduct } from "@/types/pos.types";

interface ScanMatch {
  barcode: string;
  productName: string;
  variantLabel: string;
  unitName?: string;
  qtyMultiplier?: number;
  price: number;
  totalStock?: number;
}

/**
 * "ليونة" quick-actions drawer (Phase 3): a side sheet with the four fast
 * tools a cashier/store-owner needs without leaving the register lane —
 * quick price update, manual sync trigger, printer/hardware settings, and a
 * barcode probe. Pure UI over existing clients/hooks; it never mutates cart
 * or shift state.
 */
export default function QuickActionsDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const products = usePosStore((s) => s.products);
  const barcodeIndex = usePosStore((s) => s.barcodeIndex);
  const currentCashier = usePosStore((s) => s.currentCashier);
  const adminSession = usePosStore((s) => s.adminSession);
  const activeTerminalId = usePosStore((s) => s.activeTerminalId);
  const isOnline = usePosStore((s) => s.isOnline);
  const pendingSyncCount = usePosStore((s) => s.pendingSyncCount);

  const { settings: hardware, updateSettings } = useDeviceHardware(activeTerminalId);

  const canManageCatalog = Boolean(
    adminSession || hasCapability(currentCashier, "catalog.manage"),
  );

  // ── Quick price update ──
  const [priceQuery, setPriceQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<LocalProduct | null>(null);
  const [priceInput, setPriceInput] = useState("");
  const [savingPrice, setSavingPrice] = useState(false);
  const [priceFeedback, setPriceFeedback] = useState<
    { tone: "success" | "error"; message: string } | null
  >(null);

  const priceMatches = useMemo(() => {
    const q = priceQuery.trim().toLowerCase();
    if (!q || selectedProduct || !canManageCatalog) return [];
    return Object.values(products)
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [canManageCatalog, priceQuery, products, selectedProduct]);

  const handleSavePrice = async () => {
    if (!selectedProduct || savingPrice) return;
    const next = Number(priceInput);
    const storeId = getTenantStoreId();
    if (!storeId || !Number.isFinite(next) || next <= 0) {
      setPriceFeedback({ tone: "error", message: "أدخل سعراً صالحاً أكبر من صفر" });
      return;
    }
    setSavingPrice(true);
    setPriceFeedback(null);
    const result = await quickUpdateProductPrice(storeId, selectedProduct.id, next);
    setSavingPrice(false);
    if (result.ok) {
      setPriceFeedback({
        tone: "success",
        message: `تم تحديث سعر «${selectedProduct.name}» إلى ${formatMoney(next)}`,
      });
      setSelectedProduct(null);
      setPriceInput("");
      setPriceQuery("");
    } else {
      setPriceFeedback({
        tone: "error",
        message:
          result.error === "offline"
            ? "لا يوجد اتصال — تحديث الأسعار يتطلب الشبكة"
            : result.error === "سعر غير صالح"
              ? "أدخل سعراً صالحاً أكبر من صفر"
              : // quickUpdateProductPrice guarantees user-safe Arabic reasons.
                result.error || "تعذر تحديث السعر — حاول مجدداً",
      });
    }
  };

  // ── Manual sync ──
  const [syncing, setSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  const handleManualSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncFeedback(null);
    const result = await runManualSync();
    setSyncing(false);
    setSyncFeedback(
      result.ok
        ? `اكتملت المزامنة — ${result.pending} حركة بانتظار الإرسال`
        : "تعذر إكمال المزامنة — تحقق من الاتصال",
    );
  };

  // ── Barcode probe ──
  const [scanInput, setScanInput] = useState("");
  const [scanMatch, setScanMatch] = useState<ScanMatch | null>(null);
  const [scanMissing, setScanMissing] = useState(false);
  const [copied, setCopied] = useState(false);

  const resolveScan = () => {
    const code = scanInput.trim();
    setCopied(false);
    if (!code) return;
    const hit = barcodeIndex[code];
    if (!hit) {
      setScanMatch(null);
      setScanMissing(true);
      return;
    }
    setScanMissing(false);
    setScanMatch({
      barcode: code,
      productName: hit.name,
      variantLabel: hit.variantLabel,
      unitName: hit.unitName,
      qtyMultiplier: hit.qtyMultiplier,
      price: hit.price,
      totalStock: products[hit.product_id]?.totalStock,
    });
  };

  const copyScannedBarcode = async () => {
    if (!scanMatch) return;
    try {
      await navigator.clipboard.writeText(scanMatch.barcode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  };

  useModalEscape(onClose, open);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40" dir="rtl" onClick={onClose}>
      <aside
        className="absolute inset-y-0 end-0 flex w-full max-w-md flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="الإجراءات السريعة"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10">
              <Zap className="h-5 w-5 text-primary" />
            </span>
            <div>
              <h2 className="text-base font-black leading-tight">ليونة</h2>
              <p className="text-[11px] font-semibold text-muted">إجراءات سريعة بلا مغادرة الكاشير</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-lg text-muted transition hover:bg-surface-muted hover:text-foreground focus-visible:focus-ring"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-0 overflow-y-auto scrollbar-hidden">
          {/* ── Quick price update ── */}
          <section className="border-b border-border px-4 py-4">
            <h3 className="flex items-center gap-2 text-sm font-black text-foreground">
              <Tag className="h-4 w-4 text-primary" />
              تحديث سعر سريع
            </h3>
            {canManageCatalog ? (
              <div className="mt-2 space-y-2">
                {selectedProduct ? (
                  <div className="rounded-xl border border-border bg-surface-muted/60 px-3 py-2.5">
                    <p className="truncate text-sm font-bold">{selectedProduct.name}</p>
                    <p className="text-xs font-semibold text-muted">
                      السعر الحالي: {formatMoney(selectedProduct.price)}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        inputMode="decimal"
                        value={priceInput}
                        onChange={(e) => setPriceInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleSavePrice();
                          }
                        }}
                        placeholder="السعر الجديد"
                        autoFocus
                        className="h-10 min-w-0 flex-1 rounded-lg border border-border px-3 text-sm font-black tabular-nums outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSavePrice()}
                        disabled={savingPrice || !priceInput.trim()}
                        className="flex h-10 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {savingPrice ? (
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        حفظ
                      </button>
                      <button
                        type="button"
                        aria-label="إلغاء الاختيار"
                        onClick={() => {
                          setSelectedProduct(null);
                          setPriceInput("");
                        }}
                        className="grid h-10 w-10 place-items-center rounded-lg text-muted transition hover:bg-surface-muted hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <input
                    value={priceQuery}
                    onChange={(e) => setPriceQuery(e.target.value)}
                    placeholder="ابحث باسم المنتج…"
                    className="h-10 w-full rounded-lg border border-border px-3 text-sm font-bold outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                )}
                {!selectedProduct && priceMatches.length > 0 && (
                  <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border">
                    {priceMatches.map((product) => (
                      <li key={product.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedProduct(product);
                            setPriceInput(String(product.price ?? ""));
                            setPriceQuery("");
                          }}
                          className="flex w-full items-center justify-between gap-2 bg-white px-3 py-2 text-start transition hover:bg-surface-muted"
                        >
                          <span className="truncate text-sm font-bold">{product.name}</span>
                          <span className="shrink-0 text-xs font-black tabular-nums text-primary">
                            {formatMoney(product.price)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {!selectedProduct && priceQuery.trim() && priceMatches.length === 0 && (
                  <p className="text-xs font-semibold text-muted">لا نتائج مطابقة</p>
                )}
                {priceFeedback && (
                  <p
                    className={`rounded-lg px-3 py-2 text-xs font-bold ${
                      priceFeedback.tone === "success"
                        ? "bg-success/10 text-success"
                        : "bg-destructive/10 text-destructive"
                    }`}
                  >
                    {priceFeedback.message}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-2 flex items-center gap-2 rounded-lg bg-surface-muted px-3 py-2 text-xs font-semibold text-muted">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                تحديث الأسعار متاح لجلسة المدير فقط
              </p>
            )}
          </section>

          {/* ── Manual sync ── */}
          <section className="border-b border-border px-4 py-4">
            <h3 className="flex items-center gap-2 text-sm font-black text-foreground">
              <RefreshCw className={`h-4 w-4 text-primary ${syncing ? "animate-spin" : ""}`} />
              مزامنة فورية
            </h3>
            <p className="mt-1 text-xs font-semibold text-muted">
              {isOnline
                ? `${pendingSyncCount} حركة بانتظار الإرسال`
                : "الجهاز دون اتصال — سيُجرى الإرسال عند عودة الشبكة"}
            </p>
            <button
              type="button"
              onClick={() => void handleManualSync()}
              disabled={syncing || !isOnline}
              className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface text-sm font-black text-foreground transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "جارٍ المزامنة…" : "مزامنة الآن"}
            </button>
            {syncFeedback && (
              <p className="mt-2 rounded-lg bg-surface-muted px-3 py-2 text-xs font-bold text-foreground">
                {syncFeedback}
              </p>
            )}
          </section>

          {/* ── Printer & device settings ── */}
          <section className="border-b border-border px-4 py-4">
            <h3 className="flex items-center gap-2 text-sm font-black text-foreground">
              <Printer className="h-4 w-4 text-primary" />
              إعدادات الطابعة والجهاز
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-muted">عرض الورق</span>
                <select
                  value={hardware.receiptWidth}
                  onChange={(e) =>
                    updateSettings({ receiptWidth: Number(e.target.value) === 58 ? 58 : 80 })
                  }
                  className="h-9 w-full rounded-lg border border-border bg-white px-2 text-xs font-bold outline-none focus:border-primary"
                >
                  <option value={80}>80 مم</option>
                  <option value={58}>58 مم</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-muted">مفتاح السكانر</span>
                <select
                  value={hardware.scannerSubmitKey}
                  onChange={(e) =>
                    updateSettings({ scannerSubmitKey: e.target.value as typeof hardware.scannerSubmitKey })
                  }
                  className="h-9 w-full rounded-lg border border-border bg-white px-2 text-xs font-bold outline-none focus:border-primary"
                >
                  <option value="ENTER_OR_TAB">Enter أو Tab</option>
                  <option value="ENTER">Enter</option>
                  <option value="TAB">Tab</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-muted">سرعة الدرج</span>
                <select
                  value={hardware.drawerBaudRate}
                  onChange={(e) =>
                    updateSettings({ drawerBaudRate: Number(e.target.value) as typeof hardware.drawerBaudRate })
                  }
                  className="h-9 w-full rounded-lg border border-border bg-white px-2 text-xs font-bold outline-none focus:border-primary"
                >
                  <option value={9600}>9600</option>
                  <option value={19200}>19200</option>
                  <option value={38400}>38400</option>
                  <option value={115200}>115200</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-muted">دبوس الدرج</span>
                <select
                  value={hardware.drawerPin}
                  onChange={(e) => updateSettings({ drawerPin: Number(e.target.value) === 5 ? 5 : 2 })}
                  className="h-9 w-full rounded-lg border border-border bg-white px-2 text-xs font-bold outline-none focus:border-primary"
                >
                  <option value={2}>Pin 2</option>
                  <option value={5}>Pin 5</option>
                </select>
              </label>
            </div>
            <div className="mt-2 space-y-1.5">
              <label className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs font-bold">
                طباعة الإيصال تلقائياً
                <input
                  type="checkbox"
                  checked={hardware.autoPrintReceipt}
                  onChange={(e) => updateSettings({ autoPrintReceipt: e.target.checked })}
                  className="h-4 w-4 accent-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs font-bold">
                فتح درج النقد عند البيع النقدي
                <input
                  type="checkbox"
                  checked={hardware.autoOpenDrawer}
                  onChange={(e) => updateSettings({ autoOpenDrawer: e.target.checked })}
                  className="h-4 w-4 accent-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs font-bold">
                الأصوات
                <input
                  type="checkbox"
                  checked={hardware.soundEnabled}
                  onChange={(e) => updateSettings({ soundEnabled: e.target.checked })}
                  className="h-4 w-4 accent-primary"
                />
              </label>
              {hardware.soundEnabled && (
                <label className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-xs font-bold">
                  مستوى الصوت
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={hardware.soundVolume}
                    onChange={(e) => updateSettings({ soundVolume: Number(e.target.value) })}
                    className="h-1.5 flex-1 accent-primary"
                  />
                  <span className="w-8 shrink-0 text-end tabular-nums">{hardware.soundVolume}%</span>
                </label>
              )}
            </div>
            <p className="mt-2 text-[11px] font-semibold text-muted">
              تُحفظ فوراً لهذا الجهاز ({activeTerminalId ? "طرفية مرتبطة" : "غير مرتبطة بطرفية"}) وتسري على كل الشاشات.
            </p>
          </section>

          {/* ── Barcode tools ── */}
          <section className="px-4 py-4">
            <h3 className="flex items-center gap-2 text-sm font-black text-foreground">
              <ScanLine className="h-4 w-4 text-primary" />
              أدوات الباركود
            </h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                resolveScan();
              }}
              className="mt-2 flex items-center gap-2"
            >
              <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border px-2.5">
                <Barcode className="h-4 w-4 shrink-0 text-muted" />
                <input
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="امسح باركوداً أو أدخله يدوياً…"
                  className="min-w-0 flex-1 bg-transparent text-sm font-bold tracking-wider outline-none placeholder:text-muted"
                />
              </div>
              <button
                type="submit"
                className="h-10 shrink-0 rounded-lg bg-header px-3 text-xs font-black text-primary-foreground transition hover:bg-header/90"
              >
                فحص
              </button>
            </form>
            {scanMatch && (
              <div className="mt-2 rounded-xl border border-border bg-surface-muted/60 px-3 py-2.5">
                <p className="truncate text-sm font-black">{scanMatch.productName}</p>
                <p className="mt-0.5 text-xs font-semibold text-muted">
                  {scanMatch.variantLabel}
                  {scanMatch.unitName && scanMatch.qtyMultiplier && scanMatch.qtyMultiplier !== 1
                    ? ` • ${scanMatch.unitName} (${scanMatch.qtyMultiplier} حبة)`
                    : ""}
                  {` • ${formatMoney(scanMatch.price)}`}
                  {typeof scanMatch.totalStock === "number" ? ` • الرصيد: ${scanMatch.totalStock}` : ""}
                </p>
                <button
                  type="button"
                  onClick={() => void copyScannedBarcode()}
                  className="mt-2 flex h-8 items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 text-[11px] font-bold text-foreground transition hover:bg-surface-muted"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "تم النسخ" : scanMatch.barcode}
                </button>
              </div>
            )}
            {scanMissing && (
              <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive">
                هذا الباركود غير مسجل في الكتالوج
              </p>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
