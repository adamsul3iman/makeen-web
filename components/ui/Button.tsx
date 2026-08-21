import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-bold transition-colors duration-150 focus-visible:focus-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-card hover:bg-primary-hover",
        outline:
          "border border-border bg-surface text-foreground shadow-card hover:bg-surface-muted",
        ghost: "text-muted hover:bg-surface-muted hover:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground shadow-card hover:bg-destructive-hover",
      },
      size: {
        sm: "h-9 rounded-lg px-3 text-xs",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-5 text-base font-black",
        icon: "h-10 w-10 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, type = "button", variant, size, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);

Button.displayName = "Button";

export { buttonVariants };
