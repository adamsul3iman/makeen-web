/**
 * Lightweight admin toast — renders a temporary DOM element using the existing
 * `animate-pos-toast` animation. No external library needed.
 */

const TOAST_DURATION = 3000;

type ToastTone = "success" | "error" | "info";

const TONE_STYLES: Record<ToastTone, string> = {
  success: "bg-green-600 text-white",
  error: "bg-destructive text-white",
  info: "bg-foreground text-background",
};

export function showAdminToast(message: string, tone: ToastTone = "success"): void {
  if (typeof document === "undefined") return;

  const el = document.createElement("div");
  el.className = `animate-pos-toast fixed left-1/2 top-4 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold shadow-2xl ${TONE_STYLES[tone]}`;
  el.textContent = message;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  document.body.appendChild(el);

  setTimeout(() => {
    el.style.transition = "opacity 200ms";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  }, TOAST_DURATION);
}
