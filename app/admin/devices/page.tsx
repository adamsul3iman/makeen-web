"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Barcode,
  Cable,
  CheckCircle2,
  CircleX,
  Printer,
  RotateCcw,
  ScanLine,
  Unplug,
  Usb,
  Volume2,
  VolumeX,
} from "lucide-react";
import ThermalReceipt from "@/components/pos/ThermalReceipt";
import {
  connectCashDrawer,
  forgetCashDrawer,
  getCashDrawerStatus,
  hasCashDrawer,
  openCashDrawer,
  type CashDrawerStatus,
} from "@/lib/cashDrawer";
import {
  scannerAcceptsSubmitKey,
  type DeviceHardwareSettings,
} from "@/lib/deviceHardware";
import { useDeviceHardware } from "@/hooks/useDeviceHardware";
import { usePosStore } from "@/store/usePosStore";
import type { CompletedInvoice } from "@/types/pos.types";
import { playPosSound, type PosSoundCue } from "@/lib/posSound";

const BAUD_RATES: DeviceHardwareSettings["drawerBaudRate"][] = [
  9600,
  19200,
  38400,
  115200,
];

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`h-2.5 w-2.5 rounded-full ${ok ? "bg-green-500" : "bg-slate-300"}`} />;
}

function SoundSettingsSection({
  settings,
  onUpdate,
  onTest,
}: {
  settings: DeviceHardwareSettings;
  onUpdate: (patch: Partial<DeviceHardwareSettings>) => void;
  onTest: (cue: PosSoundCue) => void;
}) {
  const tests: Array<{
    cue: PosSoundCue;
    label: string;
    className: string;
  }> = [
    {
      cue: "SCAN_ACCEPTED",
      label: "اختبار المسح",
      className: "border-border bg-white text-foreground hover:bg-surface-muted",
    },
    {
      cue: "ERROR",
      label: "اختبار الخطأ",
      className: "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
    },
    {
      cue: "SALE_COMPLETED",
      label: "اختبار إتمام البيع",
      className: "border-green-200 bg-green-50 text-green-700 hover:bg-green-100",
    },
  ];

  return (
    <section className="rounded-lg border border-border bg-white p-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <div>
          <h2 className="flex items-center gap-2 text-base font-black">
            {settings.soundEnabled ? (
              <Volume2 className="h-5 w-5 text-cyan-600" />
            ) : (
              <VolumeX className="h-5 w-5 text-slate-400" />
            )}
            أصوات نقطة البيع
          </h2>
          <p className="mt-2 text-sm font-bold text-muted">
            تأكيد المسح، تنبيه الأخطاء، وإتمام الفاتورة
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
          <label className="flex min-h-16 items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
            <span className="text-sm font-black">تشغيل الأصوات</span>
            <input
              type="checkbox"
              checked={settings.soundEnabled}
              onChange={(event) => onUpdate({ soundEnabled: event.target.checked })}
              className="h-5 w-5 accent-cyan-600"
            />
          </label>

          <label className={`rounded-lg border border-border px-4 py-3 ${settings.soundEnabled ? "" : "opacity-50"}`}>
            <span className="flex items-center justify-between text-xs font-black text-muted">
              مستوى الصوت
              <span className="font-mono text-foreground" dir="ltr">{settings.soundVolume}%</span>
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={settings.soundVolume}
              disabled={!settings.soundEnabled}
              onChange={(event) => onUpdate({ soundVolume: Number(event.target.value) })}
              className="mt-3 w-full accent-cyan-600"
            />
          </label>

          <div className="flex flex-wrap gap-2 sm:col-span-2">
            {tests.map((test) => (
              <button
                key={test.cue}
                type="button"
                disabled={!settings.soundEnabled || settings.soundVolume === 0}
                onClick={() => onTest(test.cue)}
                className={`h-9 rounded-lg border px-3 text-xs font-black disabled:opacity-40 ${test.className}`}
              >
                {test.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function DevicesPage() {
  const activeTerminalId = usePosStore((state) => state.activeTerminalId);
  const terminals = usePosStore((state) => state.terminals);
  const terminal = (terminals ?? []).find((item) => item.id === activeTerminalId);
  const { settings, updateSettings, resetSettings } = useDeviceHardware(activeTerminalId);
  const [drawerStatus, setDrawerStatus] = useState<CashDrawerStatus>({
    supported: hasCashDrawer(),
    authorizedPortCount: 0,
    selected: false,
  });
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [drawerMessage, setDrawerMessage] = useState("");
  const [scannerInput, setScannerInput] = useState("");
  const [scannerResult, setScannerResult] = useState<{ code: string; duration: number } | null>(null);
  const scanStartedAt = useRef(0);

  const testInvoice = useMemo<CompletedInvoice>(() => ({
    syncId: "TEST-RECEIPT-2026",
    shiftId: "TEST-SHIFT",
    items: [
      {
        productId: "test-product",
        name: "منتج تجريبي",
        barcode: "6251234567890",
        qty: 2,
        unitName: "حبة",
        unitPrice: 1,
        lineTotal: 2.32,
        taxPercent: 16,
        taxIncluded: false,
      },
    ],
    subtotal: 2,
    tax: 0.32,
    discount: 0,
    total: 2.32,
    paymentMethod: "CASH",
    amountPaid: 5,
    change: 2.68,
    cashierName: "اختبار الطابعة",
    terminalId: activeTerminalId ?? undefined,
    completed_at: new Date().toISOString(),
  }), [activeTerminalId]);

  const refreshDrawer = async () => setDrawerStatus(await getCashDrawerStatus());

  useEffect(() => {
    let active = true;
    void getCashDrawerStatus().then((status) => {
      if (active) setDrawerStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  const connectDrawer = async () => {
    setDrawerBusy(true);
    setDrawerMessage("");
    const connected = await connectCashDrawer(settings);
    setDrawerMessage(connected ? "تم ربط منفذ الدرج" : "لم يتم اختيار منفذ صالح");
    await refreshDrawer();
    setDrawerBusy(false);
  };

  const testDrawer = async () => {
    setDrawerBusy(true);
    const opened = await openCashDrawer(settings);
    setDrawerMessage(opened ? "تم إرسال نبضة فتح الدرج" : "تعذر الوصول إلى الدرج");
    await refreshDrawer();
    setDrawerBusy(false);
  };

  const disconnectDrawer = async () => {
    setDrawerBusy(true);
    await forgetCashDrawer();
    setDrawerMessage("تم نسيان منفذ الدرج من هذا الجهاز");
    await refreshDrawer();
    setDrawerBusy(false);
  };

  const onScannerChange = (value: string) => {
    if (!scannerInput && value) scanStartedAt.current = performance.now();
    setScannerInput(value);
  };

  const onScannerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!scannerAcceptsSubmitKey(event.key, settings.scannerSubmitKey)) return;
    const code = scannerInput.trim();
    if (!code) return;
    event.preventDefault();
    setScannerResult({
      code,
      duration: Math.max(0, Math.round(performance.now() - scanStartedAt.current)),
    });
    setScannerInput("");
    scanStartedAt.current = 0;
    if (settings.soundEnabled) {
      void playPosSound("SCAN_ACCEPTED", settings.soundVolume);
    }
  };

  const testSound = (cue: PosSoundCue) => {
    if (!settings.soundEnabled) return;
    void playPosSound(cue, settings.soundVolume);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black text-foreground">
            <Usb className="h-6 w-6 text-primary" />
            الأجهزة والطباعة
          </h1>
          <p className="mt-1 text-sm font-bold text-muted">
            {terminal?.name ?? "هذا الجهاز"} • إعدادات محلية لهذه الطرفية
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            resetSettings();
            setDrawerMessage("عادت إعدادات الجهاز إلى القيم الافتراضية");
          }}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black text-muted hover:bg-surface-muted"
        >
          <RotateCcw className="h-4 w-4" />
          استعادة الافتراضي
        </button>
      </header>

      <SoundSettingsSection
        settings={settings}
        onUpdate={updateSettings}
        onTest={testSound}
      />

      <section className="rounded-lg border border-border bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-base font-black">
              <Printer className="h-5 w-5 text-blue-600" />
              الطابعة الحرارية
            </h2>
            <p className="mt-2 flex items-center gap-2 text-sm font-bold text-green-700">
              <StatusDot ok /> الطباعة عبر نظام التشغيل جاهزة
            </p>
          </div>

          <div className="grid w-full min-w-0 gap-4 sm:grid-cols-2 lg:max-w-[560px] lg:flex-1">
            <div>
              <p className="mb-2 text-xs font-black text-muted">عرض الورق</p>
              <div className="grid grid-cols-2 rounded-lg bg-surface-muted p-1">
                {([80, 58] as const).map((width) => (
                  <button
                    key={width}
                    type="button"
                    onClick={() => updateSettings({ receiptWidth: width })}
                    className={`h-9 rounded-md text-sm font-black ${settings.receiptWidth === width ? "bg-white text-primary shadow-sm" : "text-muted"}`}
                  >
                    {width}mm
                  </button>
                ))}
              </div>
            </div>

            <label className="flex min-h-16 items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
              <span className="text-sm font-black">طباعة تلقائية بعد البيع</span>
              <input
                type="checkbox"
                checked={settings.autoPrintReceipt}
                onChange={(event) => updateSettings({ autoPrintReceipt: event.target.checked })}
                className="h-5 w-5 accent-blue-600"
              />
            </label>
          </div>
        </div>

        <div className="mt-4 flex justify-end border-t border-border pt-4">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800"
          >
            <Printer className="h-4 w-4" />
            طباعة إيصال اختبار
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-base font-black">
              <Cable className="h-5 w-5 text-green-600" />
              درج النقد
            </h2>
            <p className={`mt-2 flex items-center gap-2 text-sm font-bold ${drawerStatus.selected ? "text-green-700" : "text-muted"}`}>
              <StatusDot ok={drawerStatus.selected} />
              {!drawerStatus.supported
                ? "Web Serial غير متاح في هذا المتصفح"
                : drawerStatus.selected
                  ? "منفذ الدرج مربوط"
                  : "لا يوجد منفذ مربوط"}
            </p>
          </div>

          <div className="grid w-full min-w-0 gap-4 sm:grid-cols-2 lg:max-w-[560px] lg:flex-1">
            <label className="block text-xs font-black text-muted">
              سرعة المنفذ
              <select
                value={settings.drawerBaudRate}
                onChange={(event) => updateSettings({ drawerBaudRate: Number(event.target.value) as DeviceHardwareSettings["drawerBaudRate"] })}
                className="mt-2 h-10 w-full rounded-lg border border-border bg-white px-3 text-sm font-black text-foreground"
              >
                {BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
              </select>
            </label>

            <div>
              <p className="mb-2 text-xs font-black text-muted">موصل الدرج</p>
              <div className="grid grid-cols-2 rounded-lg bg-surface-muted p-1">
                {([2, 5] as const).map((pin) => (
                  <button
                    key={pin}
                    type="button"
                    onClick={() => updateSettings({ drawerPin: pin })}
                    className={`h-9 rounded-md text-sm font-black ${settings.drawerPin === pin ? "bg-white text-primary shadow-sm" : "text-muted"}`}
                  >
                    Pin {pin}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex min-h-16 items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 sm:col-span-2">
              <span className="text-sm font-black">فتح الدرج تلقائياً عند الدفع النقدي</span>
              <input
                type="checkbox"
                checked={settings.autoOpenDrawer}
                onChange={(event) => updateSettings({ autoOpenDrawer: event.target.checked })}
                className="h-5 w-5 accent-green-600"
              />
            </label>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <button
            type="button"
            disabled={!drawerStatus.supported || drawerBusy}
            onClick={() => void connectDrawer()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-black text-white disabled:opacity-40"
          >
            <Usb className="h-4 w-4" /> ربط منفذ
          </button>
          <button
            type="button"
            disabled={!drawerStatus.selected || drawerBusy}
            onClick={() => void testDrawer()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-green-600 px-4 text-sm font-black text-white disabled:opacity-40"
          >
            <Cable className="h-4 w-4" /> اختبار الفتح
          </button>
          <button
            type="button"
            disabled={!drawerStatus.selected || drawerBusy}
            onClick={() => void disconnectDrawer()}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black text-muted disabled:opacity-40"
          >
            <Unplug className="h-4 w-4" /> نسيان المنفذ
          </button>
          {drawerMessage ? <span className="text-sm font-bold text-muted">{drawerMessage}</span> : null}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-base font-black">
              <Barcode className="h-5 w-5 text-violet-600" />
              قارئ الباركود
            </h2>
            <p className="mt-2 flex items-center gap-2 text-sm font-bold text-green-700">
              <StatusDot ok /> قارئ لوحة المفاتيح جاهز
            </p>
          </div>

          <div className="grid w-full min-w-0 gap-4 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)] lg:max-w-[560px] lg:flex-1">
            <label className="block min-w-0 text-xs font-black text-muted">
              مفتاح نهاية المسح
              <select
                value={settings.scannerSubmitKey}
                onChange={(event) => updateSettings({ scannerSubmitKey: event.target.value as DeviceHardwareSettings["scannerSubmitKey"] })}
                className="mt-2 h-10 w-full rounded-lg border border-border bg-white px-3 text-sm font-black text-foreground"
              >
                <option value="ENTER_OR_TAB">Enter أو Tab</option>
                <option value="ENTER">Enter</option>
                <option value="TAB">Tab</option>
              </select>
            </label>

            <label className="block min-w-0 text-xs font-black text-muted">
              اختبار المسح
              <div className="mt-2 flex h-10 items-center gap-2 rounded-lg border border-border px-3 focus-within:border-violet-500">
                <ScanLine className="h-4 w-4 text-violet-600" />
                <input
                  value={scannerInput}
                  onChange={(event) => onScannerChange(event.target.value)}
                  onKeyDown={onScannerKeyDown}
                  autoComplete="off"
                  dir="ltr"
                  placeholder="امسح باركوداً"
                  className="min-w-0 flex-1 bg-transparent text-sm font-black tracking-wide outline-none"
                />
              </div>
            </label>
          </div>
        </div>

        <div className="mt-4 flex min-h-11 items-center gap-3 border-t border-border pt-4">
          {scannerResult ? (
            <>
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <span className="font-mono text-sm font-black" dir="ltr">{scannerResult.code}</span>
              <span className="text-xs font-bold text-muted">{scannerResult.duration}ms</span>
            </>
          ) : (
            <>
              <CircleX className="h-5 w-5 text-slate-300" />
              <span className="text-sm font-bold text-muted">لم تُسجل قراءة اختبار بعد</span>
            </>
          )}
        </div>
      </section>

      <ThermalReceipt invoice={testInvoice} paperWidth={settings.receiptWidth} />
    </div>
  );
}
