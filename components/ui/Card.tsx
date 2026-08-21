import type { ReactNode } from "react";

export function Card({
  title,
  icon,
  action,
  children,
  className = "",
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2 min-w-0">
            {icon && <span className="shrink-0 text-muted">{icon}</span>}
            <h2 className="truncate text-sm font-black text-foreground">{title}</h2>
          </div>
          {action}
        </header>
      )}
      <div className="flex-1 p-5">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  subtitle,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  tone?: "default" | "success" | "destructive" | "primary" | "warning";
}) {
  const toneClasses = {
    default: "text-foreground",
    success: "text-success",
    destructive: "text-destructive",
    primary: "text-primary",
    warning: "text-warning-strong",
  };
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-muted">{label}</p>
        <Icon className="h-4 w-4 text-muted" />
      </div>
      <p className={`mt-2 text-2xl font-black tabular-nums ${toneClasses[tone]}`}>{value}</p>
      {subtitle && <p className="mt-1 text-xs font-semibold text-muted">{subtitle}</p>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="animate-pos-float mb-4 h-12 w-12 text-muted-foreground" />
      <p className="text-sm font-black text-foreground">{title}</p>
      {description && <p className="mt-1 text-xs font-semibold text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-black text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 text-sm font-semibold text-muted">{subtitle}</p>}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  );
}
