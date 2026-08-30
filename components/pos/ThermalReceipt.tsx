"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CompletedInvoice, PaymentMethod } from "@/types/pos.types";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { invoiceReference } from "@/lib/salesLedger";
import { buildJordanQrBase64, renderJordanQrSvg } from "@/lib/qrGenerator";
import type { ReceiptPaperWidth } from "@/lib/deviceHardware";
import { useDefaultPrintTemplate } from "@/hooks/useDefaultPrintTemplate";
import type { ReceiptSectionId } from "@/types/printTemplates";
import { formatShiftDateTime } from "@/lib/dateTime";
import { formatProductDisplayName } from "@/lib/productDisplayName";

const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  CASH: "نقداً",
  VISA: "بطاقة",
  CLIQ: "كليك",
  SPLIT: "نقد + بطاقة",
  DEBT: "ذمم",
};

// Typography system — corporate "Al Burj Establishment" identity on 80mm
// paper. Thermal printers are low-DPI (203dpi) and often default to faint
// gray; every glyph is therefore PITCH BLACK, bold, and at least 10px so it
// prints crisp and legible. Structural borders are solid 2px black rules
// (never dotted gray), and every money figure is tabular + tight-tracked.
const MONEY = "tabular-nums tracking-tight";
const META = "text-[10px] leading-tight font-bold text-black";
const CELL = "border-2 border-black";
const CELL_SOLID = "border-2 border-black bg-black text-white";

/**
 * 80mm thermal receipt. Strictly hidden on screen (`hidden print:block`)
 * and only rendered to the printer when a checkout completes. Engineered for
 * pure B/W print fidelity: force exact color-adjust, grayscale output and
 * legibility optimization, constrained to the printable 76mm width.
 *
 * Phase 2 (Al Burj Establishment): professional corporate layout — invoice
 * number block under the masthead, a customer strip (name + phone) whenever a
 * customer is assigned, a delivery-fee line in the ledger, and the cashier
 * name printed with the payment meta.
 */
export default function ThermalReceipt({
  invoice,
  paperWidth = 80,
  screenVisible = false,
}: {
  invoice: CompletedInvoice | null;
  paperWidth?: ReceiptPaperWidth;
  screenVisible?: boolean;
}) {
  const barcodeRef = useRef<SVGSVGElement | null>(null);
  const [fiscalQrSvg, setFiscalQrSvg] = useState("");
  // Dynamic tenant branding: every store prints its own name, logo, address
  // and custom receipt messages (fall back to the classic defaults).
  const currentStore = usePosStore((s) => s.currentStore);
  const template = useDefaultPrintTemplate("RECEIPT", currentStore?.id);
  const branches = usePosStore((s) => s.branches);
  const terminals = usePosStore((s) => s.terminals);
  const activeBranchId = usePosStore((s) => s.activeBranchId);
  const activeTerminalId = usePosStore((s) => s.activeTerminalId);

  useEffect(() => {
    if (!invoice || !barcodeRef.current) return;
    let cancelled = false;
    void import("jsbarcode").then(({ default: JsBarcode }) => {
      if (cancelled || !barcodeRef.current) return;
      try {
        JsBarcode(barcodeRef.current, invoice.syncId, {
          format: "CODE128",
          width: 1.6,
          height: 36,
          displayValue: false,
          margin: 0,
        });
      } catch {
        // Never let a barcode failure break the print job.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [invoice]);

  // The fiscal QR is computed off the heavy `qrcode` library (lazy-loaded)
  // only when a completed invoice actually needs one, so the POS bundle
  // stays free of it during the whole register session. The render path
  // gates on `showFiscalQr`, so a stale value here is never displayed.
  useEffect(() => {
    if (!invoice) return;
    const taxNumber = currentStore?.taxNumber?.trim() || "";
    const isSettlement = Boolean(invoice.isSettlement);
    const isReturn = invoice.total < 0;
    const showFiscal =
      Math.abs(invoice.tax) > 0 &&
      !isSettlement &&
      Boolean(taxNumber) &&
      !isReturn &&
      invoice.total >= 0;
    if (!showFiscal) return;
    let cancelled = false;
    const content = invoice.istdQr
      ? invoice.istdQr
      : buildJordanQrBase64({
          sellerName: currentStore?.name?.trim() || "متجر التجزئة",
          taxNumber,
          timestamp: invoice.completed_at,
          total: invoice.total,
          tax: invoice.tax,
        });
    void renderJordanQrSvg(content).then((svg) => {
      if (!cancelled) setFiscalQrSvg(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [invoice, currentStore]);

  if (!invoice) return null;

  const isSettlement = Boolean(invoice.isSettlement);
  const isReturn = invoice.total < 0;
  // Jordan ISTD: the fiscal QR is only lawful on a finalized sale. Parked /
  // OPEN / proforma documents must render as a proforma slip (no QR). Live
  // checkout documents are always finalized, so this is defense-in-depth.
  const isFinalized = invoice.isFinalized !== false;
  const isLoyaltyEarning =
    currentStore?.loyaltyEnabled !== false && Boolean(invoice.customerId || invoice.customerName);
  const pointsEarned =
    isLoyaltyEarning && (currentStore?.pointsPerSpend ?? 1) > 0
      ? Math.floor(Math.max(0, invoice.total) / (currentStore?.pointsPerSpend ?? 1))
      : 0;
  // Line totals/subtotal/tax already carry the return sign (negative qty),
  // so render them as-is instead of re-negating into inconsistent signs.
  const money = (v: number): string => formatMoney(v);

  const storeName = currentStore?.name?.trim() || "متجر التجزئة";
  // Fiscal VAT: per-store percent (0 = tax-free) and the tax number embedded
  // in the legally-compliant Smart QR. Both must be set for the QR to print.
  const taxNumber = currentStore?.taxNumber?.trim() || "";
  const showTaxBreakdown = Math.abs(invoice.tax) > 0 && !isSettlement;
  const showFiscalQr =
    isFinalized && showTaxBreakdown && Boolean(taxNumber) && !isReturn && invoice.total >= 0;
  // Official ISTD QR wins once JoFotara clears the invoice; otherwise the
  // locally-built TLV QR (same payload fields) keeps the receipt compliant.
  // The SVG itself is built lazily in an effect (see above).

  const logoUrl = currentStore?.logoUrl?.trim() || "";
  const address = currentStore?.address?.trim() || "";
  const phone = currentStore?.phone?.trim() || "";
  const receiptHeader = currentStore?.receiptHeader?.trim() || "";
  const receiptFooter = currentStore?.receiptFooter?.trim() || "شكراً لزيارتكم";
  const contactLine = [address, phone].filter(Boolean).join(" • ");

  // Merchant design choices (Store Settings -> Receipt Customization). The
  // preview in the settings page mirrors exactly these three toggles and the
  // compact spacing switch.
  const visibleSections = new Set(template.sections.filter((section) => section.visible).map((section) => section.id));
  const sectionVisible = (id: ReceiptSectionId) => visibleSections.has(id);
  const sectionOrder = new Map(template.sections.map((section, index) => [section.id, index]));
  const firstVisibleSection = template.sections.find((section) => section.visible)?.id;
  const orderedSection = (id: ReceiptSectionId): CSSProperties => ({
    order: sectionOrder.get(id) ?? template.sections.length,
  });
  const showCashierTime = template.showCashierTime;
  const showTaxNumber = template.showTaxNumber;
  const showFooterCodes = sectionVisible("codes");
  const compact = template.density === "compact";
  const comfortable = template.density === "comfortable";
  // Vertical rhythm: standard spacing by default, tighter when compact.
  const divider = compact ? "pt-1.5 mt-1.5" : comfortable ? "pt-4 mt-4" : "pt-2.5 mt-2.5";
  const stackGap = compact ? "space-y-0.5" : comfortable ? "space-y-2" : "space-y-1";
  const totalPad = compact ? "py-2" : comfortable ? "py-4" : "py-3";
  const itemPad = compact ? "py-1" : comfortable ? "py-2.5" : "py-1.5";
  const sectionDivider = (id: ReceiptSectionId): string => {
    if (id === firstVisibleSection || template.dividerStyle === "none") return "";
    const border = template.dividerStyle === "solid"
      ? "border-t-2 border-solid border-black"
      : "border-t border-dashed border-black";
    return `${divider} ${border}`;
  };

  const invoiceTitle = !isFinalized
    ? "فاتورة مبدئية / مفتوحة"
    : isSettlement
      ? "سند قبض ذمة"
      : isReturn
        ? "فاتورة مرتجع"
        : "فاتورة مبيعات";

  const grandTotalLabel = isSettlement ? "المبلغ المقبوض" : "الإجمالي";

  const reference = invoice.invoiceNumber?.trim() || invoiceReference(invoice.syncId);
  const customer = invoice.customerName?.trim();
  const customerPhone = invoice.customerPhone?.trim() || "";
  const showCustomer = Boolean(customer);
  const invoiceBranchId = invoice.branchId ?? activeBranchId;
  const invoiceTerminalId = invoice.terminalId ?? activeTerminalId;
  const fullItemColumns = template.itemColumnMode === "full" && template.paperWidth === 80;
  const tableHeaderClass = template.tableHeaderStyle === "dark"
    ? CELL_SOLID
    : template.tableHeaderStyle === "outline"
      ? "border-y-2 border-black"
      : "border-b border-black";
  const summaryTableClass = template.summaryStyle === "grid"
    ? "border-2 border-black"
    : template.summaryStyle === "lines"
      ? "border-y-2 border-black"
      : "";
  const summaryCellClass = template.summaryStyle === "grid" ? CELL : "";
  const totalStyleClass = template.totalStyle === "dark"
    ? "bg-black text-white px-2"
    : template.totalStyle === "boxed"
      ? "border-2 border-black px-2"
      : "border-y-2 border-black px-1";
  const totalTextClass = template.totalStyle === "dark" ? "text-white" : "text-black";
  const summaryRowClass = template.summaryStyle === "lines" ? "border-b border-black last:border-b-0" : "";

  return (
    <div
      id="thermal-receipt"
      dir="rtl"
      lang="ar"
      data-paper-width={template.paperWidth || paperWidth}
      style={
        {
          "--receipt-width": `${template.paperWidth || paperWidth}mm`,
          "--receipt-font-scale": template.fontScale,
          width: screenVisible ? `${template.paperWidth || paperWidth}mm` : undefined,
          maxWidth: screenVisible ? "100%" : undefined,
          printColorAdjust: "exact",
          WebkitPrintColorAdjust: "exact",
          textRendering: "optimizeLegibility",
        } as CSSProperties
      }
      className={`${screenVisible ? "flex flex-col overflow-hidden p-2" : "hidden"} bg-white font-sans text-[calc(11px*var(--receipt-font-scale,1))] leading-snug text-black print:m-0 print:mx-auto print:flex print:flex-col print:overflow-hidden print:bg-white print:grayscale print:p-2`}
    >
      {/* ---------------------------------------------------------------- */}
      {/* Masthead — corporate double rule framing the store identity */}
      {/* ---------------------------------------------------------------- */}
      {sectionVisible("branding") && <section style={orderedSection("branding")} className={sectionDivider("branding")}>
        <div className="border-y-2 border-black py-2 text-center">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className={`mx-auto mb-1.5 w-auto max-w-[60%] object-contain ${template.logoSize === "small" ? "max-h-7" : template.logoSize === "large" ? "max-h-16" : "max-h-10"}`}
            />
          )}
          <p className="text-lg font-black leading-tight tracking-tight">{storeName}</p>
          {contactLine && <p className={`${META} mt-1`}>{contactLine}</p>}
          {template.showBranchTerminal && (invoiceBranchId || invoiceTerminalId) ? (
            <p className={`${META} mt-0.5`}>
              {branches.find((b) => b.id === invoiceBranchId)?.name ?? ""}
              {invoiceBranchId && invoiceTerminalId ? " • " : ""}
              {(terminals ?? []).find((t) => t.id === invoiceTerminalId)?.name ?? ""}
            </p>
          ) : null}
        </div>
        {receiptHeader && <p className="mt-2 text-center text-[13px] font-black">{receiptHeader}</p>}
      </section>}

      {/* Document title + invoice number — the corporate block */}
      {sectionVisible("document") && <section style={orderedSection("document")} className={sectionDivider("document")}>
        {!isFinalized && (
          <p className="mx-auto mt-2 w-fit rounded-sm border-2 border-black px-2 py-1 text-center text-[12px] font-black leading-snug">
            فاتورة مبدئية (غير نهائية) — ليست فاتورة ضريبية
          </p>
        )}
        <p
          className={`mt-2 text-center text-[11px] font-black tracking-[0.25em] ${isReturn || isSettlement ? "pr-[0.25em]" : ""}`}
        >
          {invoiceTitle}
        </p>
        <div className="mx-auto mt-1 flex w-fit items-center gap-1.5 rounded-sm border-2 border-black px-2 py-1">
          <span className="text-[10px] font-bold tracking-wider text-black">رقم الفاتورة</span>
          <span dir="ltr" className={`text-[13px] font-black ${MONEY}`}>{reference}</span>
        </div>

        {isReturn && invoice.originalInvoiceId && (
          <p className={`${META} ${MONEY} mt-1 text-center`}>
            مرجع الفاتورة الأصلية: {invoiceReference(invoice.originalInvoiceId)}
          </p>
        )}
      </section>}

      {/* Date / time / shift meta — two-column grid */}
      {sectionVisible("meta") && <section style={orderedSection("meta")} className={sectionDivider("meta")}>
        {showCashierTime && (
          <div className="mb-1 flex items-center justify-between gap-x-3">
            <span className={META}>التاريخ والوقت</span>
            <span className={`${META} ${MONEY}`}>{formatShiftDateTime(invoice.completed_at)}</span>
          </div>
        )}
        <div className="flex items-center justify-between gap-x-3">
          <span className={META}>الوردية</span>
          <span className={`${META} ${MONEY}`}>#{invoice.shiftId.slice(0, 8)}</span>
        </div>
        {showCashierTime && invoice.cashierName && (
          <div className="flex items-center justify-between gap-x-3">
            <span className={META}>الكاشير</span>
            <span className={`${META} font-black`}>{invoice.cashierName}</span>
          </div>
        )}
      </section>}

      {/* Customer strip — printed for every assigned customer (name + phone) */}
      {sectionVisible("customer") && showCustomer && (
        <section style={orderedSection("customer")} className={`${sectionDivider("customer")} rounded-sm border-2 border-black px-2 py-1.5`}>
          <div className="flex items-center justify-between gap-x-3">
            <span className="text-[10px] font-bold tracking-wide text-black">العميل</span>
            <span className="text-[12px] font-black">{customer}</span>
          </div>
          {template.showCustomerPhone && customerPhone && (
            <div className="mt-0.5 flex items-center justify-between gap-x-3">
              <span className="text-[10px] font-bold tracking-wide text-black">الهاتف</span>
              <span dir="ltr" className={`text-[11px] font-black ${MONEY}`}>{customerPhone}</span>
            </div>
          )}
        </section>
      )}

      {/* B2B pricing strip (Phase 4) — the account the sale was priced for */}
      {!isSettlement && invoice.b2bAccountName && (
        <section className="mt-1 rounded-sm border border-dashed border-black px-2 py-1 text-[10px] font-black leading-4 text-black">
          حساب أعمال: {invoice.b2bAccountName}
          {typeof invoice.b2bMarkupPct === "number" && invoice.b2bMarkupPct > 0
            ? ` — تسعير خاص +${invoice.b2bMarkupPct}%`
            : ""}
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Body */}
      {/* ---------------------------------------------------------------- */}
      {isSettlement ? (
        sectionVisible("items") && <section style={orderedSection("items")} className={`${sectionDivider("items")} ${stackGap} text-[11px]`}>
          <div className="flex items-center justify-between">
            <span className="font-bold text-black">الزبون</span>
            <span className="font-black">{invoice.customerName}</span>
          </div>
          {showCashierTime && invoice.cashierName && (
            <div className="flex items-center justify-between">
              <span className="font-bold text-black">المستلم</span>
              <span className="font-black">{invoice.cashierName}</span>
            </div>
          )}
        </section>
      ) : (
        <>
          {/* Strict monetary columns: quantity never hides inside the item description. */}
          {sectionVisible("items") && <section style={orderedSection("items")} className={sectionDivider("items")}><table className={`w-full table-fixed border-collapse ${template.itemStyle === "grid" ? "border-2 border-black" : ""}`}>
            <colgroup>
              <col />
              {fullItemColumns && <col className="w-[20%]" />}
              <col className="w-[14%]" />
              <col className="w-[23%]" />
            </colgroup>
            <thead>
              <tr className={summaryRowClass}>
                <th className={`${tableHeaderClass} px-1 py-1 text-right text-[10px] font-black`}>
                  الصنف
                </th>
                {fullItemColumns && <th className={`${tableHeaderClass} px-0.5 py-1 text-center text-[9px] font-black`}>السعر</th>}
                <th className={`${tableHeaderClass} px-0.5 py-1 text-center text-[9px] font-black`}>
                  الكمية
                </th>
                <th className={`${tableHeaderClass} px-1 py-1 text-left text-[10px] font-black`}>
                  الإجمالي
                </th>
              </tr>
            </thead>
            <tbody>
              {invoice.items.map((item, i) => {
                const discountHint = item.discount ? `خصم ${formatMoney(item.discount)}` : "";
                const taxHint =
                  (item.taxPercent ?? 0) > 0
                    ? `ضريبة ${item.taxPercent}% ${item.taxIncluded ? "شاملة" : "مضافة"}`
                    : "معفى";
                return (
                  <tr key={i} className={`${template.itemStyle === "lines" ? "border-b border-dashed border-black" : ""} ${template.zebraRows && i % 2 === 1 ? "bg-black/10" : ""}`}>
                    <td className={`${template.itemStyle === "grid" ? CELL : ""} ${itemPad} px-1 align-top text-right`}>
                      <p className="break-words text-[11px] font-bold leading-snug">
                        {template.showLineNumbers ? `${i + 1}. ` : ""}
                        {formatProductDisplayName(item.name, item.variantLabel)}
                      </p>
                      {!fullItemColumns && <p className={`${META} ${MONEY} mt-0.5`}>سعر الوحدة {formatMoney(item.unitPrice)}</p>}
                      {template.showItemDiscount && discountHint && <p className={`${META} mt-0.5`}>{discountHint}</p>}
                      {template.showItemTax && <p className={`${META} mt-0.5`}>{taxHint}</p>}
                      {template.showItemBarcode && item.barcode && <p dir="ltr" className={`${META} mt-0.5`}>{item.barcode}</p>}
                    </td>
                    {fullItemColumns && <td dir="ltr" className={`${template.itemStyle === "grid" ? CELL : ""} ${itemPad} px-0.5 text-center align-top text-[10px] font-bold ${MONEY}`}>{formatMoney(item.unitPrice)}</td>}
                    <td dir="ltr" className={`${template.itemStyle === "grid" ? CELL : ""} ${itemPad} px-0.5 text-center align-top text-[11px] font-black ${MONEY}`}>
                      {Math.round(item.qty / (item.unitMultiplier || 1))}
                      {template.showItemUnit && <span dir="rtl" className="mt-0.5 block text-[8px] font-bold">{item.unitName}</span>}
                    </td>
                    <td className={`${template.itemStyle === "grid" ? CELL : ""} ${itemPad} px-1 align-top text-left`}>
                      <p className={`whitespace-nowrap text-[11px] font-black ${MONEY}`}>
                        {money(item.lineTotal)}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></section>}

          {/* Mini-ledger — subtotal, tax, discount, delivery fee (strict grid) */}
          {sectionVisible("summary") && <section style={orderedSection("summary")} className={sectionDivider("summary")}><table className={`w-full border-collapse text-[11px] ${summaryTableClass}`}>
            <tbody>
              <tr>
                <td className={`${summaryCellClass} px-1 py-1 font-bold text-black`}>الصافي قبل الضريبة</td>
                <td className={`${summaryCellClass} px-1 py-1 text-left font-black ${MONEY}`}>{money(invoice.subtotal)}</td>
              </tr>
              {showTaxBreakdown ? (
                <tr className={summaryRowClass}>
                  <td className={`${summaryCellClass} px-1 py-1 font-bold text-black`}>ضريبة المنتجات</td>
                  <td className={`${summaryCellClass} px-1 py-1 text-left font-black ${MONEY}`}>{money(invoice.tax)}</td>
                </tr>
              ) : (
                invoice.tax > 0 && (
                  <tr className={summaryRowClass}>
                    <td className={`${summaryCellClass} px-1 py-1 font-bold text-black`}>الضريبة</td>
                    <td className={`${summaryCellClass} px-1 py-1 text-left font-black ${MONEY}`}>{money(invoice.tax)}</td>
                  </tr>
                )
              )}
              {invoice.discount > 0 && (
                <tr className={summaryRowClass}>
                  <td className={`${summaryCellClass} px-1 py-1 font-bold text-black`}>الخصم</td>
                  <td className={`${summaryCellClass} px-1 py-1 text-left font-black ${MONEY}`}>-{formatMoney(invoice.discount)}</td>
                </tr>
              )}
              {Number(invoice.deliveryFee) > 0 && (
                <tr className={summaryRowClass}>
                  <td className={`${summaryCellClass} px-1 py-1 font-bold text-black`}>رسوم التوصيل</td>
                  <td className={`${summaryCellClass} px-1 py-1 text-left font-black ${MONEY}`}>{money(invoice.deliveryFee ?? 0)}</td>
                </tr>
              )}
            </tbody>
          </table></section>}
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The Grand Total Spectacle — heavy frame, massive black figure */}
      {/* ---------------------------------------------------------------- */}
      {sectionVisible("total") && <section style={orderedSection("total")} className={`${sectionDivider("total")} ${totalPad} ${totalStyleClass}`}>
        <div className="flex items-end justify-between gap-x-3">
          <div className="min-w-0 text-right">
            <p className={`text-[11px] font-black tracking-[0.15em] ${totalTextClass}`}>{grandTotalLabel}</p>
            <p dir="ltr" style={{ fontSize: `${template.totalScale * 30}px` }} className={`mt-1 font-black leading-none ${MONEY}`}>
              {money(invoice.total)}
            </p>
          </div>
          {!isSettlement && invoice.discount > 0 && (
            <div className="shrink-0 pb-0.5 text-right">
              <p className={`text-[10px] font-bold ${totalTextClass}`}>الخصم</p>
              <p dir="ltr" className={`mt-0.5 text-[11px] font-black ${totalTextClass} ${MONEY}`}>
                -{formatMoney(invoice.discount)}
              </p>
            </div>
          )}
        </div>
      </section>}

      {/* Payment / loyalty meta — method, amount, change, cashier */}
      {sectionVisible("payment") && !isSettlement && (
        <section style={orderedSection("payment")} className={`${sectionDivider("payment")} ${stackGap} text-[11px]`}>
          <div className="flex items-center justify-between">
            <span className="font-bold text-black">طريقة الدفع</span>
            <span className="font-black">{PAYMENT_LABEL[invoice.paymentMethod]}</span>
          </div>
          {showCustomer && (
            <div className="flex items-center justify-between">
              <span className="font-bold text-black">الزبون</span>
              <span className="font-black">{customer}</span>
            </div>
          )}
          {invoice.change > 0 && (
            <div className="flex items-center justify-between">
              <span className="font-bold text-black">{isReturn ? "المُرجَع" : "الباقي"}</span>
              <span className={`font-black ${MONEY}`}>{money(invoice.change)}</span>
            </div>
          )}
          {!isReturn && pointsEarned > 0 && (
            <div className="flex items-center justify-between">
              <span className="font-bold text-black">نقاط الولاء المكتسبة</span>
              <span className={`font-black ${MONEY}`}>{pointsEarned} نقطة</span>
            </div>
          )}
          {invoice.cashierName && (
            <div className="flex items-center justify-between">
              <span className="font-bold text-black">الكاشير</span>
              <span className="font-black">{invoice.cashierName}</span>
            </div>
          )}
          {showTaxBreakdown && showTaxNumber && (
            <div className="flex items-center justify-between">
              <span className="font-bold text-black">الرقم الضريبي</span>
              <span className={`font-black ${MONEY}`} dir="ltr">
                {taxNumber}
              </span>
            </div>
          )}
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Footer codes — crisp, centered, deliberate negative space */}
      {/* ---------------------------------------------------------------- */}
      {showFooterCodes && (
        <section style={orderedSection("codes")} className={sectionDivider("codes")}>
          {template.showInvoiceBarcode && <div className={`flex justify-center ${compact ? "py-2" : "py-3"}`}>
            <svg ref={barcodeRef} data-invoice-barcode className="h-9" />
          </div>}
          {template.showInvoiceBarcode && <p className={`${META} ${MONEY} text-center`}>{invoice.syncId.slice(0, 8)}</p>}

          {template.showFiscalQr && showFiscalQr && (
            <div className="mx-auto mt-3 w-24 pb-1">
              <div
                data-fiscal-qr
                className="print:block"
                dangerouslySetInnerHTML={{ __html: fiscalQrSvg }}
              />
              <p className="mt-1 text-center text-[9px] font-bold tracking-wide text-black">
                رمز التحقق الضريبي (فيسكالي)
              </p>
            </div>
          )}
          {template.showFiscalQr && showFiscalQr && !invoice.istdQr && (
            <p className={`text-center text-[10px] font-bold text-black ${MONEY}`}>
              قيد الإرسال للمصلحة
            </p>
          )}
        </section>
      )}

      {sectionVisible("footer") && <section style={orderedSection("footer")} className={sectionDivider("footer")}><p className={`text-center text-[13px] font-black ${MONEY}`}>{receiptFooter}</p></section>}
    </div>
  );
}
