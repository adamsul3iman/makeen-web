import type { CSSProperties } from "react";

/**
 * MAKEEN (مَكِين) brand logo. Renders the official raster logo from the
 * public folder with responsive sizing. Per spec this must stay a plain
 * <img> tag — NO inline SVG.
 *
 * NOTE: the logo image lives at `public/logo.png`. Ensure the official file
 * is copied there before deploying (see CODEX_HANDOVER.md).
 */
export default function Logo({
  className = "h-10 w-10",
  style,
  alt = "MAKEEN",
}: {
  className?: string;
  style?: CSSProperties;
  alt?: string;
}) {
  return (
    // MAKEEN uses the official raster logo via a plain <img> (per spec — no SVG).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt={alt}
      width={160}
      height={160}
      className={`shrink-0 rounded-xl object-contain ${className}`}
      style={style}
    />
  );
}
