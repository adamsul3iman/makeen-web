"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { formatMoney } from "@/lib/format";
import type { BarcodeLabelElementId, BarcodeLabelTemplateConfig } from "@/types/printTemplates";

export interface BarcodeLabelData {
  name: string;
  barcode: string;
  price: number;
  unitName: string;
}
export default function BarcodeLabel({
  data,
  config,
  storeName = "",
  preview = false,
}: {
  data: BarcodeLabelData;
  config: BarcodeLabelTemplateConfig;
  storeName?: string;
  preview?: boolean;
}) {
  const barcodeRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!barcodeRef.current) return;
    let cancelled = false;
    void import("jsbarcode").then(({ default: JsBarcode }) => {
      if (cancelled || !barcodeRef.current) return;
      try {
        JsBarcode(barcodeRef.current, data.barcode, {
          format: "CODE128",
          width: preview ? 1.2 : 1,
          height: Math.max(12, Math.round(config.barcodeHeightMm * 3.78)),
          displayValue: false,
          margin: 0,
        });
      } catch {
        barcodeRef.current?.replaceChildren();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [config.barcodeHeightMm, data.barcode, preview]);

  const visible: Record<BarcodeLabelElementId, boolean> = {
    store: config.showStoreName && Boolean(storeName.trim()),
    name: config.showName,
    barcode: true,
    barcodeText: config.showBarcodeText,
    unit: config.showUnit,
    price: config.showPrice,
  };
  const borderClass = config.borderStyle === "none"
    ? "border-transparent"
    : config.borderStyle === "dashed"
      ? "border-dashed border-black"
      : "border-solid border-black";

  const renderElement = (id: BarcodeLabelElementId) => {
    if (!visible[id]) return null;
    switch (id) {
      case "store":
        return <p key={id} className="w-full shrink-0 truncate text-center text-[0.7em] font-black leading-none">{storeName}</p>;
      case "name":
        return <p key={id} className="w-full shrink-0 truncate text-center text-[0.9em] font-black leading-none">{data.name}</p>;
      case "barcode":
        // Keep the JsBarcode intrinsic aspect ratio (width auto + height auto)
        // and only cap it to the label and the configured height, so bars are
        // never stretched or squashed and remain scannable.
        return (
          <svg
            key={id}
            ref={barcodeRef}
            style={{ width: "auto", height: "auto", maxWidth: "100%", maxHeight: `${config.barcodeHeightMm}mm`, flex: "0 0 auto" }}
            className="block"
          />
        );
      case "barcodeText":
        return <p key={id} dir="ltr" className="w-full shrink-0 truncate text-center text-[0.7em] font-bold leading-none tabular-nums">{data.barcode}</p>;
      case "unit":
        return <p key={id} className="w-full shrink-0 truncate text-center text-[0.7em] font-bold leading-none">{data.unitName}</p>;
      case "price":
        return <p key={id} dir="ltr" className="w-full shrink-0 text-center text-[1em] font-black leading-none tabular-nums">{formatMoney(data.price)}</p>;
    }
  };

  return (
    <div
      className={`barcode-label flex shrink-0 flex-col items-center justify-center overflow-hidden border bg-white text-black ${borderClass}`}
      style={
        {
          width: `${config.widthMm}mm`,
          height: `${config.heightMm}mm`,
          padding: `${config.paddingMm}mm`,
          // Base font of 10px, scaled by fontScale; every text element is
          // expressed in em so the whole label scales proportionally.
          fontSize: `${Math.round(10 * config.fontScale * 10) / 10}px`,
          gap: "0.4mm",
          printColorAdjust: "exact",
          WebkitPrintColorAdjust: "exact",
        } as CSSProperties
      }
    >
      {config.order.map(renderElement)}
    </div>
  );
}
