"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/format";
import type { ReportsTrendPoint } from "@/types/reports.types";

interface TrendChartProps {
  points: ReportsTrendPoint[];
  generatedAt: string;
  /** When true, render a second (restrained) series for operating profit. */
  showProfit?: boolean;
}

const WIDTH = 600;
const HEIGHT = 200;
const PAD = 10;

function niceDomain(max: number): number {
  const safeMax = Math.max(1, Math.ceil(max));
  const magnitude = Math.pow(10, Math.floor(Math.log10(safeMax)));
  const normalized = safeMax / magnitude;
  let step: number;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 5) step = 5;
  else step = 10;
  return Math.ceil(normalized / step) * step * magnitude;
}

function buildPath(points: ReportsTrendPoint[], get: (p: ReportsTrendPoint) => number, plotW: number, plotH: number, span: number): string {
  const n = points.length;
  const stepX = n > 1 ? plotW / (n - 1) : 0;
  let d = "";
  points.forEach((p, i) => {
    const x = PAD + (n > 1 ? i * stepX : plotW / 2);
    const y = PAD + (1 - Math.max(0, get(p)) / span) * plotH;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return d;
}

/**
 * Zero-dependency trend chart. Rendered as a single responsive <svg> using a
 * fixed viewBox, so it scales instantly on any container / window / Electron
 * resize without a JS resize-observer or chart re-layout (the usual jank source).
 */
export default function TrendChart({ points, generatedAt, showProfit = false }: TrendChartProps) {
  const { salesPath, area, profitPath, lastLabel, showProfitLine } = useMemo(() => {
    if (!points || points.length === 0) {
      return { salesPath: "", area: "", profitPath: "", lastLabel: "", showProfitLine: false };
    }

    const hasProfit = showProfit && points.some((p) => p.profit != null && p.profit > 0);
    const values = points.map((p) => Math.max(0, p.sales));
    if (hasProfit) {
      points.forEach((p) => {
        if (p.profit != null && p.profit > 0) values.push(p.profit);
      });
    }
    const span = Math.max(1, niceDomain(Math.max(...values)));

    const plotW = WIDTH - PAD * 2;
    const plotH = HEIGHT - PAD * 2;
    const salesPath = buildPath(points, (p) => p.sales, plotW, plotH, span);

    // Close the sales area under the line down to the baseline.
    const n = points.length;
    const stepX = n > 1 ? plotW / (n - 1) : 0;
    const lastX = n > 1 ? PAD + (n - 1) * stepX : PAD + plotW / 2;
    const firstX = PAD;
    const baselineY = PAD + plotH;
    const area = `${salesPath} L${lastX.toFixed(1)},${baselineY} L${firstX},${baselineY} Z`;

    const profitPath = hasProfit
      ? buildPath(points, (p) => (p.profit != null ? p.profit : 0), plotW, plotH, span)
      : "";

    const last = points[points.length - 1];
    return {
      salesPath,
      area,
      profitPath,
      lastLabel: formatMoney(last.sales),
      showProfitLine: hasProfit,
    };
  }, [points, showProfit]);

  const total = points.length;
  const valueLabel = total > 0 ? points[total - 1].sales : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-sm font-bold text-muted">إجمالي مبيعات الفترة النشطة</p>
        <p className="shrink-0 text-lg font-black tabular-nums text-foreground" title={formatMoney(valueLabel)}>
          {lastLabel || "—"}
        </p>
      </div>

      <div className="relative mt-3 min-h-0 flex-1">
        {total === 0 ? (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-surface-muted/40 py-12 text-center">
            <p className="text-sm font-bold text-muted">لا توجد بيانات مبيعات ضمن الفترة بعد.</p>
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="h-full w-full"
            role="img"
            aria-label="منحنى المبيعات"
          >
            <defs>
              <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563eb" stopOpacity="0.12" />
                <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#trend-fill)" />
            <path d={salesPath} fill="none" stroke="#2563eb" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
            {showProfitLine && (
              <path d={profitPath} fill="none" stroke="#0f766e" strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs font-semibold text-muted">
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-3 shrink-0 rounded-sm bg-blue-600" />
            المبيعات
          </span>
          {showProfitLine && (
            <span className="flex items-center gap-1.5">
              <span className="h-0 w-3 shrink-0 border-t-2 border-dashed border-teal-700" />
              الربح
            </span>
          )}
        </span>
        <span className="shrink-0 tabular-nums font-bold text-foreground">
          {total > 0 ? new Date(generatedAt).toLocaleTimeString("ar-JO", { hour: "2-digit", minute: "2-digit" }) : "—"}
        </span>
      </div>
    </div>
  );
}
