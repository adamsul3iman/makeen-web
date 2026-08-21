"use client";

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

type DropdownAlign = "start" | "end";

interface DropdownPosition {
  left: number;
  top: number;
  maxHeight: number;
}

export interface DropdownMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  align?: DropdownAlign;
  direction?: "rtl" | "ltr";
  sideOffset?: number;
  viewportMargin?: number;
  className?: string;
  label?: string;
}

export function DropdownMenu({
  open,
  anchorRef,
  onClose,
  children,
  align = "start",
  direction,
  sideOffset = 8,
  viewportMargin = 8,
  className,
  label,
}: DropdownMenuProps) {
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<DropdownPosition | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const menuWidth = Math.min(menuRect.width, viewportWidth - viewportMargin * 2);
    const menuHeight = menu.scrollHeight;
    const resolvedDirection = direction ?? getComputedStyle(anchor).direction;
    const alignToStart = align === "start";

    const preferredLeft =
      resolvedDirection === "rtl"
        ? alignToStart
          ? anchorRect.right - menuWidth
          : anchorRect.left
        : alignToStart
          ? anchorRect.left
          : anchorRect.right - menuWidth;
    const left = Math.min(
      Math.max(preferredLeft, viewportMargin),
      Math.max(viewportMargin, viewportWidth - menuWidth - viewportMargin),
    );

    const spaceBelow = viewportHeight - anchorRect.bottom - sideOffset - viewportMargin;
    const spaceAbove = anchorRect.top - sideOffset - viewportMargin;
    const openAbove = menuHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(0, openAbove ? spaceAbove : spaceBelow);
    const top = openAbove
      ? Math.max(viewportMargin, anchorRect.top - sideOffset - Math.min(menuHeight, maxHeight))
      : anchorRect.bottom + sideOffset;

    setPosition((current) => {
      if (
        current &&
        current.left === left &&
        current.top === top &&
        current.maxHeight === maxHeight
      ) {
        return current;
      }
      return { left, top, maxHeight };
    });
  }, [align, anchorRef, direction, sideOffset, viewportMargin]);

  useLayoutEffect(() => {
    if (!open) return;

    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    const resizeObserver = new ResizeObserver(updatePosition);
    if (anchorRef.current) resizeObserver.observe(anchorRef.current);
    if (menuRef.current) resizeObserver.observe(menuRef.current);

    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      resizeObserver.disconnect();
    };
  }, [anchorRef, open, updatePosition]);

  useLayoutEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [anchorRef, onClose, open]);

  if (!open || typeof document === "undefined") return null;

  const resolvedDirection = direction ?? "rtl";

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[60]"
        aria-hidden="true"
        onPointerDown={onClose}
      />
      <div
        id={menuId}
        ref={menuRef}
        role="menu"
        aria-label={label}
        dir={resolvedDirection}
        className={cn(
          "fixed z-[70] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-surface p-1.5 text-foreground shadow-overlay [scrollbar-gutter:stable]",
          className,
        )}
        style={{
          left: position?.left ?? viewportMargin,
          top: position?.top ?? viewportMargin,
          maxHeight: position?.maxHeight,
          visibility: position ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
