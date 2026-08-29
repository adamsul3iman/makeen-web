import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "h-11 w-full rounded-xl border border-border/70 bg-surface px-3 text-sm font-semibold text-foreground outline-none transition-colors duration-150 placeholder:font-medium placeholder:text-muted-foreground focus:border-border/60 focus-visible:ring-2 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted-foreground disabled:opacity-70",
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = "Input";
