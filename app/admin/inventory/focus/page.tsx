"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Barcode,
  CheckCircle2,
  ClipboardCheck,
  Eraser,
  History,
  Minus,
  Package,
  Plus,
  ScanLine,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import { breakdownStock, maxUnitsAvailable } from "@/lib/stockDisplay";
import {
  resolveScan,
  type ResolvedProduct,
  type ScanResolveInput,
} from "@/lib/scanResolve";
import { createMovement } from "@/lib/movementsClient";
import { emitPosSound } from "@/lib/posSound";
import { usePosStore } from "@/store/usePosStore";
import { usePurchasesScanner } from "@/hooks/usePurchasesScanner";
import type { LocalUnit } from "@/types/pos.types";

type Mode = "IN" | "OUT" | "COUNT" | "DAMAGE";

interface ModeConfig {
  key: Mode;
  label: string;
  hint: string;
  icon: typeof Plus;
  tone: string;
  destructive: boolean;
}

const MODES: ModeConfig[] = [
  {
    key: "IN",
    label: "إضافة",
    hint: "ادخال كميات واردة للمخزون",
    icon: Plus,
    tone: "bg-success/15 text-success border-success/30",
    destructive: false,
  },
  {
    key: "OUT",
    label: "سحب",
    hint: "إخراج كميات من المخزون",
    icon: Minus,
    tone: "bg-destructive/15 text-destructive border-destructive/30",
    destructive: true,
  },
  {
    key: "COUNT",
    label: "جرد / تسوية",
    hint: "ضبط الرصيد إلى القيمة الفعلية",
    icon: ClipboardCheck,
    tone: "bg-amber-100 text-amber-700 border-amber-300",
    destructive: false,
  },
  {
    key: "DAMAGE",
    label: "تالف",
    hint: "إخراج أصناف تالفة أو منتهية",
    icon: AlertTriangle,
    tone: "bg-orange-100 text-orange-700 border-orange-300",
    destructive: true,
  },
];

const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Whether a barcode is actually that product's packaging tier. */
function findUnit(resolved: ResolvedProduct, unitId?: string | null): LocalUnit | null {
  if (!unitId) return null;
  return resolved.units.find((u) => u.id === unitId) ?? null;
}

export default function InventoryFocusPage() {
  const adminEmail = usePosStore((state) => state.adminSession?.email ?? "");
  const products = usePosStore((s) => s.products);
  const barcodeIndex = usePosStore((s) => s.barcodeIndex);
  const barcodes = usePosStore((s) => s.barcodes);
  const productUnits = usePosStore((s) => s.productUnits);
  const hydrateCatalog = usePosStore((s) => s.hydrateCatalog);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestKeyRef = useRef("");
  const [scanInput, setScanInput] = useState("");
  const [resolvedQuery, setResolvedQuery] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [mode, setMode] = useState<Mode>("IN");
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [qtyInUnit, setQtyInUnit] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastScan, setLastScan] = useState<string | null>(null);

  const input = useMemo<ScanResolveInput>(
    () => ({ barcodeIndex, barcodes, products, productUnits }),
    [barcodeIndex, barcodes, products, productUnits],
  );

  const resolved = useMemo<ResolvedProduct | null>(() => {
    if (!resolvedQuery) return null;
    return resolveScan(resolvedQuery, input);
  }, [resolvedQuery, input]);

  // Keep the scan field focused for continuous, mouse-free scanning.
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    focusTimerRef.current = setTimeout(() => inputRef.current?.focus(), 60);
    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    };
  }, [resolved, confirming]);

  const handleScan = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      setError("");
      setNotice("");
      const result = resolveScan(trimmed, input);
      setNotFound(!result);
      if (result) {
        setResolvedQuery(trimmed);
        setLastScan(result.productName);
        setSelectedUnitId(null);
        setQtyInUnit("");
        setReason("");
        setConfirming(false);
        emitPosSound("SCAN_ACCEPTED");
      }
    },
    [input],
  );

  // Global wedge fallback (fires only when focus is outside the scan field).
  usePurchasesScanner((code) => handleScan(code));

  const clearProduct = useCallback(() => {
    setResolvedQuery(null);
    setNotFound(false);
    setScanInput("");
    setSelectedUnitId(null);
    setQtyInUnit("");
    setReason("");
    setConfirming(false);
    inputRef.current?.focus();
  }, []);

  const submitScanInput = () => {
    const code = scanInput.trim();
    if (!code) return;
    handleScan(code);
    setScanInput("");
    inputRef.current?.focus();
  };

  const selectedUnit = resolved ? findUnit(resolved, selectedUnitId) : null;
  const multiplier = selectedUnit ? selectedUnit.qtyMultiplier : 1;
  const qtyNum = parseFloat(qtyInUnit) || 0;
  const baseQty = round2(qtyNum * multiplier);

  const baseUnitLabel = resolved?.baseUnit ?? "حبة";
  const currentTotalStock = resolved?.totalStock ?? 0;
  const resultBalance =
    mode === "COUNT"
      ? baseQty
      : round2(currentTotalStock + (mode === "IN" ? baseQty : -baseQty));
  const deltaForLedger = mode === "COUNT" ? baseQty - currentTotalStock : mode === "IN" ? baseQty : -baseQty;

  const destructiveMode = mode === "OUT" || mode === "DAMAGE";
  const isOverdraw = destructiveMode && baseQty > currentTotalStock;
  const needsConfirm = destructiveMode || (mode === "COUNT" && deltaForLedger < 0);
  const canSubmit =
    !!resolved &&
    baseQty > 0 &&
    !isOverdraw &&
    !saving &&
    (mode === "COUNT" ? true : multiplier === 1 || !!selectedUnit);

  // Barcode to record: packaging-tier barcode for cartons, else the scanned
  // (or first) variant barcode.
  const chosenBarcode = selectedUnit
    ? selectedUnit.barcode ?? ""
    : resolved?.variants[0]?.barcode ?? "";

  const executeMovement = async () => {
    if (!resolved) return;
    setError("");
    setNotice("");
    if (!requestKeyRef.current) requestKeyRef.current = crypto.randomUUID();
    setSaving(true);
    try {
      await createMovement({
        productId: resolved.productId,
        barcode: chosenBarcode,
        mode,
        quantity: baseQty,
        reason: reason.trim(),
        idempotencyKey: requestKeyRef.current,
        actorName: adminEmail,
      });
      requestKeyRef.current = "";
      setQtyInUnit("");
      setReason("");
      setConfirming(false);
      setNotice(
        mode === "COUNT"
          ? `تم ضبط رصيد «${resolved.productName}» إلى ${baseQty} ${baseUnitLabel}`
          : `تم تسجيل حركة «${mode === "IN" ? "إضافة" : mode === "OUT" ? "سحب" : "تالف"}» لـ «${resolved.productName}»`,
      );
      await hydrateCatalog().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تسجيل حركة المخزون");
    } finally {
      setSaving(false);
      inputRef.current?.focus();
    }
  };

  // Low-stock quick strip from the local catalog (deduped by name so variants
  // of the same parent collapse into one tap).
  const lowStock = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ id: string; name: string; baseUnit: string; totalStock: number }> = [];
    for (const p of Object.values(products)) {
      const key = p.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if ((p.reorderLevel ?? 0) > 0 && (p.totalStock ?? 0) <= (p.reorderLevel ?? 0)) {
        list.push({ id: p.id, name: p.name, baseUnit: p.baseUnit, totalStock: p.totalStock ?? 0 });
      }
    }
    return list.sort((a, b) => a.totalStock - b.totalStock).slice(0, 8);
  }, [products]);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-black text-foreground">وضع التركيز — أمين المستودع</h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            امسح الباركود ثم نفّذ الإضافة أو الجرد أو السحب بأقل عدد نقرات — مع تحقق فوري من الرصيد قبل الحفظ
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/inventory/movements"
            className="flex h-11 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black text-foreground hover:bg-surface-muted"
          >
            <History className="h-5 w-5 text-primary" /> حركات المخزون
          </Link>
          <Link
            href="/admin/inventory"
            className="flex h-11 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black text-foreground hover:bg-surface-muted"
          >
            <Package className="h-5 w-5 text-primary" /> المنتجات والمخزون
          </Link>
        </div>
      </header>

      {/* ── Low-stock strip ── */}
      {lowStock.length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-black text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" /> مخزون منخفض — اضغط لفتح الصنف
          </p>
          <div className="flex flex-wrap gap-1.5">
            {lowStock.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setScanInput("");
                  setResolvedQuery(p.name);
                  setNotFound(false);
                  setSelectedUnitId(null);
                  setQtyInUnit("");
                  setReason("");
                  setConfirming(false);
                  inputRef.current?.focus();
                }}
                className="rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-black text-amber-900 hover:bg-amber-100"
              >
                {p.name} · <span className="tabular-nums">{p.totalStock ?? 0}</span>{" "}
                {p.baseUnit}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Scan field ── */}
      <div className="rounded-2xl border-2 border-primary/30 bg-white p-3 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
        <label className="mb-1 flex items-center gap-2 text-xs font-black text-muted">
          <ScanLine className="h-4 w-4 text-primary" />
          امسح الباركود (أو اكتب الاسم) — يستمر التركيز للمسح التلقائي
        </label>
        <div className="flex items-center gap-2">
          <div className="flex h-14 min-w-0 flex-1 items-center gap-2 rounded-xl bg-surface-muted px-4">
            <Barcode className="h-6 w-6 shrink-0 text-primary/60" />
            <input
              ref={inputRef}
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitScanInput();
                } else if (e.key === "Escape") {
                  clearProduct();
                }
              }}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              placeholder="امسح أو اكتب ثم Enter…"
              className="min-w-0 flex-1 bg-transparent text-lg font-bold tracking-wider outline-none placeholder:text-muted/40"
            />
            {scanInput && (
              <button
                type="button"
                onClick={clearProduct}
                aria-label="مسح"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-white"
              >
                <Eraser className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={submitScanInput}
            className="flex h-14 shrink-0 flex-col items-center justify-center rounded-xl bg-primary px-5 text-sm font-black text-primary-foreground transition hover:bg-primary-hover"
          >
            <ScanLine className="h-5 w-5" />
            بحث
          </button>
        </div>
        {lastScan && (
          <p className="mt-2 text-[11px] font-bold text-muted">
            آخر مسح: <span className="text-foreground">{lastScan}</span>
          </p>
        )}
        {notFound && (
          <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">
            هذا الباركود أو الاسم غير مسجل في الكتالوج
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-xl bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-xl bg-success/10 px-4 py-2.5 text-sm font-bold text-success">
          <CheckCircle2 className="h-4 w-4" />
          {notice}
        </div>
      )}

      {/* ── Resolved product + action panel ── */}
      {resolved && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* Left: summary + mode + unit + qty */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-black text-foreground">{resolved.productName}</h2>
                  <p className="mt-0.5 text-xs font-bold text-muted">
                    {resolved.baseUnit} • {resolved.isWeighed ? "وزني" : "عدد"}
                    {resolved.variants.length > 1 && ` • ${resolved.variants.length} متغيرات`}
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  <span className="block text-3xl font-black tabular-nums text-foreground">
                    {breakdownStock(
                      currentTotalStock,
                      resolved.units,
                      resolved.isWeighed,
                      baseUnitLabel,
                    ).label}
                  </span>
                  <span className="text-xs font-bold text-muted">
                    الرصيد الحالي: {currentTotalStock} {baseUnitLabel}
                  </span>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-white p-3">
                  <span className="block text-[10px] font-bold text-muted">التكلفة</span>
                  <span className="tabular-nums font-black">{formatMoney(resolved.costPrice)}</span>
                </div>
                <div className="rounded-xl border border-border bg-white p-3">
                  <span className="block text-[10px] font-bold text-muted">سعر البيع</span>
                  <span className="tabular-nums font-black">{formatMoney(resolved.sellingPrice)}</span>
                </div>
              </div>
            </div>

            {/* Mode picker */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {MODES.map((m) => {
                const Icon = m.icon;
                const active = mode === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => {
                      setMode(m.key);
                      setConfirming(false);
                    }}
                    className={`flex flex-col items-center gap-1 rounded-2xl border-2 p-4 text-sm font-black transition ${
                      active
                        ? `${m.tone} ring-2 ring-offset-1 ring-primary`
                        : "border-border bg-white text-muted hover:bg-surface-muted"
                    }`}
                  >
                    <Icon className="h-7 w-7" />
                    {m.label}
                    <span className="text-[10px] font-bold text-muted">{m.hint}</span>
                  </button>
                );
              })}
            </div>

            {/* Unit chips */}
            <div>
              <p className="mb-1.5 text-xs font-black text-muted">الوحدة</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { setSelectedUnitId(null); setQtyInUnit(""); }}
                  className={`rounded-xl border-2 px-4 py-2.5 text-sm font-black transition ${
                    !selectedUnit
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-white text-muted hover:bg-surface-muted"
                  }`}
                >
                  {baseUnitLabel} (×1)
                </button>
                {resolved.units.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => { setSelectedUnitId(u.id); setQtyInUnit(""); }}
                    className={`rounded-xl border-2 px-4 py-2.5 text-sm font-black transition ${
                      selectedUnitId === u.id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-white text-muted hover:bg-surface-muted"
                    }`}
                  >
                    {u.unitName} (×{u.qtyMultiplier})
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right: quantity + keypad + verify + submit */}
          <div className="space-y-4 rounded-2xl border border-border bg-white p-4 shadow-sm">
            <div>
              <p className="text-xs font-black text-muted">
                الكمية ({selectedUnit?.unitName ?? baseUnitLabel})
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={qtyInUnit}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.]/g, "");
                    setQtyInUnit(v);
                    setConfirming(false);
                  }}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="0"
                  className="h-16 w-full rounded-xl border-2 border-border bg-surface-muted px-4 text-center text-3xl font-black tabular-nums outline-none focus:border-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {KEYPAD.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (key === "⌫") {
                      setQtyInUnit((prev) => prev.slice(0, -1));
                    } else if (key === "." && qtyInUnit.includes(".")) {
                      return;
                    } else {
                      setQtyInUnit((prev) => prev + key);
                    }
                    setConfirming(false);
                  }}
                  className="h-14 rounded-lg border border-border bg-surface-muted text-xl font-black text-foreground transition hover:bg-white"
                >
                  {key}
                </button>
              ))}
            </div>

            {multiplier > 1 && baseQty > 0 && (
              <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm font-bold text-muted">
                {qtyNum} {selectedUnit?.unitName} <span className="text-muted">×{multiplier}</span> ={" "}
                <span className="font-black tabular-nums text-foreground">{baseQty} {baseUnitLabel}</span>
              </p>
            )}

            {/* Live balance verification */}
            <div
              className={`rounded-xl p-3 text-sm font-black ${
                isOverdraw
                  ? "bg-destructive/15 text-destructive"
                  : deltaForLedger < 0
                    ? "bg-red-50 text-red-700"
                    : "bg-success/10 text-success"
              }`}
            >
              {mode === "COUNT" ? (
                <span>
                  سيتم ضبط الرصيد إلى{" "}
                  <span className="tabular-nums">{resultBalance} {baseUnitLabel}</span>
                  {currentTotalStock !== resultBalance && (
                    <span className="block text-[11px] font-bold text-muted">
                      التغير: {deltaForLedger > 0 ? "+" : ""}
                      <span className="tabular-nums">{deltaForLedger}</span> {baseUnitLabel}
                    </span>
                  )}
                </span>
              ) : (
                <span>
                  الرصيد بعد العملية:{" "}
                  <span className="tabular-nums">{resultBalance} {baseUnitLabel}</span>
                </span>
              )}
              {isOverdraw && (
                <span className="block text-[11px] font-bold">
                  ⚠ الرصيد لا يكفي — المتاح ضمن هذه الوحدة:{" "}
                  <span className="tabular-nums">
                    {selectedUnit ? maxUnitsAvailable(currentTotalStock, selectedUnit.qtyMultiplier) : currentTotalStock}
                  </span>{" "}
                  {selectedUnit?.unitName ?? baseUnitLabel}
                </span>
              )}
            </div>

            <label className="block text-xs font-black text-muted">
              السبب (اختياري — يساعد في التدقيق)
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="مثال: فرق جرد فعلي"
                className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 text-sm font-bold outline-none focus:border-primary"
              />
            </label>

            {needsConfirm && !confirming ? (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!canSubmit}
                className={`h-14 w-full rounded-xl text-lg font-black text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  mode === "DAMAGE"
                    ? "bg-orange-600 hover:bg-orange-700"
                    : "bg-destructive hover:bg-destructive/90"
                }`}
              >
                {destructiveMode ? "تأكيد السحب / التالف" : "تأكيد التسوية"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void executeMovement()}
                disabled={!canSubmit || saving}
                className="h-14 w-full rounded-xl bg-primary text-lg font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? "جارٍ الحفظ…" : "تأكيد وحفظ الحركة"}
              </button>
            )}

            {needsConfirm && confirming && (
              <p className="text-center text-[11px] font-bold text-muted">
                اضغط «تأكيد وحفظ الحركة» لاعتماد السحب نهائياً — أو غيّر الكمية لإلغاء
              </p>
            )}
          </div>
        </div>
      )}

      {!resolved && !notFound && (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface py-16 text-center">
          <div className="grid h-20 w-20 place-items-center rounded-3xl bg-primary/10">
            <ScanLine className="h-10 w-10 text-primary/50" />
          </div>
          <p className="mt-4 text-lg font-black text-foreground">ابدأ بمسح باركود منتج</p>
          <p className="mt-1 text-sm font-semibold text-muted">
            الاستعلام فوري من الكتالوج المحلي — لا انتظار ولا نقرات إضافية
          </p>
        </div>
      )}
    </div>
  );
}
