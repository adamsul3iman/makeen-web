"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, BarcodeFormat } from "@zxing/browser";
import { Camera, Loader, RefreshCw, Zap, ZapOff } from "lucide-react";

interface ScannerControls {
  stop: () => void;
  switchTorch?: (on: boolean) => Promise<void>;
}

/**
 * Live camera barcode scanner for the mobile add-product page. Uses
 * @zxing/browser's BrowserMultiFormatReader restricted to 1D retail codes
 * (EAN/UPC/Code128/Code39/ITF/Codabar). The camera stream is stopped as soon as
 * a barcode is delivered AND on unmount, so the light never stays on behind the
 * form or after a route change.
 */
export default function BarcodeScanner({
  onDetected,
  onRequestClose,
  enabled,
}: {
  onDetected: (barcode: string) => void;
  onRequestClose: () => void;
  enabled: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const [state, setState] = useState<"idle" | "starting" | "scanning" | "error">("idle");
  const [message, setMessage] = useState("");
  const [torch, setTorch] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Reopening the scanner (enabled flips back to true) resets to a clean
  // pre-scan state. React-sanctioned "adjust state during render" pattern so
  // the reset is not a cascading setState inside the effect.
  const [prevEnabled, setPrevEnabled] = useState(false);
  if (enabled !== prevEnabled) {
    setPrevEnabled(enabled);
    if (enabled) {
      setState("starting");
      setMessage("");
      setTorch(false);
      setTorchSupported(false);
    }
  }

  useEffect(() => {
    if (!enabled) {
      controlsRef.current?.stop();
      controlsRef.current = null;
      return;
    }

    const videoEl = videoRef.current;
    let cancelled = false;
    const reader = new BrowserMultiFormatReader();
    reader.possibleFormats = [
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.ITF,
      BarcodeFormat.CODABAR,
    ];

    reader
      .decodeFromVideoDevice(undefined, videoEl ?? undefined, (result, _error, controls) => {
        if (cancelled) return;
        controlsRef.current = controls;
        if (result?.getText()) {
          const text = result.getText().trim();
          if (text.length > 0 && !cancelled) {
            controls.stop();
            controlsRef.current = null;
            onDetected(text);
          }
        }
      })
      .then((controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setState("scanning");
        setTorchSupported(typeof controls.switchTorch === "function");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const name = (err as { name?: string })?.name ?? "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setMessage("تم رفض إذن الكاميرا — امنح الوصول ثم أعد المحاولة");
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          setMessage("لا توجد كاميرا متاحة على هذا الجهاز");
        } else if (name === "NotReadableError" || name === "TrackStartError") {
          setMessage("الكاميرا قيد الاستخدام من تطبيق آخر — أغلقها ثم أعد المحاولة");
        } else {
          setMessage("تعذر تشغيل الكاميرا");
        }
        setState("error");
      });

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
      if (videoEl) videoEl.srcObject = null;
    };
  }, [enabled, onDetected, attempt]);

  const toggleTorch = () => {
    const next = !torch;
    setTorch(next);
    void controlsRef.current?.switchTorch?.(next).catch(() => setTorch(!next));
  };

  if (!enabled) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-slate-900">
      <div className="relative aspect-[4/3] w-full bg-slate-950">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {state !== "scanning" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/70 p-4 text-center">
            {state === "starting" && (
              <>
                <Loader className="h-7 w-7 animate-spin text-white" />
                <p className="text-sm font-black text-white">جارٍ تشغيل الكاميرا…</p>
              </>
            )}
            {state === "error" && (
              <>
                <Camera className="h-7 w-7 text-white" />
                <p className="text-sm font-bold text-white">{message}</p>
                <button
                  type="button"
                  onClick={() => {
                    setState("starting");
                    setMessage("");
                    setTorch(false);
                    setTorchSupported(false);
                    setAttempt((value) => value + 1);
                  }}
                  className="mt-1 flex h-10 items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-black text-slate-900 transition hover:bg-slate-200"
                >
                  <RefreshCw className="h-4 w-4" />
                  إعادة المحاولة
                </button>
              </>
            )}
          </div>
        )}
        {/* Scanner framing guides */}
        {state === "scanning" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-40 w-3/5 rounded-2xl border-2 border-white/80" />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 bg-slate-900 p-3">
        <p className="flex-1 text-xs font-bold text-slate-200">
          ضع الباركود داخل الإطار — يتم التقاطه تلقائياً
        </p>
        {torchSupported && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-label={torch ? "إطفاء الكشاف" : "تشغيل الكشاف"}
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition ${
              torch ? "bg-amber-400 text-slate-900" : "bg-slate-700 text-white hover:bg-slate-600"
            }`}
          >
            {torch ? <ZapOff className="h-5 w-5" /> : <Zap className="h-5 w-5" />}
          </button>
        )}
        <button
          type="button"
          onClick={onRequestClose}
          className="h-10 shrink-0 rounded-xl bg-slate-700 px-4 text-sm font-black text-white transition hover:bg-slate-600"
        >
          إغلاق
        </button>
      </div>
    </div>
  );
}
