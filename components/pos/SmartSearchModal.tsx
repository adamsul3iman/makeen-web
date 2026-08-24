"use client";

import { useMemo, useState } from "react";
import Fuse from "fuse.js";
import { Barcode, Minus, PackageSearch, Plus, Search, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatMoney } from "@/lib/format";
import { normalizeArabicText } from "@/lib/arabic";

const MAX_QTY = 999;
const LIMIT = 12;

interface SearchEntry {
  productId: string;
  name: string;
  price: number;
  unitName: string;
  categoryName?: string;
  brandName?: string;
  barcodes: Array<{ code: string; price: number; unitName: string; variantLabel?: string }>;
}

interface ScoredResult {
  entry: SearchEntry;
  score: number;
  /** Set when the query matched a barcode of the product (uses its price). */
  matchedBarcode?: SearchEntry["barcodes"][number];
}

/**
 * Fuzzy index document: one pre-normalized haystack per product covering
 * name + brand + category + every variant label. Arabic normalization runs
 * at INDEX BUILD time, so per-keystroke cost is pure Fuse matching.
 */
interface FuseDoc {
  entry: SearchEntry;
  text: string;
}

/** Tier boundary between exact hits (legacy scorer) and fuzzy hits. */
const EXACT_TIER_SCORE = 10;

function buildFuseIndex(entries: SearchEntry[]): Fuse<FuseDoc> | null {
  if (entries.length === 0) return null;
  const docs: FuseDoc[] = entries.map((entry) => ({
    entry,
    text: normalizeArabicText(
      [
        entry.name,
        entry.brandName ?? "",
        entry.categoryName ?? "",
        ...entry.barcodes.map((b) => b.variantLabel ?? ""),
      ]
        .filter(Boolean)
        .join(" "),
    ),
  }));
  return new Fuse(docs, {
    keys: ["text"],
    // Space-separated tokens are AND-ed independently, so "علامة صنف" and
    // "صنف علامة" match identically — order-free brand+category lookup.
    useExtendedSearch: true,
    ignoreLocation: true,
    threshold: 0.4,
    minMatchCharLength: 2,
  });
}

/**
 * Hybrid ranking:
 *   Tier 0 — exact barcode hit (the scan path must stay O(1) and absolute);
 *   Tier 1 — legacy startsWith/includes scoring on name/barcode/variant;
 *   Tier 2 — Fuse fuzzy matches over the concatenated haystack.
 * Results stay capped at LIMIT with exact tiers always ahead of fuzzy.
 */
function searchEntries(
  entries: SearchEntry[],
  fuse: Fuse<FuseDoc> | null,
  query: string,
): ScoredResult[] {
  const q = normalizeArabicText(query.trim());
  if (!q) {
    return entries.slice(0, LIMIT).map((entry) => ({ entry, score: 0 }));
  }
  const scored: ScoredResult[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const name = normalizeArabicText(entry.name);
    const nameScore =
      name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : -1;
    let matchedBarcode: SearchEntry["barcodes"][number] | undefined;
    let score = nameScore;
    if (score < 0) {
      let best = -1;
      for (const b of entry.barcodes) {
        const code = normalizeArabicText(b.code);
        const variant = normalizeArabicText(b.variantLabel ?? "");
        const barcodeScore = code === q ? 0 : code.startsWith(q) ? 1 : code.includes(q) ? 2 : -1;
        const variantScore = variant === q ? 0 : variant.startsWith(q) ? 1 : variant.includes(q) ? 2 : -1;
        const s = barcodeScore >= 0 && variantScore >= 0
          ? Math.min(barcodeScore, variantScore)
          : Math.max(barcodeScore, variantScore);
        if (s >= 0 && (best < 0 || s < best)) {
          best = s;
          matchedBarcode = b;
        }
      }
      score = best;
    }
    if (score >= 0 && scored.length < LIMIT) {
      scored.push({ entry, score, matchedBarcode });
      seen.add(entry.productId);
    }
  }

  if (fuse) {
    const fuzzyHits = fuse.search(q);
    for (const { item } of fuzzyHits) {
      if (scored.length >= LIMIT) break;
      if (seen.has(item.entry.productId)) continue;
      seen.add(item.entry.productId);
      scored.push({ entry: item.entry, score: EXACT_TIER_SCORE });
    }
  }

  return scored
    .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name, "ar"))
    .slice(0, LIMIT);
}

/**
 * Global keyboard-first product search (Ctrl+K / ⌘K).
 *
 * Hybrid ranking over product names (Arabic-safe), barcodes, brands,
 * categories and variant labels:
 *  - exact/prefix hits win (barcodes stay an O(1) absolute path)
 *  - Fuse.js fuzzy tier matches tokens in ANY order — typing the brand and
 *    category out of order still finds the item
 *
 * Keyboard model mirrors the top-tier registers:
 *  - ArrowUp/ArrowDown: move the selection
 *  - Enter: add the selected item (closes the overlay, barcode input regains focus)
 *  - "/": enter quantity mode, digits build "×N", Enter adds N units
 *  - Escape: close (or cancel quantity mode)
 *
 * Barcode hits add via the barcode's own price/unit (multiplier-aware);
 * name hits add at the product's base price.
 */
export default function SmartSearchModal() {
  const isOpen = usePosStore((s) => s.isSmartSearchOpen);
  const products = usePosStore((s) => s.products);
  const barcodes = usePosStore((s) => s.barcodes);
  const categories = usePosStore((s) => s.categories);
  const closeSmartSearch = usePosStore((s) => s.closeSmartSearch);
  const addSearchItem = usePosStore((s) => s.addSearchItem);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [qtyMode, setQtyMode] = useState(false);
  const [qty, setQty] = useState(0);

  // Debounce the query so a long type-ahead over ~6,600 products never scans
  // the full catalog on every keystroke. The input itself stays instant.
  // Fuse matching on ~6,600 docs is a few ms — an 80ms debounce keeps the
  // input instant while collapsing burst typing into one search pass.
  const debouncedQuery = useDebouncedValue(query, 80);

  const entries = useMemo<SearchEntry[]>(() => {
    const byProduct: Record<string, SearchEntry["barcodes"]> = {};
    for (const code of Object.keys(barcodes)) {
      const b = barcodes[code];
      if (!b) continue;
      const list = (byProduct[b.productId] ??= []);
      list.push({ code, price: b.price, unitName: b.unitName, variantLabel: b.variantLabel });
    }
    const list: SearchEntry[] = [];
    for (const id of Object.keys(products)) {
      const p = products[id];
      if (!p) continue;
      list.push({
        productId: id,
        name: p.name,
        price: p.price,
        unitName: p.baseUnit,
        categoryName: categories[p.categoryId]?.name,
        brandName: p.brandName,
        barcodes: byProduct[id] ?? [],
      });
    }
    return list;
  }, [products, barcodes, categories]);

  // Rebuilt only when the hydrated snapshot changes (loadSnapshot → new
  // products/barcodes/categories references), never per keystroke.
  const fuse = useMemo(() => buildFuseIndex(entries), [entries]);

  const results = useMemo<ScoredResult[]>(
    () => searchEntries(entries, fuse, debouncedQuery),
    [entries, fuse, debouncedQuery],
  );

  const selectedResult = results[Math.min(selected, Math.max(0, results.length - 1))];

  const addSelected = () => {
    // If the user presses Enter inside the debounce window the memoized
    // results are still from the previous query — run one synchronous search
    // against the live query so the right item is added.
    const live =
      query.trim() === debouncedQuery.trim()
        ? selectedResult
        : searchEntries(entries, fuse, query)[0];
    if (!live) return;
    const units = Math.max(1, qty);
    addSearchItem(
      live.entry.productId,
      units,
      live.matchedBarcode?.code,
    );
    closeSmartSearch();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (qtyMode) {
      if (e.key === "Enter") {
        e.preventDefault();
        addSelected();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setQty(0);
        setQtyMode(false);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        const next = Math.floor(qty / 10);
        if (next === 0) {
          setQty(0);
          setQtyMode(false);
        } else {
          setQty(next);
        }
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setQty((prev) => Math.min(prev * 10 + Number(e.key), MAX_QTY));
        return;
      }
      // Any other key leaves quantity mode; the keystroke then types into the search.
      setQty(0);
      setQtyMode(false);
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        addSelected();
        break;
      case "Escape":
        e.preventDefault();
        closeSmartSearch();
        break;
      case "/":
      case "÷":
        e.preventDefault();
        setQty(0);
        setQtyMode(true);
        break;
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      dir="rtl"
      onClick={closeSmartSearch}
    >
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-lg font-bold">بحث سريع عن الأصناف</h2>
              <p className="text-xs text-muted-foreground">Ctrl+K • الاسم أو الباركود</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={closeSmartSearch}
            className="relative z-50 grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="border-b border-border px-5 py-3">
          <div className="flex items-center gap-2 rounded-xl bg-surface-muted px-3 py-2.5 focus-within:ring-2 focus-within:ring-primary/30">
            {qtyMode ? (
              <span className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-sm font-black tabular-nums text-primary-foreground">
                ×{qty > 0 ? qty : ""}
              </span>
            ) : (
              <Search className="h-5 w-5 shrink-0 text-muted" />
            )}
            <input
              id="pos-smart-search-input"
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={qtyMode ? "أدخل الكمية ثم Enter" : "اكتب اسم الصنف أو امسح الباركود..."}
              className="w-full bg-transparent text-base font-bold outline-none placeholder:font-medium placeholder:text-muted-foreground"
            />
            {qtyMode && (
              <button
                type="button"
                aria-label="إلغاء الكمية"
                onClick={() => {
                  setQty(0);
                  setQtyMode(false);
                }}
                className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs font-bold text-muted transition hover:bg-surface"
              >
                إلغاء
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[45vh] min-h-0 overflow-y-auto scrollbar-hidden">
          {results.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <PackageSearch className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-base font-bold text-muted">لا توجد نتائج مطابقة</p>
              <p className="text-sm text-muted-foreground">
                تحقق من الاسم أو الباركود ثم أعد المحاولة
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results.map(({ entry, matchedBarcode }, i) => {
                const active = i === selected;
                const price = matchedBarcode?.price ?? entry.price;
                const unit = matchedBarcode?.unitName ?? entry.unitName;
                return (
                  <li key={entry.productId}>
                    <button
                      type="button"
                      onMouseEnter={() => setSelected(i)}
                      onClick={() => {
                        setSelected(i);
                        addSelected();
                      }}
                      className={`flex w-full items-center gap-3 px-5 py-3 text-right transition ${
                        active ? "bg-primary/5" : "hover:bg-surface-muted/60"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-base font-bold ${active ? "text-primary" : ""}`}>
                          {entry.name}
                        </p>
                        <p className="truncate text-xs text-muted">
                          {[entry.categoryName, matchedBarcode?.variantLabel, unit].filter(Boolean).join(" • ") || "—"}
                        </p>
                        {matchedBarcode && (
                          <p className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                            <Barcode className="h-3 w-3" />
                            <span dir="ltr">{matchedBarcode.code}</span>
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 text-base font-black tabular-nums">
                        {formatMoney(price)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="إنقاص الكمية"
              onClick={() => {
                setQtyMode(true);
                setQty((prev) => Math.max(1, (qtyMode ? prev : 1) - 1));
              }}
              className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-surface-muted"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-10 text-center text-sm font-black tabular-nums">
              ×{qtyMode ? Math.max(1, qty) : 1}
            </span>
            <button
              type="button"
              aria-label="زيادة الكمية"
              onClick={() => {
                setQtyMode(true);
                setQty((prev) => Math.min((qtyMode ? prev : 1) + 1, MAX_QTY));
              }}
              className="grid h-8 w-8 place-items-center rounded-lg border border-border text-primary transition hover:bg-surface-muted"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <p className="text-[11px] font-semibold text-muted-foreground">
            ↑↓ للتنقل • Enter للإضافة • / للكمية • Esc للإغلاق
          </p>
        </footer>
      </div>
    </div>
  );
}
