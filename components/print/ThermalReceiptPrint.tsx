/**
 * Self-contained 80/58mm thermal receipt renderer.
 *
 * This is the print-time counterpart of the on-screen `ThermalReceipt`: it
 * reproduces the exact config-driven layout (sections/order, item columns,
 * summary/total styles, divider, density, zebra rows) but with ALL styling
 * carried inline in the returned document — no Tailwind, no host CSS. That is
 * what makes the printed slip byte-identically styled when it is dispatched to
 * the Electron silent bridge or the browser iframe (which load an isolated
 * HTML document with no access to the app stylesheet).
 *
 * The barcode and fiscal QR arrive as pre-rendered SVG strings (computed
 * client-side before dispatch), so this renderer is a pure function of its
 * props — safe under `renderToString`.
 */
import type { CompletedInvoice, PaymentMethod } from "@/types/pos.types";
import type {
  ReceiptSectionId,
  ReceiptTemplateConfig,
} from "@/types/printTemplates";
import { formatMoney } from "@/lib/format";
import { formatShiftDateTime } from "@/lib/dateTime";
import { formatProductDisplayName } from "@/lib/productDisplayName";
import { invoiceReference } from "@/lib/salesLedger";

const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  CASH: "نقداً",
  VISA: "بطاقة",
  CLIQ: "كليك",
  SPLIT: "نقد + بطاقة",
  DEBT: "ذمم",
};

export interface ReceiptPrintStore {
  name?: string;
  logoUrl?: string;
  address?: string;
  phone?: string;
  receiptHeader?: string;
  receiptFooter?: string;
  taxNumber?: string;
}

export interface ThermalReceiptPrintProps {
  invoice: CompletedInvoice;
  config: ReceiptTemplateConfig;
  store?: ReceiptPrintStore;
  /** Optional on-screen reference to differentiate the two copies. */
  branchName?: string;
  terminalName?: string;
  /** Pre-rendered CODE128 SVG string (or null to omit). */
  barcodeSvg?: string | null;
  /** Pre-rendered Jordan fiscal QR SVG string (or null to omit). */
  qrSvg?: string | null;
}

export default function ThermalReceiptPrint({
  invoice,
  config,
  store,
  branchName,
  terminalName,
  barcodeSvg,
  qrSvg,
}: ThermalReceiptPrintProps) {
  const mm = config.paperWidth === 58 ? 58 : 80;
  const isSettlement = Boolean(invoice.isSettlement);
  const isReturn = invoice.total < 0;
  // Jordan ISTD: the fiscal QR is only lawful on a finalized sale. Parked /
  // OPEN / proforma documents must render as a proforma slip (no QR).
  const isFinalized = invoice.isFinalized !== false;
  const showBreakdown = Math.abs(invoice.tax) > 0 && !isSettlement;
  const showFiscalQr =
    isFinalized &&
    showBreakdown &&
    Boolean(store?.taxNumber?.trim()) &&
    !isReturn &&
    invoice.total >= 0;
  const money = (v: number | undefined): string => formatMoney(Number.isFinite(v) ? (v as number) : 0);

  const storeName = store?.name?.trim() || "متجر التجزئة";
  const taxNumber = store?.taxNumber?.trim() || "";
  const logoUrl = store?.logoUrl?.trim() || "";
  const address = store?.address?.trim() || "";
  const phone = store?.phone?.trim() || "";
  const receiptHeader = store?.receiptHeader?.trim() || "";
  const receiptFooter = store?.receiptFooter?.trim() || "شكراً لزيارتكم";
  const contactLine = [address, phone].filter(Boolean).join(" • ");

  const visibleSections = new Set(
    config.sections.filter((s) => s.visible).map((s) => s.id),
  );
  const show = (id: ReceiptSectionId) => visibleSections.has(id);
  const order = new Map(config.sections.map((s, i) => [s.id, i]));

  const compact = config.density === "compact";
  const comfortable = config.density === "comfortable";
  const stackGap = compact ? "2px" : comfortable ? "8px" : "4px";
  const dividerTop = compact ? "6px" : comfortable ? "16px" : "10px";
  const dividerIsVisible = config.dividerStyle !== "none";

  const itemCellBorder = config.itemStyle === "grid" ? "border:2px solid #000" : "";
  const rowBorder = config.itemStyle === "lines" ? "border-bottom:1px dashed #000" : "";
  const zebra = config.zebraRows ? "background:rgba(0,0,0,0.08)" : "";
  const summaryCellBorder = config.summaryStyle === "grid" ? "border:2px solid #000" : "";
  const summaryRowsBordered = config.summaryStyle !== "clean";
  const summaryTableBorder =
    config.summaryStyle === "lines" ? "2px solid #000" : "none";
  const totalWrap =
    config.totalStyle === "dark"
      ? "background:#000;color:#fff"
      : config.totalStyle === "boxed"
        ? "border:2px solid #000"
        : "border-top:2px solid #000;border-bottom:2px solid #000";

  const headerCell = () => {
    if (config.tableHeaderStyle === "dark") return { background: "#000", color: "#fff" };
    if (config.tableHeaderStyle === "outline")
      return { borderTop: "2px solid #000", borderBottom: "2px solid #000" };
    return { borderBottom: "1px solid #000" };
  };
  const totalColor = config.totalStyle === "dark" ? "#fff" : "#000";
  const logoH = config.logoSize === "small" ? "28px" : config.logoSize === "large" ? "64px" : "40px";
  const fs = config.fontScale;

  const fullColumns = config.itemColumnMode === "full" && mm === 80;
  const title = !isFinalized
    ? "فاتورة مبدئية / مفتوحة"
    : isSettlement
      ? "سند قبض ذمة"
      : isReturn
        ? "فاتورة مرتجع"
        : "فاتورة مبيعات";
  const reference = invoice.invoiceNumber?.trim() || invoiceReference(invoice.syncId);
  const customer = invoice.customerName?.trim();
  const customerPhone = invoice.customerPhone?.trim() || "";

  const items = isSettlement
    ? null
    : invoice.items.map((item, i) => {
        const discountHint = item.discount ? `خصم ${formatMoney(item.discount)}` : "";
        const taxHint =
          (item.taxPercent ?? 0) > 0
            ? `ضريبة ${item.taxPercent}% ${item.taxIncluded ? "شاملة" : "مضافة"}`
            : "معفى";
        const itemPad = compact ? "4px" : comfortable ? "10px" : "6px";
        return (
          <tr key={i} style={{ ...(rowBorder ? { borderBottom: "1px dashed #000" } : {}), ...(i % 2 === 1 ? { background: zebra } : {}) }}>
            <td style={{ padding: `${itemPad} 4px`, verticalAlign: "top", textAlign: "right", lineHeight: "1.3", ...(itemCellBorder ? { border: itemCellBorder } : {}) }}>
              <div style={{ fontSize: `${11 * fs}px`, fontWeight: 700, overflowWrap: "break-word", wordBreak: "break-word" }}>
                {config.showLineNumbers ? `${i + 1}. ` : ""}
                {formatProductDisplayName(item.name, item.variantLabel)}
              </div>
              {!fullColumns && (
                <div style={{ fontSize: `${10 * fs}px`, fontWeight: 700, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                  سعر الوحدة {formatMoney(item.unitPrice)}
                </div>
              )}
              {config.showItemDiscount && discountHint && (
                <div style={{ fontSize: `${10 * fs}px`, fontWeight: 700, marginTop: 2 }}>{discountHint}</div>
              )}
              {config.showItemTax && (
                <div style={{ fontSize: `${10 * fs}px`, fontWeight: 700, marginTop: 2 }}>{taxHint}</div>
              )}
              {config.showItemBarcode && item.barcode && (
                <div dir="ltr" style={{ fontSize: `${10 * fs}px`, fontWeight: 700, marginTop: 2, textAlign: "right" }}>
                  {item.barcode}
                </div>
              )}
            </td>
            {fullColumns && (
              <td dir="ltr" style={{ padding: `${itemPad} 2px`, textAlign: "center", verticalAlign: "top", fontSize: `${10 * fs}px`, fontWeight: 700, fontVariantNumeric: "tabular-nums", ...(itemCellBorder ? { border: itemCellBorder } : {}) }}>
                {formatMoney(item.unitPrice)}
              </td>
            )}
            <td dir="ltr" style={{ padding: `${itemPad} 2px`, textAlign: "center", verticalAlign: "top", fontSize: `${11 * fs}px`, fontWeight: 900, fontVariantNumeric: "tabular-nums", ...(rowBorder ? {} : {}) }}>
              {Math.round(item.qty / (item.unitMultiplier || 1))}
              {config.showItemUnit && (
                <span dir="rtl" style={{ display: "block", marginTop: 2, fontSize: `${8 * fs}px`, fontWeight: 700 }}>
                  {item.unitName}
                </span>
              )}
            </td>
            <td style={{ padding: `${itemPad} 4px`, textAlign: "left", verticalAlign: "top", ...(itemCellBorder ? { border: itemCellBorder } : {}) }}>
              <span style={{ whiteSpace: "nowrap", fontSize: `${11 * fs}px`, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>
                {money(item.lineTotal)}
              </span>
            </td>
          </tr>
        );
      });

  const body = (
    <div id="thermal-receipt-print" dir="rtl" lang="ar" style={{ width: "100%", maxWidth: `${mm}mm`, margin: "0 auto", fontSize: `${11 * fs}px`, lineHeight: "1.35", color: "#000", background: "#fff" }}>
      {/* branding */}
      {show("branding") && (
        <section style={{ order: order.get("branding") }}>
          <div style={{ borderTop: "2px solid #000", borderBottom: "2px solid #000", padding: "8px 0", textAlign: "center" }}>
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" style={{ display: "block", maxWidth: "60%", maxHeight: logoH, objectFit: "contain", margin: "0 auto 6px" }} />
            )}
            <div style={{ fontSize: `${17 * fs}px`, fontWeight: 900, lineHeight: 1.15, letterSpacing: -0.3 }}>{storeName}</div>
            {contactLine && (
              <div style={{ fontSize: `${10 * fs}px`, fontWeight: 700, marginTop: 4 }}>{contactLine}</div>
            )}
            {config.showBranchTerminal && (invoice.branchId || invoice.terminalId) && (
              <div style={{ fontSize: `${10 * fs}px`, fontWeight: 700, marginTop: 2 }}>
                {branchName ?? ""}
                {branchName && terminalName ? " • " : ""}
                {terminalName ?? ""}
              </div>
            )}
          </div>
          {receiptHeader && (
            <div style={{ marginTop: 8, textAlign: "center", fontSize: `${13 * fs}px`, fontWeight: 900 }}>{receiptHeader}</div>
          )}
        </section>
      )}

      {/* document */}
      {show("document") && (
        <section style={{ order: order.get("document"), marginTop: !dividerIsVisible ? 4 : dividerTop }}>
          {!isFinalized && (
            <div style={{ margin: "2px 0 4px", border: "2px solid #000", borderRadius: 3, padding: "5px 6px", textAlign: "center", fontSize: `${12 * fs}px`, fontWeight: 900, lineHeight: 1.3 }}>
              فاتورة مبدئية (غير نهائية) — ليست فاتورة ضريبية
            </div>
          )}
          <div style={{ textAlign: "center", marginTop: 8, fontSize: `${11 * fs}px`, fontWeight: 900, letterSpacing: "0.25em" }}>{title}</div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "2px solid #000", borderRadius: 2, padding: "4px 8px" }}>
              <span style={{ fontSize: `${10 * fs}px`, fontWeight: 700, letterSpacing: 1 }}>رقم الفاتورة</span>
              <span dir="ltr" style={{ fontSize: `${13 * fs}px`, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{reference}</span>
            </div>
          </div>
          {isReturn && invoice.originalInvoiceId && (
            <div style={{ fontSize: `${10 * fs}px`, fontWeight: 700, marginTop: 4, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
              مرجع الفاتورة الأصلية: {invoiceReference(invoice.originalInvoiceId)}
            </div>
          )}
        </section>
      )}

      {/* meta */}
      {show("meta") && (
        <section style={{ order: order.get("meta"), marginTop: 4 }}>
          {config.showCashierTime && (
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: `${10 * fs}px`, fontWeight: 700 }}>التاريخ والوقت</span>
              <span style={{ fontSize: `${10 * fs}px`, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatShiftDateTime(invoice.completed_at)}</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: `${10 * fs}px`, fontWeight: 700 }}>الوردية</span>
            <span dir="ltr" style={{ fontSize: `${10 * fs}px`, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>#{invoice.shiftId.slice(0, 8)}</span>
          </div>
          {config.showCashierTime && invoice.cashierName && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: `${10 * fs}px`, fontWeight: 700 }}>الكاشير</span>
              <span style={{ fontSize: `${10 * fs}px`, fontWeight: 900 }}>{invoice.cashierName}</span>
            </div>
          )}
        </section>
      )}

      {/* customer */}
      {show("customer") && customer && (
        <section style={{ order: order.get("customer"), marginTop: 8, border: "2px solid #000", borderRadius: 3, padding: "6px 8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: `${10 * fs}px`, fontWeight: 700 }}>العميل</span>
            <span style={{ fontSize: `${12 * fs}px`, fontWeight: 900 }}>{customer}</span>
          </div>
          {config.showCustomerPhone && customerPhone && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
              <span style={{ fontSize: `${10 * fs}px`, fontWeight: 700 }}>الهاتف</span>
              <span dir="ltr" style={{ fontSize: `${11 * fs}px`, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{customerPhone}</span>
            </div>
          )}
        </section>
      )}

      {/* B2B strip */}
      {!isSettlement && invoice.b2bAccountName && (
        <div style={{ marginTop: 4, border: "1px dashed #000", borderRadius: 3, padding: "4px 8px", fontSize: `${10 * fs}px`, fontWeight: 900, lineHeight: 1.4 }}>
          حساب أعمال: {invoice.b2bAccountName}
          {typeof invoice.b2bMarkupPct === "number" && invoice.b2bMarkupPct > 0 ? ` — تسعير خاص +${invoice.b2bMarkupPct}%` : ""}
        </div>
      )}

      {/* items OR settlement block */}
      {isSettlement ? (
        show("items") && (
          <section style={{ order: order.get("items"), marginTop: 8, display: "flex", flexDirection: "column", gap: stackGap, fontSize: `${11 * fs}px` }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>الزبون {invoice.customerName}</div>
            {config.showCashierTime && invoice.cashierName && (
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>المستلم {invoice.cashierName}</div>
            )}
          </section>
        )
      ) : (
        show("items") && (
          <section style={{ order: order.get("items"), marginTop: 8 }}>
            <table dir="rtl" data-items style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup>
                <col />
                {fullColumns && <col style={{ width: "20%" }} />}
                <col style={{ width: "14%" }} />
                <col style={{ width: "23%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ textAlign: "right", padding: "4px", fontSize: `${10 * fs}px`, fontWeight: 900, ...headerCell() }}>الصنف</th>
                  {fullColumns && <th style={{ textAlign: "center", padding: "2px 4px", fontSize: `${9 * fs}px`, fontWeight: 900, ...headerCell() }}>السعر</th>}
                  <th style={{ textAlign: "center", padding: "2px 4px", fontSize: `${9 * fs}px`, fontWeight: 900, ...headerCell() }}>الكمية</th>
                  <th style={{ textAlign: "left", padding: "4px", fontSize: `${10 * fs}px`, fontWeight: 900, ...headerCell() }}>الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {items}
              </tbody>
            </table>
          </section>
        )
      )}

      {/* summary */}
      {!isSettlement && show("summary") && (
        <section style={{ order: order.get("summary"), marginTop: 8 }}>
          <table dir="rtl" style={{ width: "100%", borderCollapse: "collapse", fontSize: `${11 * fs}px`, borderTop: summaryTableBorder === "none" ? undefined : summaryTableBorder, borderBottom: summaryTableBorder === "none" ? undefined : summaryTableBorder }}>
            <tbody>
              <tr>
                <td style={{ padding: "4px", fontWeight: 700, font: "inherit", ...(summaryCellBorder ? { border: summaryCellBorder } : {}) }}>الصافي قبل الضريبة</td>
                <td style={{ padding: "4px", textAlign: "left", fontWeight: 900, fontVariantNumeric: "tabular-nums", ...(summaryCellBorder ? { border: summaryCellBorder } : {}) }}>{money(invoice.subtotal)}</td>
              </tr>
              <tr style={{ borderBottom: summaryRowsBordered ? "1px solid #000" : undefined }}>
                <td style={{ padding: "4px", fontWeight: 700, ...(summaryCellBorder ? { border: summaryCellBorder } : {}) }}>
                  {showBreakdown ? "ضريبة المنتجات" : invoice.tax > 0 ? "الضريبة" : null}
                </td>
                <td style={{ padding: "4px", textAlign: "left", fontWeight: 900, fontVariantNumeric: "tabular-nums", ...(summaryCellBorder ? { border: summaryCellBorder } : {}) }}>
                  {(showBreakdown || invoice.tax > 0) ? money(invoice.tax) : null}
                </td>
              </tr>
              {invoice.discount > 0 && (
                <tr style={{ borderBottom: summaryRowsBordered ? "1px solid #000" : undefined }}>
                  <td style={{ padding: "4px", fontWeight: 700, ...(summaryCellBorder ? { border: summaryCellBorder } : {}) }}>الخصم</td>
                  <td style={{ padding: "4px", textAlign: "left", fontWeight: 900, fontVariantNumeric: "tabular-nums", ...(summaryCellBorder ? { border: summaryCellBorder } : {}) }}>-{formatMoney(invoice.discount)}</td>
                </tr>
              )}
              {Number(invoice.deliveryFee) > 0 && (
                <tr style={{ borderBottom: summaryRowsBordered ? "1px solid #000" : undefined }}>
                  <td style={{ padding: "4px", fontWeight: 700, ...(summaryCellBorder ? { border: summaryCellBorder } : {}) }}>رسوم التوصيل</td>
                  <td style={{ padding: "4px", textAlign: "left", fontWeight: 900, fontVariantNumeric: "tabular-nums", ...(summaryCellBorder ? { border: summaryCellBorder } : {}) }}>{money(invoice.deliveryFee ?? 0)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {/* total */}
      {show("total") && (
        <section style={{ order: order.get("total"), marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", padding: `${compact ? "8px" : comfortable ? "16px" : "12px"} 4px`, ...(totalWrap ? { background: config.totalStyle === "dark" ? "#000" : undefined, color: config.totalStyle === "dark" ? "#fff" : undefined, border: config.totalStyle === "boxed" ? "2px solid #000" : config.totalStyle === "rules" ? undefined : undefined, borderTop: config.totalStyle === "rules" ? "2px solid #000" : undefined, borderBottom: config.totalStyle === "rules" ? "2px solid #000" : undefined } : {}) }}>
            <div style={{ textAlign: "right", minWidth: 0 }}>
              <div style={{ fontSize: `${11 * fs}px`, fontWeight: 900, letterSpacing: "0.15em", color: totalColor }}>{isSettlement ? "المبلغ المقبوض" : "الإجمالي"}</div>
              <div dir="ltr" style={{ fontSize: `${config.totalScale * 30}px`, fontWeight: 900, lineHeight: 1, marginTop: 4, color: totalColor, fontVariantNumeric: "tabular-nums" }}>
                {money(invoice.total)}
              </div>
            </div>
            {!isSettlement && invoice.discount > 0 && (
              <div style={{ textAlign: "right", flexShrink: 0, paddingBottom: 2, color: totalColor }}>
                <div style={{ fontSize: `${10 * fs}px`, fontWeight: 700 }}>الخصم</div>
                <div dir="ltr" style={{ fontSize: `${11 * fs}px`, fontWeight: 900, marginTop: 4, fontVariantNumeric: "tabular-nums", color: totalColor }}>-{formatMoney(invoice.discount)}</div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* payment */}
      {show("payment") && !isSettlement && (
        <section style={{ order: order.get("payment"), marginTop: 4, display: "flex", flexDirection: "column", gap: stackGap, fontSize: `${11 * fs}px` }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>طريقة الدفع <span style={{ fontWeight: 900 }}>{PAYMENT_LABEL[invoice.paymentMethod]}</span></div>
          {customer && <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>الزبون <span style={{ fontWeight: 900 }}>{customer}</span></div>}
          {invoice.change > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
              {isReturn ? "المُرجَع" : "الباقي"} <span style={{ fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{money(invoice.change)}</span>
            </div>
          )}
          {invoice.cashierName && (
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>الكاشير <span style={{ fontWeight: 900 }}>{invoice.cashierName}</span></div>
          )}
          {showBreakdown && config.showTaxNumber && (
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
              الرقم الضريبي <span dir="ltr" style={{ fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{taxNumber}</span>
            </div>
          )}
        </section>
      )}

      {/* codes */}
      {show("codes") && (
        <section style={{ order: order.get("codes"), marginTop: 4, textAlign: "center" }}>
          {config.showInvoiceBarcode && barcodeSvg && (
            <div style={{ display: "flex", justifyContent: "center", padding: compact ? "8px" : "12px" }}>
              <span dangerouslySetInnerHTML={{ __html: barcodeSvg }} />
            </div>
          )}
          {config.showInvoiceBarcode && (
            <div style={{ fontSize: `${10 * fs}px`, fontWeight: 700, fontVariantNumeric: "tabular-nums", textAlign: "center" }}>
              {invoice.syncId.slice(0, 8)}
            </div>
          )}
          {config.showFiscalQr && showFiscalQr && qrSvg && (
            <div style={{ margin: "12px auto 4px", width: "96px" }}>
              <span dangerouslySetInnerHTML={{ __html: qrSvg }} />
              <div style={{ marginTop: 4, fontSize: `${9 * fs}px`, fontWeight: 700, textAlign: "center" }}>رمز التحقق الضريبي (فيسكالي)</div>
            </div>
          )}
        </section>
      )}

      {/* footer */}
      {show("footer") && (
        <section style={{ order: order.get("footer"), marginTop: 4 }}>
          <div style={{ textAlign: "center", fontSize: `${13 * fs}px`, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{receiptFooter}</div>
        </section>
      )}
    </div>
  );

  return body;
}
