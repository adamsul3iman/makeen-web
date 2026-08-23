"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Printer, Loader2, CheckCircle2, TriangleAlert, Radio } from "lucide-react";
import { setTenantStoreId } from "@/lib/tenantClient";
import { claimPrintJob, resolvePrintJob, type ClaimedPrintJob } from "@/lib/printClient";
import BarcodeLabel, { type BarcodeLabelData } from "@/components/print/BarcodeLabel";
import { DEFAULT_BARCODE_LABEL_TEMPLATE, normalizeBarcodeLabelTemplate } from "@/lib/printTemplates";
import type { BarcodeLabelTemplateConfig } from "@/types/printTemplates";

const POLL_MS = 2500;

type ClaimedJob = ClaimedPrintJob;

function workerId(): string {
  const KEY = "pos-print-server-worker";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = `kiosk-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return `kiosk-${Date.now().toString(36)}`;
  }
}

/**
 * Remote label-printing kiosk. Sits on a browser attached to the label
 * printer and drains the store's `print_jobs` queue one job at a time:
 * claim → render → window.print() → resolve. Two kiosks can never print the
 * same label (the claim RPC locks rows with SKIP LOCKED).
 */
/** SSR-safe read of the `?store=` id that also registers the tenant header. */
function initialStoreParam(): string {
  if (typeof window === "undefined") return "";
  const store = new URLSearchParams(window.location.search).get("store")?.trim() ?? "";
  if (store) setTenantStoreId(store);
  return store;
}

export default function PrintServerPage() {
  const [storeParam] = useState(initialStoreParam);
  const [worker] = useState(() => (typeof window === "undefined" ? "kiosk" : workerId()));
  const [connected, setConnected] = useState<"idle" | "waiting" | "printing" | "error">("idle");
  const [error, setError] = useState("");
  const [lastPrinted, setLastPrinted] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [job, setJob] = useState<ClaimedJob | null>(null);

  const resolve = useCallback(async (jobId: string, printed: boolean) => {
    try {
      await resolvePrintJob(jobId, printed);
    } catch {
      // A failed resolve leaves the job CLAIMED; the claim timeout requeues
      // it so the label still prints from this (or another) kiosk.
    }
  }, []);

  const claim = useCallback(async (): Promise<ClaimedJob | null> => {
    const job = await claimPrintJob(worker);
    return job ?? null;
  }, [worker]);

  const printJob = useCallback(
    async (claimed: ClaimedJob) => {
      setJob(claimed);
      setConnected("printing");
      setError("");

      // Render a full tick so the labels (and JsBarcode) paint before print.
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      window.print();

      // afterprint may not fire in every browser; resolve after a short grace
      // so the queue advances even when the event is lost.
      await new Promise((resolveGrace) => setTimeout(resolveGrace, 400));
      await resolve(claimed.id, true);
      setLastPrinted(claimed.payload.name + (claimed.payload.variantLabel ? ` • ${claimed.payload.variantLabel}` : ""));
      setTotal((t) => t + 1);
      setJob(null);
      setConnected("waiting");
    },
    [resolve],
  );

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const claimed = await claim();
        if (cancelled) return;
        if (claimed) {
          setConnected("waiting");
          await printJob(claimed);
        } else {
          setConnected("waiting");
        }
      } catch {
        if (!cancelled) {
          setConnected("error");
          setError("تعذر الوصول لخادم الطباعة");
        }
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [claim, printJob]);

  const labelData = useMemo<BarcodeLabelData | null>(() => {
    if (!job) return null;
    const p = job.payload;
    return {
      name: p.name + (p.variantLabel ? ` • ${p.variantLabel}` : ""),
      barcode: p.barcode,
      price: p.price,
      unitName: p.unitName || "حبة",
    };
  }, [job]);

  const template = useMemo<BarcodeLabelTemplateConfig | null>(() => {
    if (!job) return null;
    const size = job.payload.templateSize;
    const config = {
      ...DEFAULT_BARCODE_LABEL_TEMPLATE,
      widthMm: size?.widthMm || DEFAULT_BARCODE_LABEL_TEMPLATE.widthMm,
      heightMm: size?.heightMm || DEFAULT_BARCODE_LABEL_TEMPLATE.heightMm,
    };
    return normalizeBarcodeLabelTemplate(config);
  }, [job]);

  const quantity = job?.payload?.quantity ?? 1;

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-white" dir="rtl">
      {/* The printed sheet must match the job's label pitch exactly, otherwise
          the printer feeds a full page per label (blank-label overrun). */}
      {template && (
        <style>{`
          @media print {
            @page {
              size: ${template.widthMm}mm ${template.heightMm}mm;
              margin: 0;
            }
            body * { visibility: hidden; }
            #print-sheet, #print-sheet * { visibility: visible; }
            #print-sheet { position: absolute; inset: 0; }
          }
        `}</style>
      )}

      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div className="flex items-center gap-2 text-lg font-black">
          <Printer className="h-5 w-5" />
          طابعة الملصقات
          {storeParam && (
            <span dir="ltr" suppressHydrationWarning className="rounded-lg bg-slate-800 px-2 py-0.5 font-mono text-xs font-bold text-slate-300">
              {storeParam}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm font-bold text-slate-300">
          {connected === "waiting" && <Radio className="h-4 w-4 animate-pulse text-green-400" />}
          {connected === "printing" && <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}
          {connected === "error" && <TriangleAlert className="h-4 w-4 text-red-400" />}
          {connected === "waiting" && "في انتظار أوامر الطباعة"}
          {connected === "printing" && "جاري الطباعة…"}
          {connected === "error" && "تعذر الوصول لخادم الطباعة"}
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
        {job && template && labelData ? (
          <>
            <div className="max-w-full overflow-x-auto">
              <div id="print-sheet" className="flex flex-wrap" style={{ gap: `${template.gapMm}mm` } as CSSProperties}>
                {Array.from({ length: quantity }, (_, i) => (
                  <BarcodeLabel key={`${job.id}-${i}`} data={labelData} config={template} preview />
                ))}
              </div>
            </div>
            <p className="flex items-center gap-2 text-sm font-black text-amber-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              طباعة {quantity} ملصق… {labelData.name}
            </p>
          </>
        ) : (
          <>
            <div className="grid h-20 w-20 place-items-center rounded-3xl bg-slate-800">
              <Printer className="h-9 w-9 text-slate-400" />
            </div>
            <div className="text-center">
              {connected === "error" ? (
                <>
                  <p className="text-lg font-black text-red-300">خطأ في الاتصال</p>
                  <p className="mt-1 text-sm font-bold text-slate-400">{error || "تأكد من تشغيل الخادم وجلسة المتجر"}</p>
                </>
              ) : (
                <>
                  <p className="text-lg font-black text-slate-200">الطابعة جاهزة</p>
                  <p className="mt-1 text-sm font-bold text-slate-400">
                    {connected === "printing" ? "جارٍ استلام مهمة…" : "ستُطبع أي ملصقات مطلوبة من السجل فور وصولها"}
                  </p>
                </>
              )}
            </div>
          </>
        )}

        <div className="mt-4 flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-xs font-bold text-slate-300">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            مطبوع: {total}
          </span>
          {lastPrinted && <span className="truncate text-slate-400">آخر: {lastPrinted}</span>}
          <span suppressHydrationWarning className="text-slate-500">الجلسة: {worker}</span>
        </div>
      </main>
    </div>
  );
}
