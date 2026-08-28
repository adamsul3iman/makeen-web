"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Banknote,
  Building2,
  CheckCircle2,
  ClipboardList,
  CloudOff,
  HardDrive,
  LayoutDashboard,
  Lock,
  LogOut,
  MonitorSmartphone,
  MoreHorizontal,
  Printer,
  ReceiptText,
  RefreshCw,
  Settings2,
  X,
  Zap,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { usePosHotkeys } from "@/hooks/usePosHotkeys";
import { useCrossTabSync } from "@/hooks/useCrossTabSync";
import { useBackgroundSync } from "@/hooks/useBackgroundSync";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDeviceHardware } from "@/hooks/useDeviceHardware";
import { useCatalogWatch } from "@/hooks/useCatalogWatch";
import { useOrdersBoot } from "@/hooks/useOrdersBoot";
import {
  acquireRegisterLease,
  releaseRegisterLease,
  renewRegisterLease,
  REGISTER_LEASE_PREFIX,
} from "@/lib/crossTabLock";
import { openCashDrawer } from "@/lib/cashDrawer";
import {
  POS_SOUND_EVENT,
  playPosSound,
  primePosAudio,
  type PosSoundEventDetail,
} from "@/lib/posSound";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import SpeedDock from "./SpeedDock";
import InvoicePanel from "./InvoicePanel";
import QuickActionsDrawer from "./QuickActionsDrawer";
import CheckoutModal from "./CheckoutModal";
import HeldInvoicesModal from "./HeldInvoicesModal";
import EndShiftModal from "./EndShiftModal";
import OpenShiftModal from "./OpenShiftModal";
import ShiftDetailsModal from "./ShiftDetailsModal";
import ShiftClosedSuccess from "./ShiftClosedSuccess";
import ThermalReceipt from "./ThermalReceipt";
import RegisterGate from "./RegisterGate";
import DebtSettlementModal from "./DebtSettlementModal";
import ExpenseModal from "./ExpenseModal";
import CashMovementModal from "./CashMovementModal";
import SmartSearchModal from "./SmartSearchModal";
import VariantPickerModal from "./VariantPickerModal";
import AdminHubModal from "./AdminHubModal";
import SecondaryAuthModal from "../auth/SecondaryAuthModal";
import PreviousInvoicesModal from "./PreviousInvoicesModal";
import AuditLogTimeline from "../admin/AuditLogTimeline";
import { firstBackofficePath, hasCapability } from "@/lib/permissions";
import {
  STORAGE_PRESSURE_EVENT,
  getStoragePressure,
  type StoragePressureDetail,
} from "@/lib/storageGuard";
import { smartPrint, captureReceiptHtml, isElectron, printInBrowser } from "@/lib/printAgent";

export default function PosLayout() {
  const router = useRouter();
  usePosHotkeys();
  useCrossTabSync();
  useBackgroundSync();
  useBarcodeScanner();
  useCatalogWatch();
  useOrdersBoot();

  const notice = usePosStore((s) => s.notice);
  const dismissNotice = usePosStore((s) => s.dismissNotice);
  const isCheckoutModalOpen = usePosStore((s) => s.isCheckoutModalOpen);
  const isHoldModalOpen = usePosStore((s) => s.isHoldModalOpen);
  const isCloseShiftModalOpen = usePosStore((s) => s.isCloseShiftModalOpen);
  const isDebtSettlementModalOpen = usePosStore(
    (s) => s.isDebtSettlementModalOpen,
  );
  const isExpenseModalOpen = usePosStore((s) => s.isExpenseModalOpen);
  const isSmartSearchOpen = usePosStore((s) => s.isSmartSearchOpen);
  const isAdminHubOpen = usePosStore((s) => s.isAdminHubOpen);
  const isSecondaryAuthOpen = usePosStore((s) => s.isSecondaryAuthOpen);
  const isPreviousInvoicesModalOpen = usePosStore(
    (s) => s.isPreviousInvoicesModalOpen,
  );
  const isAuditLogOpen = usePosStore((s) => s.isAuditLogOpen);
  const isShiftDetailsModalOpen = usePosStore((s) => s.isShiftDetailsModalOpen);
  const openShiftDetailsModal = usePosStore((s) => s.openShiftDetailsModal);
  const isShiftClosedSuccess = usePosStore((s) => s.isShiftClosedSuccess);
  const incrementDrawerOpenCount = usePosStore((s) => s.incrementDrawerOpenCount);
  const adminSession = usePosStore((s) => s.adminSession);
  const openAdminHub = usePosStore((s) => s.openAdminHub);
  const requestSecondaryAuth = usePosStore((s) => s.requestSecondaryAuth);
  const modalSession = usePosStore((s) => s.modalSession);
  const shiftStatus = usePosStore((s) => s.shiftState.status);
  const isOnline = usePosStore((s) => s.isOnline);
  const pendingSyncCount = usePosStore((s) => s.pendingSyncCount);
  const poisonSyncCount = usePosStore((s) => s.poisonSyncCount);
  const istdPendingCount = usePosStore((s) => s.istdPendingCount);
  const istdFailedCount = usePosStore((s) => s.istdFailedCount);
  const retryPendingIstd = usePosStore((s) => s.retryPendingIstd);
  const openCloseShiftModal = usePosStore((s) => s.openCloseShiftModal);
  const isReturnMode = usePosStore((s) => s.isReturnMode);
  const checkoutSession = usePosStore((s) => s.checkoutSession);
  const lastCompletedInvoice = usePosStore((s) => s.lastCompletedInvoice);
  const currentCashier = usePosStore((s) => s.currentCashier);
  const currentStoreId = usePosStore((s) => s.currentStore?.id ?? null);
  const registerLeaseHeld = usePosStore((s) => s.registerLeaseHeld);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowAnchorRef = useRef<HTMLButtonElement>(null);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);
  const confirmLockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockScreen = usePosStore((s) => s.lockScreen);
  const hydrateCatalog = usePosStore((s) => s.hydrateCatalog);
  const branches = usePosStore((s) => s.branches);
  const terminals = usePosStore((s) => s.terminals);
  const activeBranchId = usePosStore((s) => s.activeBranchId);
  const activeTerminalId = usePosStore((s) => s.activeTerminalId);
  const { settings: hardwareSettings } = useDeviceHardware(activeTerminalId);
  const handledHardwareInvoice = useRef<string | null>(null);
  const lastAudibleNotice = useRef(notice);
  const [printedInvoiceId, setPrintedInvoiceId] = useState<string | null>(null);
  const canAccessBackoffice = hasCapability(
    currentCashier,
    "backoffice.access",
  );
  const canSell = hasCapability(currentCashier, "pos.sell");

  const activeBranch = branches.find((b) => b.id === activeBranchId);
  const activeTerminal = (terminals ?? []).find((t) => t.id === activeTerminalId);

  const modalOpen =
    isCheckoutModalOpen ||
    isHoldModalOpen ||
    isCloseShiftModalOpen ||
    isDebtSettlementModalOpen ||
    isExpenseModalOpen ||
    isSmartSearchOpen ||
    isAdminHubOpen ||
    isSecondaryAuthOpen ||
    isPreviousInvoicesModalOpen ||
    isAuditLogOpen ||
    isShiftDetailsModalOpen;

  // Timer cleanup on unmount
  useEffect(() => {
    return () => {
      if (confirmLockTimer.current) clearTimeout(confirmLockTimer.current);
    };
  }, []);

  const handleLock = useCallback(() => {
    if (confirmLock) {
      if (confirmLockTimer.current) clearTimeout(confirmLockTimer.current);
      confirmLockTimer.current = null;
      setConfirmLock(false);
      lockScreen();
    } else {
      setConfirmLock(true);
      confirmLockTimer.current = setTimeout(() => setConfirmLock(false), 2000);
    }
  }, [confirmLock, lockScreen]);

  // Bootstrap from the local snapshot first, then refresh catalog/customers
  // in the background for the active store only.
  useEffect(() => {
    if (!currentStoreId) return;
    void hydrateCatalog();
  }, [currentStoreId, hydrateCatalog]);

  // One tab per register: claim the (store, terminal) lease on mount and
  // renew it on an interval. Any second tab on the same register goes
  // read-only ("هذا الكاشير مفتوح في نافذة أخرى"). A lease storage event
  // lets the loser take over the moment the winner releases or crashes.
  //
  // Transient-flip guard: right after a successful claim we hold a short
  // grace window during which a lost-lease signal cannot blank the POS.
  // This prevents the whole UI from swapping to the "open in another window"
  // screen on spurious storage events or mid-renewal races.
  const leaseGuardUntil = useRef(0);
  useEffect(() => {
    if (!currentStoreId || !activeTerminalId) return;
    const claim = () => {
      const acquired = acquireRegisterLease(currentStoreId, activeTerminalId);
      if (!acquired) {
        // Respect the grace window: ignore losses that land within it.
        if (Date.now() < leaseGuardUntil.current) return;
        usePosStore.setState({ registerLeaseHeld: true });
      } else {
        leaseGuardUntil.current = Date.now() + 30_000;
        usePosStore.setState({ registerLeaseHeld: false });
      }
    };
    claim();
    const renewal = setInterval(
      () => renewRegisterLease(currentStoreId, activeTerminalId),
      3000,
    );
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith(REGISTER_LEASE_PREFIX)) claim();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(renewal);
      window.removeEventListener("storage", onStorage);
      releaseRegisterLease(currentStoreId, activeTerminalId);
      usePosStore.setState({ registerLeaseHeld: false });
    };
  }, [currentStoreId, activeTerminalId]);

  useEffect(() => {
    if (
      !currentCashier ||
      currentCashier.sessionReady === false ||
      canSell ||
      !canAccessBackoffice
    )
      return;
    router.replace(firstBackofficePath(currentCashier));
  }, [canAccessBackoffice, canSell, currentCashier, router]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 2500);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  // Semantic cues are emitted only after a barcode or checkout operation has
  // actually succeeded, so an Enter key by itself can never sound successful.
  useEffect(() => {
    if (!hardwareSettings.soundEnabled) return;
    let primed = false;
    const primeAudio = () => {
      if (primed) return;
      void primePosAudio().then((ready) => {
        if (!ready) return;
        primed = true;
        window.removeEventListener("pointerdown", primeAudio, true);
        window.removeEventListener("keydown", primeAudio, true);
      });
    };
    window.addEventListener("pointerdown", primeAudio, true);
    window.addEventListener("keydown", primeAudio, true);
    return () => {
      window.removeEventListener("pointerdown", primeAudio, true);
      window.removeEventListener("keydown", primeAudio, true);
    };
  }, [hardwareSettings.soundEnabled]);

  useEffect(() => {
    const onSoundCue = (event: Event) => {
      if (!hardwareSettings.soundEnabled) return;
      const cue = (event as CustomEvent<PosSoundEventDetail>).detail?.cue;
      if (!cue) return;
      void playPosSound(cue, hardwareSettings.soundVolume);
    };
    window.addEventListener(POS_SOUND_EVENT, onSoundCue);
    return () => window.removeEventListener(POS_SOUND_EVENT, onSoundCue);
  }, [hardwareSettings.soundEnabled, hardwareSettings.soundVolume]);

  // SYNC-F2: surface quota pressure from lib/storageGuard. Initialized from
  // the module snapshot so a shell mounting after the onset event still
  // warns immediately; the event's detail is null on the falling edge
  // (usage back under threshold), which clears the warning.
  const [storagePressure, setStoragePressure] = useState<StoragePressureDetail | null>(
    () => getStoragePressure(),
  );
  useEffect(() => {
    const onStoragePressure = (event: Event) => {
      setStoragePressure(
        (event as CustomEvent<StoragePressureDetail | null>).detail ?? null,
      );
    };
    window.addEventListener(STORAGE_PRESSURE_EVENT, onStoragePressure);
    return () =>
      window.removeEventListener(STORAGE_PRESSURE_EVENT, onStoragePressure);
  }, []);

  // Error notices remain visual and also produce a descending alert. The ref
  // prevents hydration or ordinary re-renders from replaying the same notice.
  useEffect(() => {
    const previous = lastAudibleNotice.current;
    lastAudibleNotice.current = notice;
    if (
      !notice ||
      notice === previous ||
      notice.tone !== "error" ||
      !hardwareSettings.soundEnabled
    )
      return;
    void playPosSound("ERROR", hardwareSettings.soundVolume);
  }, [hardwareSettings.soundEnabled, hardwareSettings.soundVolume, notice]);

  useEffect(() => {
    if (!modalOpen) {
      document.getElementById("pos-barcode-input")?.focus();
    }
  }, [modalOpen]);

  const printReceipt = useCallback(() => {
    // Silent printing with a robust browser fallback. In a plain browser
    // smartPrint ALWAYS reaches the fallback (a print_jobs queue insert is
    // never treated as "printed"), and we print via a hidden iframe so the
    // dialog opens even though the original click gesture was consumed by the
    // checkout flow's awaits (Chrome blocks window.print() in that case).
    // Inside Electron the fallback stays suppressed and a failed silent print
    // surfaces as a notice (no dialog may block a checkout lane).
    if (!activeTerminalId || !lastCompletedInvoice) return;
    const html = captureReceiptHtml();
    if (!html) return;

    void smartPrint({
      terminalId: activeTerminalId,
      jobType: "RECEIPT",
      renderedHtml: html,
      printerKind: "THERMAL",
      printerName: hardwareSettings.receiptPrinterName || undefined,
      onFallback: (fallbackHtml) => {
        if (fallbackHtml) void printInBrowser(fallbackHtml);
        else window.print();
      },
    }).then((printed) => {
      if (printed) return;
      // Every silent tier failed. Inside the wrapper no dialog may appear —
      // tell the cashier the receipt did not print instead.
      if (isElectron()) {
        usePosStore.setState({
          notice: {
            message: "تم البيع، لكن فشلت الطباعة الصامتة — تحقق من الطابعة ثم أعد الطباعة",
            tone: "error",
          },
        });
      }
    });
  }, [activeTerminalId, lastCompletedInvoice, hardwareSettings.receiptPrinterName]);

  // Settle local hardware after a completed sale. The drawer call never opens
  // a chooser here; it only uses a port explicitly authorized in Devices.
  useEffect(() => {
    if (!lastCompletedInvoice) return;
    if (handledHardwareInvoice.current === lastCompletedInvoice.syncId) return;
    handledHardwareInvoice.current = lastCompletedInvoice.syncId;
    let cancelled = false;

    const settleHardware = async () => {
      const cashPayment =
        lastCompletedInvoice.paymentMethod === "CASH" ||
        lastCompletedInvoice.paymentMethod === "SPLIT";
      if (hardwareSettings.autoOpenDrawer && cashPayment) {
        const opened = await openCashDrawer(hardwareSettings);
        if (opened) {
          incrementDrawerOpenCount();
        }
        if (!opened && !cancelled) {
          usePosStore.setState({
            notice: {
              message: "تم البيع، لكن تعذر فتح درج النقد",
              tone: "error",
            },
          });
        }
      }
      if (hardwareSettings.autoPrintReceipt && !cancelled) {
        printReceipt();
      }
    };

    void settleHardware();
    return () => {
      cancelled = true;
    };
  }, [hardwareSettings, lastCompletedInvoice]);

  // Keep the most recent receipt available for a cashier reprint.
  useEffect(() => {
    const onAfterPrint = () => {
      const invoice = usePosStore.getState().lastCompletedInvoice;
      if (invoice) setPrintedInvoiceId(invoice.syncId);
      document.getElementById("pos-barcode-input")?.focus();
    };
    window.addEventListener("afterprint", onAfterPrint);
    return () => window.removeEventListener("afterprint", onAfterPrint);
  }, []);

  // Keep scanner focus when the operator clicks the empty pad area, without
  // calling preventDefault (which broke native text selection, drags and the
  // scrollbar). Focusable targets and any open modal are left untouched.
  const keepFocusOnScanner = (e: React.MouseEvent<HTMLDivElement>) => {
    if (modalOpen) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    document.getElementById("pos-barcode-input")?.focus();
  };

  const isError = notice?.tone === "error";

  const noticeToast = notice ? (
    <div
      className={`animate-pos-toast fixed left-1/2 top-4 z-[90] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl px-4 py-3 text-sm font-extrabold leading-6 shadow-overlay ring-1 ring-surface/20 ${
        isError
          ? "bg-destructive text-destructive-foreground"
          : "bg-success text-success-foreground"
      }`}
    >
      {isError ? (
        <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">{notice.message}</span>
    </div>
  ) : null;

  if (!currentCashier) {
    return (
      <>
        {noticeToast}
        <RegisterGate />
        <SecondaryAuthModal />
      </>
    );
  }

  if (!canSell) {
    const backofficeHref = firstBackofficePath(currentCashier);
    return (
      <div
        dir="rtl"
        className="grid min-h-dvh place-items-center bg-background p-4 sm:p-6"
      >
        <section className="w-full max-w-md rounded-xl border border-border bg-surface p-7 text-center shadow-elevated sm:p-8">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-xl bg-info-soft text-info-strong ring-1 ring-info/15">
            <LayoutDashboard className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-xl font-extrabold tracking-normal text-foreground">
            {currentCashier.roleName ?? "موظف الإدارة"}
          </h1>
          <p className="mt-2 text-sm font-semibold leading-7 text-muted">
            هذا الدور مخصص للوحة التحكم ولا يملك صلاحية تنفيذ المبيعات على
            الكاشير.
          </p>
          {currentCashier.sessionReady === false ? (
            <p className="mt-6 rounded-xl bg-warning-soft px-4 py-3 text-sm font-bold text-warning-strong ring-1 ring-warning/15">
              {isOnline
                ? "جارٍ تأمين جلسة الموظف…"
                : "يلزم الاتصال لفتح تقارير المتجر."}
            </p>
          ) : (
            <Link
              href={backofficeHref}
              className="mt-6 flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-extrabold text-primary-foreground shadow-card transition-colors duration-150 hover:bg-primary-hover focus-visible:focus-ring active:scale-[0.98]"
            >
              <LayoutDashboard className="h-5 w-5" aria-hidden="true" />
              فتح لوحة التحكم
            </Link>
          )}
          <button
            type="button"
            onClick={handleLock}
            className="mt-3 h-10 w-full rounded-xl border border-border bg-surface text-sm font-bold text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-foreground focus-visible:focus-ring active:scale-[0.98]"
          >
            قفل / تبديل مستخدم
          </button>
        </section>
      </div>
    );
  }

  // Another tab/device holds this register's lease — this tab is read-only
  // so two tabs can never double-submit or run two shifts on one drawer.
  if (registerLeaseHeld) {
    return (
      <div
        dir="rtl"
        className="grid min-h-dvh place-items-center bg-background p-4 sm:p-6"
      >
        <section className="w-full max-w-md rounded-xl border border-border bg-surface p-7 text-center shadow-elevated sm:p-8">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-xl bg-warning-soft text-warning ring-1 ring-warning/15">
            <MonitorSmartphone className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-xl font-extrabold tracking-normal text-foreground">
            هذا الكاشير مفتوح في نافذة أخرى
          </h1>
          <p className="mt-2 text-sm font-semibold leading-7 text-muted">
            يعمل الكاشير حالياً في نافذة أخرى على هذا الجهاز. هذه النافذة
            للاطلاع فقط — لا تُقبل فيها أي عملية بيع أو إغلاق وردية.
          </p>
          <button
            type="button"
            onClick={lockScreen}
            className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-extrabold text-primary-foreground shadow-card transition-colors duration-150 hover:bg-primary-hover focus-visible:focus-ring active:scale-[0.98]"
          >
            <Lock className="h-5 w-5" aria-hidden="true" />
            قفل / تبديل مستخدم
          </button>
        </section>
      </div>
    );
  }

  return (
    <>
      <div
        dir="rtl"
        lang="ar"
        onMouseDown={keepFocusOnScanner}
        className={`relative isolate flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground print:hidden ${
          isReturnMode
            ? "bg-destructive-soft ring-2 ring-inset ring-destructive/70"
            : ""
        }`}
      >
        <header className="sticky top-0 z-30 flex h-[var(--topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-border/20 bg-header px-2 text-primary-foreground shadow-elevated print:hidden lg:px-3">
          <div className="flex h-11 min-w-0 items-center gap-2 rounded-xl border border-surface/10 bg-surface/[0.04] px-2.5">
            <span
              className="relative h-2.5 w-2.5 shrink-0 rounded-full bg-primary-bright ring-4 ring-primary-bright/10"
              aria-hidden="true"
            />
            <div className="min-w-0 leading-tight">
              <div className="flex items-center gap-2">
                <span className="max-w-32 truncate text-[15px] font-extrabold tracking-normal 2xl:max-w-40">
                  {currentCashier.name}
                </span>
                {(adminSession || currentCashier.roleName) && (
                  <span className="hidden rounded-lg bg-info/20 px-1.5 py-0.5 text-xs font-bold leading-none text-info-bright ring-1 ring-info/20 xl:inline-flex">
                    {adminSession ? "مالك" : currentCashier.roleName}
                  </span>
                )}
              </div>
              {(activeBranch || activeTerminal) && (
                <div className="mt-1 hidden items-center gap-2 text-xs font-semibold leading-none text-header-muted 2xl:flex">
                  <span className="flex max-w-28 items-center gap-1 truncate">
                    <Building2
                      className="h-3 w-3 shrink-0"
                      aria-hidden="true"
                    />
                    {activeBranch?.name ?? "الفرع الرئيسي"}
                  </span>
                  <span className="flex max-w-28 items-center gap-1 truncate">
                    <MonitorSmartphone
                      className="h-3 w-3 shrink-0"
                      aria-hidden="true"
                    />
                    {activeTerminal?.name ?? "الكاشير الرئيسي"}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex h-11 min-w-0 shrink items-center gap-1.5">
            <button
              type="button"
              onClick={(event) => {
                overflowAnchorRef.current = event.currentTarget;
                setOverflowOpen(true);
              }}
              aria-label={isOnline ? "متصل - عرض حالة النظام" : "دون اتصال - عرض حالة النظام"}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              title={isOnline ? "متصل" : "دون اتصال"}
              className="relative grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-surface/10 bg-surface/[0.04] text-header-muted transition-colors hover:bg-surface/10 hover:text-primary-foreground focus-visible:focus-ring 2xl:hidden"
            >
              {isOnline ? (
                <CheckCircle2 className="h-4 w-4 text-primary-bright" aria-hidden="true" />
              ) : (
                <CloudOff className="h-4 w-4 text-destructive-bright" aria-hidden="true" />
              )}
              {pendingSyncCount + poisonSyncCount + istdPendingCount + istdFailedCount > 0 && (
                <span className="absolute -end-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-warning px-1 text-xs font-black text-primary-foreground">
                  {pendingSyncCount + poisonSyncCount + istdPendingCount + istdFailedCount}
                </span>
              )}
            </button>
            <div className="hidden h-10 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-xl border border-surface/10 bg-surface/[0.04] px-3 text-xs font-bold text-primary-foreground/85 2xl:flex">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ring-2 ${
                  isOnline
                    ? "bg-primary-bright ring-primary-bright/15"
                    : "animate-pulse bg-destructive-bright ring-destructive-bright/15"
                }`}
                aria-hidden="true"
              />
              <span>{isOnline ? "متصل" : "دون اتصال"}</span>
              {pendingSyncCount > 0 && (
                <span className="flex items-center gap-1 rounded-lg px-1.5 py-0.5 font-bold text-warning-bright">
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  {pendingSyncCount}
                </span>
              )}
              {poisonSyncCount > 0 && (
                <span
                  title="حركات فشل مزامنتها نهائياً — راجعها من لوحة التحكم"
                  className="flex items-center gap-1 rounded-lg bg-destructive/25 px-1.5 py-0.5 font-bold text-destructive-bright ring-1 ring-destructive-bright/15"
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  حركة معلّقة (خارج المزامنة) · {poisonSyncCount}
                </span>
              )}
              {istdPendingCount > 0 && (
                <span
                  title="فواتير لم تُرسل إلى المصلحة بعد (قيد الانتظار أو فشل الإرسال)"
                  className="flex items-center gap-1 rounded-lg bg-warning/20 px-1.5 py-0.5 font-bold text-warning-bright ring-1 ring-warning-bright/15"
                >
                  <CloudOff className="h-3 w-3" aria-hidden="true" />
                  بانتظار JoFotara · {istdPendingCount}
                </span>
              )}
              {istdFailedCount > 0 && (
                <span
                  className="flex items-center gap-1 rounded-lg bg-destructive/25 px-1.5 py-0.5 font-bold text-destructive-bright ring-1 ring-destructive-bright/15"
                  title={`${istdFailedCount} فاتورة فشل إرسالها للمصلحة — أعد المحاولة`}
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  فشل إرسال · {istdFailedCount}
                  <button
                    type="button"
                    aria-label="إعادة محاولة إرسال الفواتير المعلقة"
                    onClick={() => void retryPendingIstd()}
                    className="ms-1 flex h-7 items-center gap-1 rounded-lg bg-destructive/20 px-2 font-bold text-destructive-bright transition-colors duration-150 hover:bg-destructive/35 focus-visible:focus-ring active:scale-[0.97]"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  إعادة
                </button>
              </span>
            )}
            {storagePressure && (
              <span
                title="مساحة تخزين الجهاز ممتلئة تقريباً — حرّر مساحة أو قلّم السجل المحلي؛ الفواتير غير المزامنة معرّضة للحذف"
                className="flex items-center gap-1 rounded-lg bg-destructive/25 px-1.5 py-0.5 font-bold text-destructive-bright ring-1 ring-destructive-bright/15"
              >
                <HardDrive className="h-3 w-3" aria-hidden="true" />
                مساحة التخزين ·{" "}
                {Math.round((storagePressure.usage / storagePressure.quota) * 100)}%
              </span>
            )}
          </div>
            {shiftStatus === "OPEN" &&
              hasCapability(currentCashier, "pos.close_shift") && (
                <>
                  <button
                    type="button"
                    onClick={openShiftDetailsModal}
                    aria-label="تفاصيل الوردية"
                    title="تفاصيل الوردية"
                    className="flex h-10 w-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-0 text-xs font-extrabold text-foreground shadow-card transition-all duration-150 hover:bg-surface-muted focus-visible:focus-ring active:scale-[0.97] 2xl:w-auto 2xl:px-3"
                  >
                    <ReceiptText className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden 2xl:inline">تفاصيل الوردية</span>
                  </button>
                  <button
                    type="button"
                    onClick={openCloseShiftModal}
                    aria-label="إغلاق الوردية"
                    title="إغلاق الوردية"
                    className="flex h-10 w-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-0 text-xs font-extrabold text-primary-foreground shadow-card transition-all duration-150 hover:bg-primary-hover focus-visible:focus-ring active:scale-[0.97] xl:w-auto xl:px-3"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden xl:inline">إغلاق الوردية</span>
                  </button>
                </>
              )}
          </div>

          <div className="relative flex h-11 shrink-0 items-center gap-1 rounded-xl border border-surface/10 bg-surface/[0.04] p-0.5 shadow-card">
            <Link
              href="/orders"
              aria-label="صفحة الطلبات"
              title="صفحة الطلبات"
              className="grid h-10 w-10 place-items-center rounded-lg text-header-muted transition-colors duration-150 hover:bg-surface/10 hover:text-primary-foreground focus-visible:focus-ring active:scale-[0.97]"
            >
              <ClipboardList className="h-4 w-4" />
            </Link>
            <button
              type="button"
              onClick={() => setQuickActionsOpen(true)}
              aria-label="الإجراءات السريعة (ليونة)"
              title="الإجراءات السريعة (ليونة)"
              className="grid h-10 w-10 place-items-center rounded-lg text-header-muted transition-colors duration-150 hover:bg-surface/10 hover:text-primary-foreground focus-visible:focus-ring active:scale-[0.97]"
            >
              <Zap className="h-4 w-4" />
            </button>
            {lastCompletedInvoice && (
              <button
                type="button"
                onClick={printReceipt}
                aria-label="إعادة طباعة آخر إيصال"
                title="إعادة طباعة آخر إيصال"
                className="grid h-10 w-10 place-items-center rounded-lg text-header-muted transition-colors duration-150 hover:bg-surface/10 hover:text-primary-foreground focus-visible:focus-ring active:scale-[0.97]"
              >
                <Printer className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={(event) => {
                overflowAnchorRef.current = event.currentTarget;
                setOverflowOpen((open) => !open);
              }}
              aria-label="خيارات وحالة النظام"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              title="خيارات وحالة النظام"
              className="grid h-10 w-10 place-items-center rounded-lg text-header-muted transition-colors duration-150 hover:bg-surface/10 hover:text-primary-foreground focus-visible:focus-ring active:scale-[0.97]"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
            <DropdownMenu
              open={overflowOpen}
              anchorRef={overflowAnchorRef}
              onClose={() => setOverflowOpen(false)}
              align="start"
              direction="rtl"
              label="خيارات وحالة النظام"
            >
                  <div className="border-b border-border px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3 text-sm font-bold">
                      <span className="flex items-center gap-2">
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${isOnline ? "bg-primary" : "bg-destructive"}`}
                          aria-hidden="true"
                        />
                        {isOnline ? "متصل" : "دون اتصال"}
                      </span>
                      {pendingSyncCount > 0 && (
                        <span className="text-xs text-warning-strong">مزامنة {pendingSyncCount}</span>
                      )}
                    </div>
                    {(activeBranch || activeTerminal) && (
                      <div className="mt-2 space-y-1 text-xs font-semibold text-muted">
                        <p className="flex items-center gap-2">
                          <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {activeBranch?.name ?? "الفرع الرئيسي"}
                        </p>
                        <p className="flex items-center gap-2">
                          <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden="true" />
                          {activeTerminal?.name ?? "الكاشير الرئيسي"}
                        </p>
                      </div>
                    )}
                    {(storagePressure ||
                      poisonSyncCount > 0 ||
                      istdPendingCount > 0 ||
                      istdFailedCount > 0) && (
                      <div className="mt-2 space-y-1 text-xs font-bold">
                        {storagePressure && (
                          <p className="text-destructive">
                            تحذير التخزين:{" "}
                            {Math.round(
                              (storagePressure.usage / storagePressure.quota) * 100,
                            )}
                            % من مساحة الجهاز — الفواتير غير المزامنة معرّضة للخطر
                          </p>
                        )}
                        {poisonSyncCount > 0 && (
                          <p className="text-destructive">حركات خارج المزامنة: {poisonSyncCount}</p>
                        )}
                        {istdPendingCount > 0 && (
                          <p className="text-warning-strong">بانتظار JoFotara: {istdPendingCount}</p>
                        )}
                        {istdFailedCount > 0 && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void retryPendingIstd()}
                            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-destructive-soft px-3 text-destructive transition-colors hover:bg-destructive/15 focus-visible:focus-ring"
                          >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                            إعادة إرسال الفواتير ({istdFailedCount})
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {adminSession && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOverflowOpen(false);
                        requestSecondaryAuth({ type: "open_drawer" });
                      }}
                      className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm font-bold text-foreground transition-colors duration-150 hover:bg-surface-muted focus-visible:focus-ring active:scale-[0.98]"
                    >
                      <Banknote
                        className="h-4 w-4 shrink-0 text-muted"
                        aria-hidden="true"
                      />
                      فتح الدرج
                    </button>
                  )}
                  {canAccessBackoffice && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOverflowOpen(false);
                        openAdminHub();
                      }}
                      className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm font-bold text-foreground transition-colors duration-150 hover:bg-surface-muted focus-visible:focus-ring active:scale-[0.98]"
                    >
                      <Settings2
                        className="h-4 w-4 shrink-0 text-muted"
                        aria-hidden="true"
                      />
                      لوحة التحكم
                    </button>
                  )}
                  {canAccessBackoffice && (
                    <Link
                      href={firstBackofficePath(currentCashier)}
                      role="menuitem"
                      onClick={() => setOverflowOpen(false)}
                      className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm font-bold text-foreground transition-colors duration-150 hover:bg-surface-muted focus-visible:focus-ring active:scale-[0.98]"
                    >
                      <LayoutDashboard
                        className="h-4 w-4 shrink-0 text-muted"
                        aria-hidden="true"
                      />
                      لوحة الإدارة
                    </Link>
                  )}
                  <Link
                    href="/orders"
                    role="menuitem"
                    onClick={() => setOverflowOpen(false)}
                    className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm font-bold text-foreground transition-colors duration-150 hover:bg-surface-muted focus-visible:focus-ring active:scale-[0.98]"
                  >
                    <ClipboardList
                      className="h-4 w-4 shrink-0 text-muted"
                      aria-hidden="true"
                    />
                    صفحة الطلبات
                  </Link>
            </DropdownMenu>
            <button
              type="button"
              onClick={handleLock}
              onMouseLeave={() => {
                if (confirmLock) {
                  if (confirmLockTimer.current)
                    clearTimeout(confirmLockTimer.current);
                  setConfirmLock(false);
                }
              }}
              aria-label="قفل أو تبديل المستخدم"
              title="قفل أو تبديل المستخدم"
              className={`grid h-10 w-10 place-items-center rounded-lg transition-all duration-150 focus-visible:focus-ring active:scale-[0.97] ${
                confirmLock
                  ? "bg-destructive text-destructive-foreground shadow-card"
                  : "text-header-muted hover:bg-destructive hover:text-destructive-foreground"
              }`}
            >
              <Lock className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {isReturnMode && (
          <div className="relative z-20 flex min-h-9 items-center justify-center gap-2 border-b border-destructive-foreground/20 bg-destructive px-4 py-1.5 text-sm font-extrabold text-destructive-foreground shadow-card">
            <span>وضع المرتجع مفعّل — أنت تردّ مالاً للزبون</span>
            <span className="rounded-lg bg-destructive-foreground/15 px-2 py-0.5 text-xs font-bold ring-1 ring-destructive-foreground/20">
              F6 للخروج
            </span>
          </div>
        )}

        {noticeToast}

        <main className="relative z-0 grid min-h-0 min-w-[860px] flex-1 grid-cols-[minmax(620px,1fr)_clamp(240px,25vw,320px)] items-stretch gap-3 overflow-hidden p-3 xl:gap-4 xl:p-4">
          {isShiftClosedSuccess ? (
            <div className="col-span-2 min-h-0">
              <ShiftClosedSuccess />
            </div>
          ) : shiftStatus === "OPEN" ? (
            <>
              <InvoicePanel />
              <SpeedDock />
            </>
          ) : null}
        </main>

        <CheckoutModal key={`checkout-${checkoutSession}`} />
        <HeldInvoicesModal key={`held-${modalSession}`} />
        <QuickActionsDrawer
          key={quickActionsOpen ? "qa-open" : "qa-closed"}
          open={quickActionsOpen}
          onClose={() => setQuickActionsOpen(false)}
        />
        <EndShiftModal key={`close-${modalSession}`} />
        <ShiftDetailsModal key={`details-${modalSession}`} />
        <CashMovementModal key={`cash-movement-${modalSession}`} />
        <DebtSettlementModal key={`debt-${modalSession}`} />
        <ExpenseModal key={`expense-${modalSession}`} />
        <SmartSearchModal key={`search-${modalSession}`} />
        <VariantPickerModal key={`variant-picker-${modalSession}`} />
        <AdminHubModal key={`hub-${modalSession}`} />
        <PreviousInvoicesModal />
        <AuditLogTimeline />
        <SecondaryAuthModal />
        <OpenShiftModal />
      </div>

      {lastCompletedInvoice &&
        !hardwareSettings.autoPrintReceipt &&
        printedInvoiceId !== lastCompletedInvoice.syncId && (
          <div className="fixed bottom-24 end-4 z-40 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-xl border border-border bg-surface/95 p-2 text-foreground shadow-overlay backdrop-blur-md print:hidden">
            <span className="flex h-10 items-center px-2 text-sm font-extrabold">
              الإيصال جاهز
            </span>
            <button
              type="button"
              onClick={printReceipt}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-header px-3 text-sm font-extrabold text-primary-foreground shadow-card transition-colors duration-150 hover:bg-header/90 focus-visible:focus-ring active:scale-[0.98]"
            >
              <Printer className="h-4 w-4" aria-hidden="true" /> طباعة
            </button>
            <button
              type="button"
              onClick={() => setPrintedInvoiceId(lastCompletedInvoice.syncId)}
              aria-label="إغلاق تنبيه الإيصال"
              title="إغلاق"
              className="grid h-10 w-10 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-foreground focus-visible:focus-ring active:scale-[0.98]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}

      <ThermalReceipt
        invoice={lastCompletedInvoice}
        paperWidth={hardwareSettings.receiptWidth}
      />
    </>
  );
}
