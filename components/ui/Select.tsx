"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Calendar, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: ReactNode;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

interface DropdownPosition {
  left: number;
  top: number;
  maxHeight: number;
}

const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;

export function Select({
  value,
  onChange,
  options,
  placeholder = "اختر",
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: SelectProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuDir, setMenuDir] = useState<"rtl" | "ltr">("rtl");

  const toggleOpen = () => {
    if (!open && buttonRef.current) {
      setMenuDir(getComputedStyle(buttonRef.current).direction === "ltr" ? "ltr" : "rtl");
    }
    setOpen((current) => !current);
  };

  const selectedOption = options.find((option) => option.value === value);
  const activeOption = activeIndex >= 0 ? options[activeIndex] : undefined;

  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;

    const buttonRect = button.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const menuWidth = Math.min(buttonRect.width, viewportWidth - VIEWPORT_MARGIN * 2);
    const documentDir = getComputedStyle(button).direction || "rtl";
    const preferredLeft =
      documentDir === "rtl" ? buttonRect.right - menuWidth : buttonRect.left;
    const left = Math.min(
      Math.max(preferredLeft, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewportWidth - menuWidth - VIEWPORT_MARGIN),
    );

    const spaceBelow = viewportHeight - buttonRect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const spaceAbove = buttonRect.top - MENU_GAP - VIEWPORT_MARGIN;
    const menuHeight = Math.min(menu.scrollHeight, 280);
    const openAbove = menuHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(0, openAbove ? spaceAbove : spaceBelow);
    const top = openAbove
      ? Math.max(VIEWPORT_MARGIN, buttonRect.top - MENU_GAP - Math.min(menuHeight, maxHeight))
      : buttonRect.bottom + MENU_GAP;

    setPosition((current) => {
      if (
        current &&
        Math.abs(current.left - left) < 1 &&
        Math.abs(current.top - top) < 1 &&
        current.maxHeight === maxHeight
      ) {
        return current;
      }
      return { left, top, maxHeight };
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    const resizeObserver = new ResizeObserver(updatePosition);
    const nodes: Element[] = [];
    if (buttonRef.current) nodes.push(buttonRef.current);
    if (menuRef.current) nodes.push(menuRef.current);
    nodes.forEach((node) => resizeObserver.observe(node));
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      resizeObserver.disconnect();
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const initialIndex = selectedOption
      ? options.findIndex((option) => option.value === value)
      : -1;
    Promise.resolve().then(() => setActiveIndex(initialIndex >= 0 ? initialIndex : -1));
  }, [open, options, selectedOption, value]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const activeElement = menuRef.current?.querySelector<HTMLElement>("[data-index]");
    activeElement?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const commitIndex = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option) return;
      onChange(option.value);
      close();
      buttonRef.current?.focus();
    },
    [onChange, options, close],
  );

  return (
    <div className={cn("relative min-w-0", className)}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        onClick={toggleOpen}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => {
              const base = index < 0 ? 0 : index;
              const next = event.key === "ArrowDown" ? base + 1 : base - 1;
              return (next + options.length) % options.length;
            });
          } else if (event.key === "Enter") {
            event.preventDefault();
            const option = options[activeIndex];
            if (option) commitIndex(activeIndex);
          } else if (event.key === "Home") {
            event.preventDefault();
            setActiveIndex(0);
          } else if (event.key === "End") {
            event.preventDefault();
            setActiveIndex(options.length - 1);
          }
        }}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-white px-3 text-sm font-bold text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-primary/60 ring-2 ring-primary/20",
          !selectedOption && "text-muted-foreground",
        )}
      >
        <span className="min-w-0 truncate text-start">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-[60]"
                aria-hidden="true"
                onPointerDown={close}
              />
              <ul
                ref={menuRef}
                id={listboxId}
                role="listbox"
                dir={menuDir}
                className="fixed z-[70] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-surface py-1 text-foreground shadow-overlay"
                style={{
                  left: position?.left ?? VIEWPORT_MARGIN,
                  top: position?.top ?? VIEWPORT_MARGIN,
                  maxHeight: position?.maxHeight,
                  visibility: position ? "visible" : "hidden",
                }}
                onMouseDown={(event) => {
                  const item = (event.target as HTMLElement).closest("[data-value]");
                  if (!item) return;
                  event.preventDefault();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    close();
                    buttonRef.current?.focus();
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((index) =>
                      options.length === 0
                        ? -1
                        : (index + 1 + options.length) % options.length,
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((index) =>
                      options.length === 0 ? -1 : (index - 1 + options.length) % options.length,
                    );
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    if (activeOption) commitIndex(activeIndex);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    setActiveIndex(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    setActiveIndex(options.length - 1);
                  }
                }}
              >
                {options.map((option, index) => {
                  const selected = option.value === value;
                  const active = index === activeIndex;
                  return (
                    <li
                      key={option.value}
                      data-value={option.value}
                      data-index={index}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => commitIndex(index)}
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-bold text-foreground transition-colors",
                        active ? "bg-surface-muted" : "hover:bg-surface-muted",
                        selected && "text-primary-strong",
                      )}
                    >
                      <span className="min-w-0 truncate">{option.label}</span>
                      {selected && <Check className="h-4 w-4 shrink-0" />}
                    </li>
                  );
                })}
              </ul>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

const DATE_INPUT_CLS =
  "h-10 w-full min-w-0 appearance-none rounded-lg border border-border bg-white pl-9 pr-3 text-sm font-bold text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0";

export interface DateFieldProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  id?: string;
}

export function DateField({ value, onChange, className, id }: DateFieldProps) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <input
        id={id}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={DATE_INPUT_CLS}
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-muted"
        aria-hidden="true"
      >
        <Calendar className="h-4 w-4" />
      </span>
    </div>
  );
}
