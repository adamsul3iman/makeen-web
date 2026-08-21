import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-foreground outline-none transition-colors duration-150 placeholder:font-medium placeholder:text-muted-foreground focus:border-primary focus-visible:focus-ring disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted-foreground disabled:opacity-70",
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = "Input";
