"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Barcode,
  Cable,
  CheckCircle2,
  CircleX,
  FileText,
  Printer,
  RotateCcw,
  ScanLine,
  Tags,
  Unplug,
  Usb,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  connectCashDrawer,
  forgetCashDrawer,
  getCashDrawerStatus,
  hasCashDrawer,
  openCashDrawer,
  testCashDrawerPort,
  type CashDrawerStatus,
} from "@/lib/cashDrawer";
import {
  scannerAcceptsSubmitKey,
  type DeviceHardwareSettings,
} from "@/lib/deviceHardware";
import { useDeviceHardware } from "@/hooks/useDeviceHardware";
import { useHardwareHub } from "@/hooks/useHardwareHub";
import { dispatchPrintJob } from "@/lib/hardware/dispatch";
import { buildSlotTestHtml } from "@/lib/hardware/diagnostics";
import { ALL_SLOTS, SLOT_A4, SLOT_LABEL, SLOT_RECEIPT, type SlotId } from "@/lib/hardware/slots";
import type { PrinterSlot, SlotKind } from "@/lib/hardware/types";
import { usePosStore } from "@/store/usePosStore";
import { playPosSound, type PosSoundCue } from "@/lib/posSound";
import { isElectron } from "@/lib/printAgent";

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
  const tests: Array<{ cue: PosSoundCue; label: string; className: string }> = [
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
              مستوى الصوت <span className="font-mono" dir="ltr">{settings.soundVolume}%</span>
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

const SLOT_META: Record<SlotId, { icon: typeof Printer; desc: string }> = {
  [SLOT_RECEIPT]: { icon: Printer, desc: "الطابعة الحرارية 80/58mm لإيصالات نقطة البيع" },
  [SLOT_LABEL]: { icon: Tags, desc: "طابعة الملصقات والباركود للملصقات اللاصقة" },
  [SLOT_A4]: { icon: FileText, desc: "طابعة الأوراق A4 للتقارير والفواتير الرسمية" },
};

const TEST_INTENT: Record<SlotId, Parameters<typeof dispatchPrintJob>[0]> = {
  [SLOT_RECEIPT]: "TEST_RECEIPT",
  [SLOT_LABEL]: "TEST_LABEL",
  [SLOT_A4]: "TEST_A4",
};

export default function DevicesPage() {
  const activeTerminalId = usePosStore((state) => state.activeTerminalId);
  const terminals = usePosStore((state) => state.terminals);
  const terminal = (terminals ?? []).find((item) => item.id === activeTerminalId);
  const { settings, updateSettings, resetSettings } = useDeviceHardware(activeTerminalId);
  const {
    config: hub,
    printers,
    updateConfig,
    resetConfig,
    refreshPrinters,
  } = useHardwareHub(activeTerminalId);

  const [printersLoading, setPrintersLoading] = useState(false);
  const [printerMessages, setPrinterMessages] = useState<Record<string, string>>({});
  const [testBusy, setTestBusy] = useState<Record<string, boolean>>({});

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

  const setSlotMessage = useCallback((slot: SlotId, msg: string) => {
    setPrinterMessages((prev) => ({ ...prev, [slot]: msg }));
  }, []);

  const refreshDrawer = useCallback(async () => {
    setDrawerStatus(await getCashDrawerStatus(activeTerminalId));
  }, [activeTerminalId]);

  useEffect(() => {
    let active = true;
    void getCashDrawerStatus(activeTerminalId).then((status) => {
      if (active) setDrawerStatus(status);
    });
    return () => {
      active = false;
    };
  }, [activeTerminalId]);

  const loadPrinters = useCallback(async () => {
    if (!isElectron()) {
      setPrintersLoading(false);
      return;
    }
    setPrintersLoading(true);
    await refreshPrinters();
    setPrintersLoading(false);
  }, [refreshPrinters]);

  useEffect(() => {
    const id = requestAnimationFrame(() => void loadPrinters());
    return () => cancelAnimationFrame(id);
  }, [loadPrinters]);

  const testSlot = async (slot: PrinterSlot) => {
    if (testBusy[slot.id]) return;
    setTestBusy((prev) => ({ ...prev, [slot.id]: true }));
    setSlotMessage(slot.id, "");
    try {
      const html = buildSlotTestHtml(slot.kind);
      const result = await dispatchPrintJob(TEST_INTENT[slot.id as SlotId], {
        html,
        terminalId: activeTerminalId ?? "",
        jobType: slot.kind === "A4" ? "Z_REPORT" : "RECEIPT",
      });
      setSlotMessage(
        slot.id,
        result.printed
          ? "تم إرسال صفحة الاختبار إلى الطابعة"
          : "تعذر الطباعة — تحقق من الطابعة ثم أعد المحاولة",
      );
    } catch {
      setSlotMessage(slot.id, "تعذر الطباعة — خطأ غير متوقع");
    } finally {
      setTestBusy((prev) => ({ ...prev, [slot.id]: false }));
    }
  };

  const connectDrawer = async () => {
    setDrawerBusy(true);
    setDrawerMessage("");
    const connected = await connectCashDrawer(
      {
        baudRate: hub.drawer.baudRate,
        pin: hub.drawer.pin,
        shareName: hub.drawer.shareName || undefined,
      },
      activeTerminalId,
    );
    setDrawerMessage(connected ? "تم حفظ اسم مشاركة الدرج" : "لم يتم إدخال اسم مشاركة صالح");
    await refreshDrawer();
    setDrawerBusy(false);
  };

  const testDrawer = async () => {
    setDrawerBusy(true);
    const opened = await openCashDrawer(
      {
        baudRate: hub.drawer.baudRate,
        pin: hub.drawer.pin,
        shareName: hub.drawer.shareName || undefined,
      },
      activeTerminalId,
    );
    setDrawerMessage(opened ? "تم إرسال نبضة فتح الدرج" : "تعذر الوصول إلى الدرج");
    await refreshDrawer();
    setDrawerBusy(false);
  };

  const testInitWrite = async () => {
    setDrawerBusy(true);
    const written = await testCashDrawerPort(
      {
        baudRate: hub.drawer.baudRate,
        pin: hub.drawer.pin,
        shareName: hub.drawer.shareName || undefined,
      },
      activeTerminalId,
    );
    setDrawerMessage(written ? "تمت كتابة أمر التهيئة (ESC @) إلى الطابعة المشتركة" : "تعذر الكتابة على الطابعة المشتركة");
    await refreshDrawer();
    setDrawerBusy(false);
  };

  const disconnectDrawer = async () => {
    setDrawerBusy(true);
    await forgetCashDrawer(activeTerminalId);
    if (isElectron()) {
      updateConfig((d) => ({ ...d, drawer: { ...d.drawer, shareName: "" } }));
    }
    setDrawerMessage("تم نسيان اسم مشاركة الدرج من هذا الجهاز");
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
    setScannerResult({ code, duration: Math.max(0, Math.round(performance.now() - scanStartedAt.current)) });
    setScannerInput("");
    scanStartedAt.current = 0;
    if (settings.soundEnabled) void playPosSound("SCAN_ACCEPTED", settings.soundVolume);
  };

  const testSound = (cue: PosSoundCue) => {
    if (!settings.soundEnabled) return;
    void playPosSound(cue, settings.soundVolume);
  };

  const slotKindLabel = (kind: SlotKind) => (kind === "THERMAL" ? "حرارية" : kind === "LABEL" ? "ملصقات" : "A4");

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black text-foreground">
            <Usb className="h-6 w-6 text-primary" />
            مركز الأجهزة والطابعات
          </h1>
          <p className="mt-1 text-sm font-bold text-muted">
            {terminal?.name ?? "هذا الجهاز"} • إعدادات محلية لهذه الطرفية
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            resetConfig();
            resetSettings();
            setDrawerMessage("عادت إعدادات الأجهزة إلى القيم الافتراضية");
          }}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black text-muted hover:bg-surface-muted"
        >
          <RotateCcw className="h-4 w-4" />
          استعادة الافتراضي
        </button>
      </header>

      <SoundSettingsSection settings={settings} onUpdate={updateSettings} onTest={testSound} />

      {/* ── Printer slots ─────────────────────────────────────────────── */}
      <section className="rounded-lg border border-border bg-white p-5">
        <div className="flex items-center gap-2">
          <Printer className="h-5 w-5 text-blue-600" />
          <h2 className="text-base font-black">منافذ الطابعات (Slots)</h2>
        </div>
        <p className="mt-1 text-sm font-bold text-muted">
          خصّص كل منفذ لطابعة فعلية. تُوجَّه الأوامر تلقائياً إلى المنفذ حسب نوع العملية.
        </p>

        <div className="mt-5 grid gap-4">
          {ALL_SLOTS.map((slotId) => {
            const slot = hub.slots[slotId];
            if (!slot) return null;
            const meta = SLOT_META[slotId];
            const Icon = meta.icon;
            return (
              <div key={slotId} className="rounded-xl border border-border bg-surface-muted/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Icon className="h-5 w-5 text-blue-600" />
                    <div>
                      <div className="flex items-center gap-2 text-sm font-black">
                        {slot.nameAr}
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-muted" dir="ltr">
                          {slotId}
                        </span>
                        <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-black text-violet-700">
                          {slotKindLabel(slot.kind)}
                        </span>
                      </div>
                      <p className="text-xs font-bold text-muted">{meta.desc}</p>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-black text-muted">
                    مفعّل
                    <input
                      type="checkbox"
                      checked={slot.enabled}
                      onChange={(event) => updateConfig((d) => ({
                        ...d,
                        slots: { ...d.slots, [slotId]: { ...d.slots[slotId], enabled: event.target.checked } },
                      }))}
                      className="h-5 w-5 accent-blue-600"
                    />
                  </label>
                </div>

                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="block min-w-0 flex-1 text-xs font-black text-muted">
                    الطابعة المختارة
                    <select
                      value={slot.deviceName}
                      onChange={(event) => updateConfig((d) => ({
                        ...d,
                        slots: { ...d.slots, [slotId]: { ...d.slots[slotId], deviceName: event.target.value } },
                      }))}
                      className="mt-1.5 h-10 w-full appearance-none rounded-lg border border-border bg-white px-3 text-sm font-black text-foreground"
                    >
                      <option value="">تلقائي (حسب نوع الطابعة)</option>
                      {printers.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                          {p.isDefault ? " (افتراضي)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  {slotId === SLOT_RECEIPT && (
                    <div>
                      <p className="mb-1.5 text-xs font-black text-muted">عرض الورق</p>
                      <div className="grid grid-cols-2 rounded-lg bg-surface-muted p-1">
                        {([80, 58] as const).map((width) => (
                          <button
                            key={width}
                            type="button"
                            onClick={() => updateConfig((d) => ({
                              ...d,
                              slots: { ...d.slots, [slotId]: { ...d.slots[slotId], paperWidth: width } },
                            }))}
                            className={`h-9 rounded-md text-sm font-black ${slot.paperWidth === width ? "bg-white text-primary shadow-sm" : "text-muted"}`}
                          >
                            {width}mm
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={testBusy[slotId]}
                    onClick={() => void testSlot(slot)}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-40"
                  >
                    <Printer className="h-4 w-4" />
                    {testBusy[slotId] ? "جارٍ الطباعة…" : "اختبار الطباعة"}
                  </button>
                </div>

                {printerMessages[slotId] ? (
                  <p className="mt-2 text-sm font-bold text-muted">{printerMessages[slotId]}</p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-xs font-bold text-muted">
            {printersLoading
              ? "جاري جلب الطابعات…"
              : printers.length === 0
                ? "لم يتم العثور على طابعات مثبتة (أو خارج تطبيق سطح المكتب)"
                : `تم العثور على ${printers.length} طابعة ملحقة بالنظام`}
          </p>
          <button
            type="button"
            onClick={() => void loadPrinters()}
            disabled={printersLoading}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-black text-muted hover:bg-surface-muted disabled:opacity-40"
          >
            <RotateCcw className="h-4 w-4" />
            تحديث القائمة
          </button>
        </div>
      </section>

      {/* ── Cash drawer ───────────────────────────────────────────────── */}
      <section className="rounded-lg border border-border bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-base font-black">
              <Cable className="h-5 w-5 text-green-600" />
              درج النقد
            </h2>
            <p className={`mt-2 flex items-center gap-2 text-sm font-bold ${drawerStatus.selected ? "text-green-700" : "text-muted"}`}>
              <StatusDot ok={drawerStatus.selected} />
              {isElectron()
                ? drawerStatus.selected
                  ? `الدرج مربوط عبر المشاركة (${drawerStatus.shareName ?? hub.drawer.shareName})`
                  : "لا يوجد اسم مشاركة — أدخل اسم مشاركة الطابعة في Windows"
                : !drawerStatus.supported
                  ? "Web Serial غير متاح في هذا المتصفح"
                  : drawerStatus.selected
                    ? "منفذ الدرج مربوط"
                    : "لا يوجد منفذ مربوط"}
            </p>
          </div>

          <div className="grid w-full min-w-0 gap-4 sm:grid-cols-2 lg:max-w-[560px] lg:flex-1">
            {isElectron() ? (
              <label className="block text-xs font-black text-muted sm:col-span-2">
                اسم مشاركة الطابعة في Windows (الدرج)
                <input
                  type="text"
                  value={hub.drawer.shareName}
                  onChange={(event) =>
                    updateConfig((d) => ({ ...d, drawer: { ...d.drawer, shareName: event.target.value } }))
                  }
                  placeholder="مثال: MAKEENRECEIPT"
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-white px-3 font-mono text-sm font-black text-foreground"
                />
                <span className="mt-1 block text-[11px] font-medium leading-relaxed text-muted">
                  لتشغيل درج النقد، شارك الطابعة الحرارية في ويندوز ثم اكتب اسم المشاركة هنا.
                  الخطوات: إعدادات ويندوز ← الأجهزة والطابعات ← يمين-كلك على الطابعة الحرارية ←
                  «خصائص الطابعة» ← تبويب «المشاركة» ← فعّل «مشاركة هذه الطابعة» واكتب اسم
                  المشاركة (بدون مسافات، مثال: MAKEENRECEIPT). بعد ذلك، برجاء التأكد من أن
                  «معالج الطباعة» (Print Processor) في تبويب «خيارات متقدمة» مضبوط على
                  <span className="font-mono"> winprint </span>
                  ونوع البيانات
                  <span className="font-mono"> RAW </span>
                  لضمان مرور أوامر ESC/POS كما هي.
                </span>
              </label>
            ) : null}

            <label className="block text-xs font-black text-muted">
              سرعة المنفذ
              <select
                value={hub.drawer.baudRate}
                onChange={(event) =>
                  updateConfig((d) => ({
                    ...d,
                    drawer: {
                      ...d.drawer,
                      baudRate: Number(event.target.value) as 9600 | 19200 | 38400 | 115200,
                    },
                  }))
                }
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
                    onClick={() =>
                      updateConfig((d) => ({ ...d, drawer: { ...d.drawer, pin } }))
                    }
                    className={`h-9 rounded-md text-sm font-black ${hub.drawer.pin === pin ? "bg-white text-primary shadow-sm" : "text-muted"}`}
                  >
                    Pin {pin}
                  </button>
                ))}
              </div>
            </div>

            <div className="sm:col-span-2">
              <p className="mb-2 text-xs font-black text-muted">توجيه فتح الدرج أثناء البيع</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
                  <span className="text-sm font-black">عند الدفع نقداً</span>
                  <input
                    type="checkbox"
                    checked={hub.drawer.triggers.cashSale}
                    onChange={(event) =>
                      updateConfig((d) => ({
                        ...d,
                        drawer: {
                          ...d.drawer,
                          triggers: { ...d.drawer.triggers, cashSale: event.target.checked },
                        },
                      }))
                    }
                    className="h-5 w-5 accent-green-600"
                  />
                </label>
                <label className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
                  <span className="text-sm font-black">عند الدفع نقد + بطاقة</span>
                  <input
                    type="checkbox"
                    checked={hub.drawer.triggers.splitSale}
                    onChange={(event) =>
                      updateConfig((d) => ({
                        ...d,
                        drawer: {
                          ...d.drawer,
                          triggers: { ...d.drawer.triggers, splitSale: event.target.checked },
                        },
                      }))
                    }
                    className="h-5 w-5 accent-green-600"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <button
            type="button"
            disabled={
              !drawerStatus.supported ||
              drawerBusy ||
              (isElectron() && !hub.drawer.shareName)
            }
            onClick={() => void connectDrawer()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-black text-white disabled:opacity-40"
          >
            <Usb className="h-4 w-4" /> حفظ اسم المشاركة
          </button>
          <button
            type="button"
            disabled={!drawerStatus.selected || drawerBusy}
            onClick={() => void testDrawer()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-green-600 px-4 text-sm font-black text-white disabled:opacity-40"
          >
            <Cable className="h-4 w-4" /> اختبار فتح الدرج
          </button>
          {isElectron() ? (
            <button
              type="button"
              disabled={!drawerStatus.selected || drawerBusy}
              onClick={() => void testInitWrite()}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-600 px-4 text-sm font-black text-white disabled:opacity-40"
            >
              <Printer className="h-4 w-4" /> اختبار الكتابة (ESC @)
            </button>
          ) : null}
          <button
            type="button"
            disabled={!drawerStatus.selected || drawerBusy}
            onClick={() => void disconnectDrawer()}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black text-muted disabled:opacity-40"
          >
            <Unplug className="h-4 w-4" /> نسيان اسم المشاركة
          </button>
          {drawerMessage ? <span className="text-sm font-bold text-muted">{drawerMessage}</span> : null}
        </div>
      </section>

      {/* ── Scanner ───────────────────────────────────────────────────── */}
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
    </div>
  );
}
