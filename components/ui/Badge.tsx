type BadgeTone = "default" | "primary" | "success" | "destructive" | "warning" | "muted";

const TONE_CLASSES: Record<BadgeTone, string> = {
  default: "bg-surface-muted text-muted",
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  destructive: "bg-destructive/10 text-destructive",
  warning: "bg-amber-100 text-amber-700",
  muted: "bg-surface-muted text-muted-foreground",
};

export function Badge({
  children,
  tone = "default",
  className = "",
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-black tabular-nums ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
