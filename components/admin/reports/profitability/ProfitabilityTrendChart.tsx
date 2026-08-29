"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/format";
import type { ProfitabilityTrendPoint } from "@/types/profitability.types";

interface ProfitabilityTrendChartProps {
  points: ProfitabilityTrendPoint[];
}

const WIDTH = 600;
const HEIGHT = 220;
const PAD_LEFT = 10;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 18;

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

/**
 * Zero-dependency income-statement trend. A single responsive <svg> with a
 * fixed viewBox scales instantly on any window/resize (no resize-observer, no
 * chart re-layout jank). Revenue is a restrained bar series; operating profit
 * is an optional second line drawn only when reliable.
 */
export default function ProfitabilityTrendChart({ points }: ProfitabilityTrendChartProps) {
  const { bars, line, showProfitLine, lastLabel } = useMemo(() => {
    if (!points || points.length === 0) {
      return { bars: [], line: "", showProfitLine: false, lastLabel: "" };
    }

    const hasProfit = points.some((p) => p.operatingProfit != null && p.operatingProfit > 0);
    const values = points.map((p) => Math.max(0, p.revenue));
    if (hasProfit) {
      points.forEach((p) => {
        if (p.operatingProfit != null && p.operatingProfit > 0) values.push(p.operatingProfit);
      });
    }
    const span = Math.max(1, niceDomain(Math.max(...values)));

    const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
    const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
    const n = points.length;

    const barRects = points.map((p, i) => {
      const x0 = PAD_LEFT + (n > 1 ? i * (plotW / n) : plotW / 2);
      const width = n > 1 ? Math.max(2, plotW / n - 2.5) : plotW / 2;
      const h = (Math.max(0, p.revenue) / span) * plotH;
      const y = PAD_TOP + plotH - h;
      return { x: x0, y, width, height: h };
    });

    let lineD = "";
    points.forEach((p, i) => {
      const x = PAD_LEFT + (n > 1 ? i * (plotW / (n - 1)) : plotW / 2);
      const y =
        p.operatingProfit != null
          ? PAD_TOP + plotH - (Math.max(0, p.operatingProfit) / span) * plotH
          : null;
      if (y != null) {
        lineD += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      }
    });

    const last = points[points.length - 1];
    return {
      bars: barRects,
      line: lineD,
      showProfitLine: hasProfit,
      lastLabel: formatMoney(last.revenue),
    };
  }, [points]);

  const total = points.length;
  const lastRevenue = total > 0 ? points[total - 1].revenue : 0;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-sm font-bold text-muted">اتجاه الإيراد والربح التشغيلي</p>
        <p className="shrink-0 text-lg font-black tabular-nums text-foreground" title={formatMoney(lastRevenue)}>
          {lastLabel || "—"}
        </p>
      </div>

      <div className="relative mt-3 min-h-0 flex-1">
        {total === 0 ? (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-surface-muted/40 py-12 text-center">
            <p className="text-sm font-bold text-muted">لا توجد بيانات إيراد ضمن الفترة بعد.</p>
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="h-full w-full"
            role="img"
            aria-label="اتجاه الإيراد والربح التشغيلي"
          >
            <rect x={PAD_LEFT} y={PAD_TOP} width={WIDTH - PAD_LEFT - PAD_RIGHT} height={HEIGHT - PAD_TOP - PAD_BOTTOM} fill="none" stroke="transparent" />
            <g fill="var(--pos-primary)" fillOpacity="0.55">
              {bars.map((bar, index) => (
                <rect
                  key={index}
                  x={Number(bar.x.toFixed(1))}
                  y={Number(bar.y.toFixed(1))}
                  width={Number(bar.width.toFixed(1))}
                  height={Number(bar.height.toFixed(1))}
                  rx="2"
                />
              ))}
            </g>
            {showProfitLine && (
              <path d={line} fill="none" stroke="var(--pos-success-strong)" strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs font-semibold text-muted">
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-3 shrink-0 rounded-sm bg-primary/60" />
            الإيراد
          </span>
          {showProfitLine && (
            <span className="flex items-center gap-1.5">
              <span className="h-0 w-3 shrink-0 border-t-2 border-dashed border-success-strong" />
              الربح التشغيلي
            </span>
          )}
        </span>
        <span className="shrink-0 tabular-nums font-bold text-foreground">
          {total > 0 ? `${total} يوم` : "—"}
        </span>
      </div>
    </div>
  );
}