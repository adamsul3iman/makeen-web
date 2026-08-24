"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BadgePercent, Barcode, Building2, ClipboardList, CreditCard, Pause, Pencil, ReceiptText, X, XCircle, Zap } from "lucide-react";
import { anyPosModalOpen, usePosStore } from "@/store/usePosStore";
import { useOrdersStore } from "@/store/useOrdersStore";
import { formatMoney } from "@/lib/format";
import { withB2BMarkup } from "@/lib/saleMath";
import type { DiscountScope, LocalUnit, SaleItem } from "@/types/pos.types";
import { useDeviceHardware } from "@/hooks/useDeviceHardware";
import { scannerAcceptsSubmitKey } from "@/lib/deviceHardware";
import DiscountModal from "./DiscountModal";
import QuickItemModal from "./QuickItemModal";
import AdminLineEditModal from "./AdminLineEditModal";
import EntityCombobox from "@/components/shared/EntityCombobox";
import QuickCreateEntityModal from "@/components/shared/QuickCreateEntityModal";
import { useCustomerOptions } from "@/components/pos/useCustomerOptions";

/**
 * Unit chips (Phase 2): tap to re-price a cart line in another packaging
 * tier (حبة ⇄ كرتون). Quantity converts so the physical amount on the line
 * stays constant. Rendered only when the product has more than one active
 * unit, keeping single-unit products visually unchanged.
 */
const UnitChips = memo(function UnitChips({
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
  const activeId =
    item.unitId ??
    (units.find((u) => u.isDefaultSale) ?? units[0])?.id;
  return (
    <div className="mt-0.5 flex w-fit flex-wrap items-center gap-1">
      {units.map((unit) => {
        const isActive = unit.id === activeId;
        return (
          <button
            key={unit.id}
            type="button"
            onClick={() => {
              if (!isActive) onSetLineUnit(index, unit.id);
            }}
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-black leading-4 transition ${
              isActive
                ? "bg-primary text-primary-foreground"
                : "border border-slate-200 bg-slate-50 text-slate-500 hover:border-primary/40 hover:text-primary"
            }`}
            title={`${unit.unitName} — ${formatMoney(unit.sellingPrice)}`}
          >
            {unit.unitName}
          </button>
        );
      })}
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
  onSetDiscountTarget,
}: {
  item: SaleItem;
  index: number;
  onSetDiscountTarget: (target: { scope: DiscountScope; index?: number }) => void;
}) {
  const adminSession = usePosStore((s) => s.adminSession);
  const setLineEditTarget = usePosStore((s) => s.setLineEditTarget);
  const updateQty = usePosStore((s) => s.updateQty);
  const removeItem = usePosStore((s) => s.removeItem);
  // Stable refs: raw arrays are selected, filtering happens in render.
  const units = usePosStore((s) => s.productUnits[item.productId]);
  const setLineUnit = usePosStore((s) => s.setLineUnit);

  const activeUnits = (units ?? []).filter((u) => u.isActive);

  return (
    <tr className="border-b border-slate-100/80 transition-colors duration-100 hover:bg-slate-50/80">
      <td className="py-1.5 ps-3 pe-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-bold leading-tight text-slate-800">{item.name}</span>
            {item.barcode && item.barcode !== item.variantLabel && (
              <span className="font-mono text-xs text-slate-400">{item.barcode}</span>
            )}
          </div>
          {item.variantLabel && (
            <span className="text-xs font-bold text-primary">{item.variantLabel}</span>
          )}
          {activeUnits.length > 1 && (
            <UnitChips
              units={activeUnits}
              item={item}
              index={index}
              onSetLineUnit={setLineUnit}
            />
          )}
          {item.discount ? (
            <span className="inline-flex w-fit items-center rounded bg-primary/10 px-1.5 py-0.5 text-xs font-black text-primary">
              خصم
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-1.5 px-1 text-center">
        <div className="inline-flex items-center gap-0.5">
          <button
            type="button"
            aria-label="إنقاص الكمية"
            onClick={() => updateQty(index, item.qty - 1)}
            className="grid h-11 w-11 place-items-center rounded-lg border border-slate-200 text-sm font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 active:scale-95"
          >
            −
          </button>
          <input
            type="text"
            inputMode="numeric"
            readOnly
            value={item.qty}
            className="w-7 text-center text-sm font-black tabular-nums text-slate-800 outline-none"
          />
          <button
            type="button"
            aria-label="زيادة الكمية"
            onClick={() => updateQty(index, item.qty + 1)}
            className="grid h-11 w-11 place-items-center rounded-lg border border-green-200 text-sm font-bold text-green-600 transition hover:bg-green-50 hover:text-green-700 active:scale-95"
          >
            +
          </button>
        </div>
      </td>
      <td className="whitespace-nowrap py-1.5 px-2 text-center text-sm tabular-nums text-slate-600">
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
      <td className="whitespace-nowrap py-1.5 px-2 text-center text-sm font-black tabular-nums text-slate-900">
        {formatMoney(item.lineTotal)}
      </td>
      <td className="py-1.5 pe-3 ps-2 text-center">
        <button
          type="button"
          aria-label="حذف الصنف"
          onClick={() => removeItem(index)}
          className="grid h-11 w-11 place-items-center rounded-lg text-slate-300 transition hover:bg-rose-50 hover:text-rose-500 active:scale-95"
        >
          <XCircle className="h-5 w-5" />
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
    <div className="border-b border-slate-100 px-3 py-1.5">
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

  // Auto-reset confirm state after 2s or when cart empties
  useEffect(() => {
    if (empty && confirmClear) setConfirmClear(false);
  }, [empty, confirmClear]);

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
    if (!omnibarInput.trim()) return;
    if (anyPosModalOpen(usePosStore.getState())) {
      omnibarRef.current?.focus();
      return;
    }
    scanBarcode(omnibarInput);
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
      <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-100/60 px-3 pt-2">
        {cartSlots.map((slot, idx) => {
          const isActive = idx === activeCartIndex;
          const count = isActive ? items.length : slot.items.length;
          return (
            <div key={slot.id} className="group relative flex">
              <button
                type="button"
                onClick={() => switchCart(idx)}
                className={`flex h-11 items-center gap-1.5 rounded-t-xl border border-b-0 px-3 text-xs font-bold transition ${
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
      <form onSubmit={handleOmnibarSubmit} className="border-b border-slate-200 px-3 py-1.5">
        <div className="flex h-11 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2.5 shadow-inner transition-all focus-within:border-slate-300 focus-within:bg-white">
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
            className="min-w-0 flex-1 bg-transparent text-sm font-bold tracking-wider text-slate-800 outline-none placeholder:text-slate-400"
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
            <p className="text-base font-black text-slate-700">لا توجد أصناف بعد</p>
            <p className="max-w-60 text-sm font-semibold leading-relaxed text-slate-500">
              امسح باركوداً أو اضغط على صنف سريع لإضافته للفاتورة
            </p>
          </div>
        ) : (
          <table className="w-full table-fixed text-start">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[20%]" />
              <col className="w-[18%]" />
              <col className="w-[14%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur">
              <tr className="border-b border-slate-200 text-xs font-black uppercase tracking-wider text-slate-400">
                <th className="px-3 py-1.5">الصنف</th>
                <th className="px-2 py-1.5 text-center">الكمية</th>
                <th className="px-2 py-1.5 text-center">السعر</th>
                <th className="px-2 py-1.5 text-center">المجموع</th>
                <th className="pe-3 ps-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {displayItems.map((item, i) => (
                <CartRow
                  key={item.barcode || `p:${item.productId}`}
                  item={item}
                  index={i}
                  onSetDiscountTarget={setDiscountTarget}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="space-y-1 border-t border-slate-200 bg-slate-50/80 px-3 py-1.5">
        {activeB2BAccountName && b2bMarkupPct > 0 && (
          <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-black text-primary">
            <Building2 className="h-3.5 w-4 shrink-0" />
            <span className="flex-1 truncate">تسعير {activeB2BAccountName}</span>
            <span className="tabular-nums">+{b2bMarkupPct}%</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setQuickItemOpen(true)}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 px-3 text-xs font-bold text-primary transition hover:bg-primary/10 active:scale-[0.98]"
          >
            <Zap className="h-4 w-4 shrink-0" />
            صنف سريع
          </button>
          <button
            type="button"
            onClick={() => setDiscountTarget({ scope: "TOTAL" })}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 px-3 text-xs font-bold text-primary transition hover:bg-primary/10 active:scale-[0.98]"
          >
            <BadgePercent className="h-4 w-4 shrink-0" />
            خصم الفاتورة
          </button>
          <button
            type="button"
            onClick={clearDiscount}
            className={`flex h-11 items-center justify-center rounded-lg border border-rose-200 px-3 text-xs font-bold text-rose-600 transition hover:bg-rose-50 active:scale-[0.97] ${
              totals.discount > 0 ? "" : "invisible"
            }`}
          >
            إلغاء
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>الصافي</span>
          <span className="tabular-nums">{formatMoney(totals.subtotal)}</span>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>الضريبة</span>
          <span className="tabular-nums">{formatMoney(totals.tax)}</span>
        </div>
        <div className={`flex items-center justify-between text-xs font-bold text-rose-600 ${totals.discount > 0 ? "" : "invisible"}`}>
          <span>الخصم</span>
          <span className="tabular-nums">-{formatMoney(totals.discount)}</span>
        </div>

        <button
          type="button"
          disabled={empty}
          onClick={openCheckout}
          className={`flex h-12 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 text-base font-black shadow-card transition-colors duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
            isReturnMode
              ? "bg-destructive text-destructive-foreground hover:bg-destructive-hover"
              : "bg-primary text-primary-foreground hover:bg-primary-hover"
          }`}
        >
          <CreditCard className="h-5 w-5 shrink-0" />
          {isReturnMode ? "إرجاع" : "دفع الفاتورة"}
          {!empty && (
            <span className="tabular-nums">• {formatMoney(totals.total)}</span>
          )}
        </button>

        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={handleHoldClick}
            className="relative flex h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 active:scale-[0.97]"
          >
            <Pause className="h-4 w-4 shrink-0" />
            تعليق
            {openOrdersCount > 0 && (
              <span className="absolute -top-1 -end-1 grid h-5 min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-xs font-black text-white">
                {openOrdersCount}
              </span>
            )}
          </button>
          <button
            type="button"
            disabled={empty}
            onClick={handleHoldClick}
            title="تسجيل الطلب كمفتوح لاستكماله لاحقاً من صفحة الطلبات"
            className="flex h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary/30 bg-primary/5 text-xs font-bold text-primary transition hover:border-primary/50 hover:bg-primary/10 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ClipboardList className="h-4 w-4 shrink-0" />
            طلب مفتوح
          </button>
          <button
            type="button"
            disabled={empty}
            onClick={handleClearInvoice}
            onMouseLeave={() => { if (confirmClear) { if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current); setConfirmClear(false); } }}
            className={`flex h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border text-xs font-bold transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 ${
              confirmClear
                ? "border-rose-300 bg-rose-500 text-white hover:bg-rose-600"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            <XCircle className="h-4 w-4 shrink-0" />
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
