# MAKEEN Branding Assets

Central location for all brand assets and logo variants.

## Directory Structure

```
assets/branding/
├── vector/        # Master SVG source files
├── app-icons/     # Desktop & mobile app icons
├── web/           # Web/landing page logos
└── social/        # Social media & marketing banners
```

## Folder Guidelines

### `vector/`
- **Format:** SVG (master files)
- **Use:** Source of truth for all logo variations. Edit these first, then export to other formats.
- **Naming:** `logo-full.svg`, `logo-mark.svg`, `logo-wordmark.svg`

### `app-icons/`
- **Format:** PNG (no alpha on Windows .ico)
- **Required sizes:**
  - 256x256 — Windows `.ico` source
  - 512x512 — Electron app icon, high-res displays
  - 1024x1024 — macOS icon source (if needed later)
- **Naming:** `icon-256.png`, `icon-512.png`

### `web/`
- **Format:** PNG with transparency, SVG preferred
- **Use:** Landing page, login screen, dashboard header
- **Variants:**
  - `logo-dark.png` — for light backgrounds
  - `logo-light.png` — for dark backgrounds
  - `favicon.ico` — browser tab icon
- **Dimensions:** Height 40–80px for header logos, 200–400px for hero sections

### `social/`
- **Format:** PNG, JPEG
- **Use:** GitHub README banner, social previews, marketing materials
- **Recommended dimensions:**
  - GitHub social preview: 1280x640px
  - Twitter/X card: 1200x675px
  - LinkedIn banner: 1584x396px
