"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BadgePercent, Barcode, Building2, ChevronDown, ClipboardList, CreditCard, Pause, Pencil, ReceiptText, Trash2, X, XCircle, Zap } from "lucide-react";
import { anyPosModalOpen, usePosStore } from "@/store/usePosStore";
import { useOrdersStore } from "@/store/useOrdersStore";
import { formatMoney } from "@/lib/format";
import { withB2BMarkup } from "@/lib/saleMath";
import { formatProductDisplayName } from "@/lib/productDisplayName";
import type { DiscountScope, LocalUnit, SaleItem } from "@/types/pos.types";
import { useDeviceHardware } from "@/hooks/useDeviceHardware";
import { scannerAcceptsSubmitKey } from "@/lib/deviceHardware";
import { SCAN_COALESCE_MS } from "@/lib/scanCoalesce";
import DiscountModal from "./DiscountModal";
import QuickItemModal from "./QuickItemModal";
import AdminLineEditModal from "./AdminLineEditModal";
import EntityCombobox from "@/components/shared/EntityCombobox";
import QuickCreateEntityModal from "@/components/shared/QuickCreateEntityModal";
import { useCustomerOptions } from "@/components/pos/useCustomerOptions";

/**
 * Stable, unique identity for a cart line. The cart merges by barcode OR
 * (product + unit + price), and `addLine` can rewrite a line's `barcode` /
 * `unitName` / `unitPrice` when a barcode-less quick-key tap is later scanned
 * (the code and unit are adopted onto the existing row). React row keys must
 * therefore NOT derive from those mutable fields — a changing key unmounts and
 * remounts the <tr> (visible flash). `productId`/`variantId`/`unitId` are fixed
 * at insert and never rewritten by a merge, so they form the stable, unique
 * key: two coexistable lines always differ in at least one of the three (any
 * two that matched on all three would already have been merged).
 */
function saleItemKey(item: SaleItem): string {
  return [item.productId, item.variantId ?? "", item.unitId ?? ""].join(":");
}

/**
 * Unit badge (Phase 2A): inline dropdown that replaces the old full-width
 * chip row. Shows only the active unit name + chevron; clicking opens a
 * small popover listing all available units. Keeps the cart row compact.
 */
const UnitBadge = memo(function UnitBadge({
  units,
  item,
  index,
  onSetLineUnit,
}: {
  units: LocalUnit[];
  item: SaleItem;
  index: number;
  onSetLineUnit: (index: number, unitId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const activeUnit =
    units.find((u) => u.id === item.unitId) ??
    units.find((u) => u.isDefaultSale) ??
    units[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler, { passive: true });
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!activeUnit) return null;

  return (
    <div ref={ref} className="relative mt-0.5 inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-black leading-4 text-primary transition hover:bg-primary/20"
      >
        {activeUnit.unitName}{activeUnit.qtyMultiplier > 1 ? ` (×${activeUnit.qtyMultiplier})` : ''}
        <ChevronDown className="h-2.5 w-2.5" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[100px] rounded-lg border border-border bg-surface py-1 shadow-lg">
          {units.map((unit) => {
            const isActive = unit.id === activeUnit.id;
            return (
              <button
                key={unit.id}
                type="button"
                onClick={() => {
                  if (!isActive) onSetLineUnit(index, unit.id);
                  setOpen(false);
                }}
                className={`block w-full px-3 py-1.5 text-right text-xs font-bold transition ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-foreground hover:bg-muted"
                }`}
              >
                {unit.unitName}{unit.qtyMultiplier > 1 ? ` (×${unit.qtyMultiplier})` : ''}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

/**
 * A single cart line rendered as a semantic <tr>. Memoized and keyed by
 * barcode/product so a qty or totals change only re-renders the affected row.
 */
const CartRow = memo(function CartRow({
  item,
  index,
}: {
  item: SaleItem;
  index: number;
}) {
  const adminSession = usePosStore((s) => s.adminSession);
  const isReturnMode = usePosStore((s) => s.isReturnMode);
  const setLineEditTarget = usePosStore((s) => s.setLineEditTarget);
  const updateQty = usePosStore((s) => s.updateQty);
  const removeItem = usePosStore((s) => s.removeItem);
  // Stable refs: raw arrays are selected, filtering happens in render.
  const units = usePosStore((s) => s.productUnits[item.productId]);
  const setLineUnit = usePosStore((s) => s.setLineUnit);

  const activeUnits = (units ?? []).filter((u) => u.isActive);

  const mult = item.unitMultiplier || 1;
  const qtyRef = useRef<HTMLInputElement>(null);
  const [qtyDraft, setQtyDraft] = useState<string>(() =>
    String(Math.max(1, Math.round(item.qty / mult))),
  );
  const [prevQty, setPrevQty] = useState(item.qty);
  const [prevMult, setPrevMult] = useState(mult);
  if (item.qty !== prevQty || mult !== prevMult) {
    setPrevQty(item.qty);
    setPrevMult(mult);
    setQtyDraft(String(Math.max(1, Math.round(item.qty / mult))));
  }

  const commitPieces = (raw: string) => {
    const parsed = Number(String(raw).replace(",", ".").trim());
    const pieces = Number.isFinite(parsed)
      ? Math.round(parsed)
      : Math.max(1, Math.round(item.qty / mult));
    const sign = isReturnMode && item.qty < 0 ? -1 : 1;
    const nextQty = Math.max(0, pieces) * mult * sign;
    setQtyDraft(String(Math.max(1, pieces)));
    updateQty(index, nextQty);
  };

  const currentPieces = () => Math.max(1, Math.round(item.qty / mult));
  const stepPieces = (delta: number) => commitPieces(String(currentPieces() + delta));

  return (
    <tr className="border-b border-slate-100/80 transition-colors duration-100 hover:bg-slate-50/80">
      <td className="py-1.5 ps-3 pe-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span
              title={item.name}
              className="min-w-0 flex-1 truncate text-[15px] font-bold leading-tight text-slate-800"
            >
              {formatProductDisplayName(item.name, item.variantLabel)}
            </span>
            {item.barcode && item.barcode !== item.variantLabel && (
              <span className="shrink-0 font-mono text-xs text-slate-400">{item.barcode}</span>
            )}
          </div>
          {item.discount ? (
            <span className="inline-flex w-fit items-center rounded bg-primary/10 px-1.5 py-0.5 text-xs font-black text-primary">
              خصم
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-1.5 px-1 text-center">
        {activeUnits.length > 1 ? (
          <UnitBadge
            units={activeUnits}
            item={item}
            index={index}
            onSetLineUnit={setLineUnit}
          />
        ) : (
          <span className="text-[13px] font-semibold text-slate-500">{item.unitName}</span>
        )}
      </td>
      <td className="py-1.5 px-1 text-center">
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            aria-label="إنقاص الكمية"
            onClick={() => stepPieces(-1)}
            disabled={!isReturnMode && item.qty <= mult}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-slate-200 text-base font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 active:scale-95 disabled:opacity-30"
          >
            −
          </button>
          <input
            ref={qtyRef}
            type="number"
            inputMode="numeric"
            min="1"
            value={qtyDraft}
            onChange={(e) => setQtyDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => commitPieces(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitPieces((e.target as HTMLInputElement).value);
                qtyRef.current?.blur();
              }
            }}
            aria-label="الكمية"
            title="اضغط لإدخال الكمية مباشرة"
            className="h-8 w-10 shrink-0 rounded-md border border-slate-200 bg-white text-center text-sm font-black tabular-nums text-slate-800 outline-none transition focus:border-green-400 focus:ring-2 focus:ring-green-200"
          />
          <button
            type="button"
            aria-label="زيادة الكمية"
            onClick={() => stepPieces(1)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-green-200 text-base font-bold text-green-600 transition hover:bg-green-50 hover:text-green-700 active:scale-95"
          >
            +
          </button>
        </div>
      </td>
      <td className="whitespace-nowrap py-1.5 px-2 text-center text-[15px] tabular-nums text-slate-600">
        {adminSession ? (
          <button
            type="button"
            onClick={() => setLineEditTarget(index)}
            className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2.5 font-bold text-primary transition hover:bg-primary/10"
            title="تعديل السعر"
          >
            {formatMoney(item.unitPrice)}
            <Pencil className="h-3 w-3" />
          </button>
        ) : (
          formatMoney(item.unitPrice)
        )}
      </td>
      <td className="whitespace-nowrap py-1.5 px-2 text-center text-[15px] font-black tabular-nums text-slate-900">
        {formatMoney(item.lineTotal)}
      </td>
      <td className="py-1.5 pe-3 ps-2 text-center">
        <button
          type="button"
          aria-label="حذف الصنف"
          title="حذف الصنف"
          onClick={() => removeItem(index)}
          className="grid h-11 w-11 place-items-center rounded-lg border border-transparent text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 active:scale-90"
        >
          <Trash2 className="h-[18px] w-[18px]" />
        </button>
      </td>
    </tr>
  );
});

/**
 * Cart-level customer assignment (Phase 4). Selecting a customer here drives
 * the last-price Memory Badges and stamps the invoice. Isolated so picking a
 * customer never re-renders the cart rows or the scanner input.
 */
const CustomerPickerBar = memo(function CustomerPickerBar() {
  const activeCustomerId = usePosStore((s) => s.activeCustomerId);
  const setActiveCustomer = usePosStore((s) => s.setActiveCustomer);
  const { customers, loading, createCustomer } = useCustomerOptions(true);
  const [addingCustomer, setAddingCustomer] = useState(false);

  return (
    <div className="border-b border-slate-100 px-3 py-1">
      <EntityCombobox
        id="pos-invoice-customer"
        label="الزبون"
        value={activeCustomerId ?? ""}
        options={customers}
        placeholder={loading ? "جارٍ تحميل العملاء..." : "بدون زبون (اختياري)"}
        emptyLabel="لا يوجد زبون مطابق"
        addLabel="إضافة زبون جديد"
        onChange={(id) => setActiveCustomer(id || null)}
        onAdd={() => setAddingCustomer(true)}
      />
      {addingCustomer && (
        <QuickCreateEntityModal
          title="إضافة زبون جديد"
          nameLabel="اسم الزبون"
          namePlaceholder="مثال: محمد العلي"
          withPhone
          onClose={() => setAddingCustomer(false)}
          onCreate={async (data) => {
            const customer = await createCustomer(data);
            setActiveCustomer(customer.id);
            setAddingCustomer(false);
          }}
        />
      )}
    </div>
  );
});

export default function InvoicePanel() {
  const items = usePosStore((s) => s.items);
  const totals = usePosStore((s) => s.totals);
  // Phase 4 (B2B application): primitives/stable refs only — no allocating
  // selectors. The marked-up view of the cart is derived in render via
  // useMemo, keeping base prices canonical in the store.
  const b2bMarkupPct = usePosStore((s) => s.b2bMarkupPct);
  const activeB2BAccountName = usePosStore((s) => s.activeB2BAccountName);
  const scanBarcode = usePosStore((s) => s.scanBarcode);
  const clearDiscount = usePosStore((s) => s.clearDiscount);
  const isReturnMode = usePosStore((s) => s.isReturnMode);
  const adminSession = usePosStore((s) => s.adminSession);
  const lineEditTarget = usePosStore((s) => s.lineEditTarget);
  // Parked carts now live in the orders store (Phase 2); the badge counts
  // OPEN orders across devices for this store.
  const openOrdersCount = useOrdersStore(
    (s) => s.orders.filter((o) => o.status === "OPEN").length,
  );
  const openCheckout = usePosStore((s) => s.openCheckout);
  const openHoldModal = usePosStore((s) => s.openHoldModal);
  const holdInvoice = usePosStore((s) => s.holdInvoice);
  const clearInvoice = usePosStore((s) => s.clearInvoice);
  const activeTerminalId = usePosStore((s) => s.activeTerminalId);
  const cartSlots = usePosStore((s) => s.cartSlots);
  const activeCartIndex = usePosStore((s) => s.activeCartIndex);
  const switchCart = usePosStore((s) => s.switchCart);
  const createCart = usePosStore((s) => s.createCart);
  const closeCart = usePosStore((s) => s.closeCart);
  const { settings: hardwareSettings } = useDeviceHardware(activeTerminalId);

  const omnibarRef = useRef<HTMLInputElement>(null);
  const [omnibarInput, setOmnibarInput] = useState("");
  // Echo guard for the manual omnibar submit: some scanners emit a double
  // Enter terminator, and a burst landing across a focus toggle can reach the
  // form twice. The store already coalesces duplicate codes atomically; this
  // ref stops the identical input from even reaching the store a second time
  // within the coalesce window (avoids a redundant not-found/error flash).
  const lastOmnibarSubmitRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const [discountTarget, setDiscountTarget] = useState<{
    scope: DiscountScope;
    index?: number;
  } | null>(null);

  const [quickItemOpen, setQuickItemOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const confirmClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const empty = items.length === 0;

  // Display-only markup view (Phase 4): same order/length as the store items
  // so index-based actions (updateQty/removeItem) stay valid. With no B2B
  // account this returns the original array — zero allocation on the happy path.
  const displayItems = useMemo(() => withB2BMarkup(items, b2bMarkupPct), [items, b2bMarkupPct]);

  useEffect(() => {
    return () => {
      if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current);
    };
  }, []);

  const handleClearInvoice = useCallback(() => {
    if (confirmClear) {
      if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current);
      confirmClearTimer.current = null;
      setConfirmClear(false);
      clearInvoice();
    } else {
      setConfirmClear(true);
      confirmClearTimer.current = setTimeout(() => setConfirmClear(false), 2000);
    }
  }, [confirmClear, clearInvoice]);

  useEffect(() => {
    omnibarRef.current?.focus();
  }, []);

  const submitOmnibar = () => {
    const code = omnibarInput.trim();
    if (!code) return;
    if (anyPosModalOpen(usePosStore.getState())) {
      omnibarRef.current?.focus();
      return;
    }
    const now = performance.now();
    const last = lastOmnibarSubmitRef.current;
    if (last.code === code && now - last.at < SCAN_COALESCE_MS) {
      // Duplicate echo of the same manual submit — swallow it and just clear.
      setOmnibarInput("");
      omnibarRef.current?.focus();
      return;
    }
    lastOmnibarSubmitRef.current = { code, at: now };
    scanBarcode(code);
    setOmnibarInput("");
    omnibarRef.current?.focus();
  };

  const handleOmnibarSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (scannerAcceptsSubmitKey("Enter", hardwareSettings.scannerSubmitKey)) {
      submitOmnibar();
    }
  };

  const handleOmnibarKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!scannerAcceptsSubmitKey(e.key, hardwareSettings.scannerSubmitKey)) return;
    if (e.key !== "Tab") return;
    e.preventDefault();
    submitOmnibar();
  };

  const handleHoldClick = () => {
    if (items.length > 0) holdInvoice();
    openHoldModal();
  };

  return (
    <section
      className={`flex flex-1 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/80 shadow-[0_2px_16px_rgba(15,23,42,0.06)] ${
        isReturnMode
          ? "border-destructive bg-destructive/5"
          : "border-slate-200 bg-white"
      }`}
    >
      {/* ── Invoice Tabs ── */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 bg-slate-100/60 px-2.5 pt-1.5 scrollbar-hidden">
        {cartSlots.map((slot, idx) => {
          const isActive = idx === activeCartIndex;
          const count = isActive ? items.length : slot.items.length;
          return (
            <div key={slot.id} className="group relative flex">
              <button
                type="button"
                onClick={() => switchCart(idx)}
                className={`flex h-11 items-center gap-1.5 rounded-t-xl border border-b-0 px-3 text-[13px] font-bold transition ${
                  isActive
                    ? "border-green-400 bg-white text-green-700 shadow-sm"
                    : "border-transparent bg-slate-100/70 text-slate-500 hover:bg-slate-200/70"
                }`}
              >
                <ReceiptText className="h-3.5 w-3.5" />
                فاتورة {idx + 1}
                {count > 0 && (
                  <span
                    className={`grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs font-black ${
                      isActive ? "bg-green-100 text-green-700" : "bg-slate-200 text-slate-500"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
              {cartSlots.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeCart(idx);
                  }}
                  className="ms-0.5 grid h-11 w-11 shrink-0 place-items-center self-center rounded-lg text-slate-400 transition hover:bg-rose-100 hover:text-rose-500 active:scale-95"
                  title="إغلاق الفاتورة"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={createCart}
          className="grid h-11 w-11 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-200 hover:text-slate-600"
          title="فاتورة جديدة"
        >
          <span className="text-lg leading-none font-black">+</span>
        </button>
      </div>

      {/* ── Omnibar (Barcode + Search) ── */}
      <form onSubmit={handleOmnibarSubmit} className="border-b border-slate-200 px-3 py-1">
        <div className="flex h-11 items-center gap-2 rounded-xl border border-slate-200/70 bg-slate-50/80 px-2.5 transition-all focus-within:border-slate-300/80 focus-within:bg-white focus-within:shadow-card">
          <Barcode className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            ref={omnibarRef}
            value={omnibarInput}
            onChange={(e) => setOmnibarInput(e.target.value)}
            onKeyDown={handleOmnibarKeyDown}
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            dir="ltr"
            placeholder="امسح الباركود أو ابحث عن صنف..."
            className="min-w-0 flex-1 bg-transparent text-[15px] font-bold tracking-wider text-slate-800 outline-none placeholder:text-slate-400"
          />
          {omnibarInput && (
            <button
              type="button"
              onClick={() => setOmnibarInput("")}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-200 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </form>

      <CustomerPickerBar />

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hidden">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="animate-pos-float grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-green-50 via-white to-slate-50 shadow-inner ring-1 ring-green-100/80">
              <ReceiptText className="h-10 w-10 text-green-300" />
            </div>
            <p className="text-lg font-black text-slate-700">لا توجد أصناف بعد</p>
            <p className="max-w-60 text-[15px] font-semibold leading-relaxed text-slate-500">
              امسح باركوداً أو اضغط على صنف سريع لإضافته للفاتورة
            </p>
          </div>
        ) : (
          <table className="w-full table-fixed text-start">
            <colgroup>
              <col className="w-[38%]" />
              <col className="w-[12%]" />
              <col className="w-[16%]" />
              <col className="w-[14%]" />
              <col className="w-[13%]" />
              <col className="w-[7%]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur">
              <tr className="border-b border-slate-200 text-[13px] font-black uppercase tracking-wider text-slate-400">
                <th className="px-3 py-1.5">الصنف</th>
                <th className="px-2 py-1.5 text-center">الوحدة</th>
                <th className="px-2 py-1.5 text-center">الكمية</th>
                <th className="px-2 py-1.5 text-center">السعر</th>
                <th className="px-2 py-1.5 text-center">المجموع</th>
                <th className="pe-3 ps-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {displayItems.map((item, i) => (
                <CartRow
                  key={saleItemKey(item)}
                  item={item}
                  index={i}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="shrink-0 space-y-2 border-t border-slate-200 bg-slate-50/80 px-3 py-2.5">
        {activeB2BAccountName && b2bMarkupPct > 0 && (
          <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-black text-primary">
            <Building2 className="h-3.5 w-4 shrink-0" />
            <span className="flex-1 truncate">تسعير {activeB2BAccountName}</span>
            <span className="tabular-nums">+{b2bMarkupPct}%</span>
          </div>
        )}

        {/* Primary checkout — prominent & wide */}
        <button
          type="button"
          disabled={empty}
          onClick={openCheckout}
          className={`flex h-[52px] w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-xl px-4 text-lg font-black shadow-card transition-colors duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
            isReturnMode
              ? "bg-destructive text-destructive-foreground hover:bg-destructive-hover"
              : "bg-primary text-primary-foreground hover:bg-primary-hover"
          }`}
        >
          <CreditCard className="h-[22px] w-[22px] shrink-0" />
          {isReturnMode ? "إرجاع" : "دفع الفاتورة"}
          {!empty && (
            <span className="tabular-nums text-base">• {formatMoney(totals.total)}</span>
          )}
        </button>

        {/* Totals — compact inline summary */}
        <div className="rounded-lg border border-slate-200/70 bg-white px-3 py-2">
          <div className="flex items-center justify-between text-[13px] font-semibold text-slate-600">
            <span>الصافي</span>
            <span className="tabular-nums">{formatMoney(totals.subtotal)}</span>
          </div>
          <div className="flex items-center justify-between text-[13px] font-semibold text-slate-600">
            <span>الضريبة</span>
            <span className="tabular-nums">{formatMoney(totals.tax)}</span>
          </div>
          <div className={`flex items-center justify-between text-[13px] font-bold text-rose-600 ${totals.discount > 0 ? "" : "invisible"}`}>
            <span>الخصم</span>
            <span className="flex items-center gap-1">
              <span className="tabular-nums">-{formatMoney(totals.discount)}</span>
              <button
                type="button"
                onClick={clearDiscount}
                aria-label="إلغاء الخصم"
                title="إلغاء الخصم"
                className="grid h-6 w-6 place-items-center rounded-md text-rose-600 transition hover:bg-rose-100 active:scale-90"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        </div>

        {/* Secondary quick actions — compact single-row toolbar */}
        <div className="grid grid-cols-5 gap-1.5">
          <button
            type="button"
            onClick={() => setQuickItemOpen(true)}
            className="flex h-10 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-600 transition hover:border-slate-300 hover:bg-slate-100 active:scale-[0.96]"
          >
            <Zap className="h-3.5 w-3.5 shrink-0" />
            صنف سريع
          </button>
          <button
            type="button"
            onClick={() => setDiscountTarget({ scope: "TOTAL" })}
            className="flex h-10 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-600 transition hover:border-slate-300 hover:bg-slate-100 active:scale-[0.96]"
          >
            <BadgePercent className="h-3.5 w-3.5 shrink-0" />
            خصم الفاتورة
          </button>
          <button
            type="button"
            onClick={handleHoldClick}
            className="relative flex h-10 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-600 transition hover:border-slate-300 hover:bg-slate-100 active:scale-[0.96]"
          >
            <Pause className="h-3.5 w-3.5 shrink-0" />
            تعليق
            {openOrdersCount > 0 && (
              <span className="absolute -end-1.5 -top-1.5 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-black text-white">
                {openOrdersCount}
              </span>
            )}
          </button>
          <button
            type="button"
            disabled={empty}
            onClick={handleHoldClick}
            title="تسجيل الطلب كمفتوح لاستكماله لاحقاً من صفحة الطلبات"
            className="flex h-10 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-600 transition hover:border-slate-300 hover:bg-slate-100 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ClipboardList className="h-3.5 w-3.5 shrink-0" />
            طلب مفتوح
          </button>
          <button
            type="button"
            disabled={empty}
            onClick={handleClearInvoice}
            onMouseLeave={() => { if (confirmClear) { if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current); setConfirmClear(false); } }}
            className={`flex h-10 items-center justify-center gap-1 rounded-lg border text-xs font-bold transition active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 ${
              confirmClear
                ? "border-rose-300 bg-rose-500 text-white hover:bg-rose-600"
                : "border-slate-200 bg-white text-rose-600 hover:border-rose-300 hover:bg-rose-50"
            }`}
          >
            <XCircle className="h-3.5 w-3.5 shrink-0" />
            {confirmClear ? "تأكيد الحذف" : "إلغاء"}
          </button>
        </div>
      </footer>

      {discountTarget && (
        <DiscountModal
          scope={discountTarget.scope}
          index={discountTarget.index}
          onClose={() => setDiscountTarget(null)}
        />
      )}

      {quickItemOpen && <QuickItemModal onClose={() => setQuickItemOpen(false)} />}

      {adminSession && typeof lineEditTarget === "number" && (
        <AdminLineEditModal key={lineEditTarget} />
      )}
    </section>
  );
}
