"use client";

import { useState } from "react";
import { Banknote, Building2, Lock, MonitorSmartphone } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { usePosStore } from "@/store/usePosStore";
import Logo from "@/components/shared/Logo";

/**
 * Full-screen, non-dismissible register lock. Shown whenever the shift
 * is CLOSED; the POS cannot be used until a shift is opened. There is
 * deliberately no close button or Escape handling — opening a shift is
 * the only way forward.
 *
 * Phase 26: the cashier picks which branch (فرع) and terminal (كاشير) this
 * register runs, defaulting to the auto-seeded main branch/register.
 */
export default function OpenShiftModal() {
  const shiftStatus = usePosStore((s) => s.shiftState.status);
  const isShiftClosedSuccess = usePosStore((s) => s.isShiftClosedSuccess);
  const openShift = usePosStore((s) => s.openShift);
  const selectTerminal = usePosStore((s) => s.selectTerminal);
  const branches = usePosStore((s) => s.branches);
  const terminals = usePosStore((s) => s.terminals);
  const activeBranchId = usePosStore((s) => s.activeBranchId);
  const activeTerminalId = usePosStore((s) => s.activeTerminalId);
  const [cash, setCash] = useState("");

  // Selection lives in the store (set at login / by setBranchesAndTerminals),
  // so the modal simply reads the active branch/terminal once the registry
  // arrives instead of mirroring it into local state.
  const branchId = activeBranchId ?? branches[0]?.id ?? "";
  const branchTerminals = (terminals ?? []).filter((t) => t.branchId === branchId);
  const terminalId =
    activeTerminalId && branchTerminals.some((t) => t.id === activeTerminalId)
      ? activeTerminalId
      : branchTerminals[0]?.id ?? terminals[0]?.id ?? "";

  if (isShiftClosedSuccess) return null;
  if (shiftStatus !== "CLOSED") return null;

  const hasRegistry = branches.length > 0;
  const startingCash = parseFloat(cash) || 0;
  const canOpen = startingCash >= 0 && (!hasRegistry || Boolean(branchId && terminalId));

  const pickBranch = (id: string) => {
    const firstTerminal = (terminals ?? []).find((t) => t.branchId === id)?.id ?? "";
    selectTerminal(id, firstTerminal);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (canOpen) void openShift(startingCash, branchId || undefined, terminalId || undefined);
  };

  return (
    <ModalShell
      title="فتح وردية جديدة"
      description="الوردية مغلقة — افتح وردية للمتابعة"
      dismissible={false}
      size="md"
      height="lg"
      bodyClassName="p-6 sm:p-8"
      footer={
        <div className="space-y-3">
          <button
            type="submit"
            form="open-shift-form"
            disabled={!canOpen}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-lg font-black text-success-foreground shadow-card transition hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Banknote className="h-5 w-5" />
            فتح الوردية
          </button>
          <p className="flex items-center justify-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            الكاشير مقفل حتى تُفتح وردية جديدة
          </p>
        </div>
      }
    >
      <Logo className="mx-auto mb-5 h-20 w-20" />

      <h1 className="text-center text-2xl font-black text-foreground">MAKEEN</h1>

      <form id="open-shift-form" onSubmit={handleSubmit} className="mt-6 space-y-4">
          {hasRegistry && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="shift-branch"
                  className="mb-1.5 flex items-center gap-1 text-sm font-bold text-muted"
                >
                  <Building2 className="h-3.5 w-3.5" />
                  الفرع
                </label>
                <select
                  id="shift-branch"
                  value={branchId}
                  onChange={(e) => pickBranch(e.target.value)}
                  className="h-11 w-full rounded-xl border border-border bg-surface-muted px-3 text-sm font-bold text-foreground outline-none transition focus:border-primary focus-visible:focus-ring"
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="shift-terminal"
                  className="mb-1.5 flex items-center gap-1 text-sm font-bold text-muted"
                >
                  <MonitorSmartphone className="h-3.5 w-3.5" />
                  الكاشير
                </label>
                <select
                  id="shift-terminal"
                  value={terminalId}
                  onChange={(e) => selectTerminal(branchId, e.target.value)}
                  className="h-11 w-full rounded-xl border border-border bg-surface-muted px-3 text-sm font-bold text-foreground outline-none transition focus:border-primary focus-visible:focus-ring"
                >
                  {branchTerminals.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div>
            <label
              htmlFor="shift-opening-cash"
              className="mb-2 block text-sm font-bold text-muted"
            >
              العهدة (النقد الموجود في الصندوق عند البداية)
            </label>
            <input
              id="shift-opening-cash"
              autoFocus
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={cash}
              onChange={(e) => setCash(e.target.value)}
              className="min-h-14 w-full rounded-xl border border-border bg-surface px-4 py-3 text-center text-3xl font-black tabular-nums text-foreground outline-none transition focus:border-primary focus-visible:focus-ring"
            />
          </div>
      </form>
    </ModalShell>
  );
}
