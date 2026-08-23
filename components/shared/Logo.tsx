import type { CSSProperties } from "react";

/**
 * MAKEEN (مَكِين) brand logo. Renders the official raster logo from the
 * public folder with responsive sizing. Per spec this must stay a plain
 * <img> tag — NO inline SVG.
 *
 * The logo images live at:
 *   - /logo.png            (default, dark variant for light backgrounds)
 *   - /web/logo-light.png  (light variant for dark backgrounds)
 */
export default function Logo({
  className = "h-10 w-10",
  style,
  alt = "MAKEEN",
  variant = "dark",
}: {
  className?: string;
  style?: CSSProperties;
  alt?: string;
  variant?: "dark" | "light";
}) {
  const src = variant === "light" ? "/web/makeen-logo-light.png" : "/logo.png";

  return (
    // MAKEEN uses the official raster logo via a plain <img> (per spec — no SVG).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      width={160}
      height={160}
      className={`shrink-0 rounded-xl object-contain ${className}`}
      style={style}
    />
  );
}
