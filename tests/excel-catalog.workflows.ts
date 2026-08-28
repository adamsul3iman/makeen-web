/**
 * Excel catalog round-trip (parse/pure) suite — runs via tsx, no server needed.
 *
 * Validates the flat-file parsing and grouping logic in lib/excelCatalog.ts
 * (parseCatalogExcel) and the flattened unit grain. DB writes are NOT
 * exercised here (they need a live Supabase); this locks the file-shape and
 * group-normalization invariants that the import depends on.
 */

import { parseCatalogExcel } from "../lib/excelCatalog";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${label}`);
  }
}

async function buildWorkbook(rows: Record<string, unknown>[]): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "المنتجات");
  return XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

async function run() {
  // ── Scenario: single product, two variants, two units ────────────────
  // Flattened grain = one row per (variant × unit) => 2 × 2 = 4 rows.
  // Parent + variant fields repeat on every unit row.
  const buf1 = await buildWorkbook([
    {
      SKU: "111",
      VariantLabel: "أحمر",
      ParentName: "كوب",
      Brand: "Acme",
      Department: "منزلية",
      Categories: "منزلية, أكواب",
      BaseUnit: "قطعة",
      UnitName: "قطعة",
      UnitMultiplier: 1,
      UnitCost: 0.5,
      UnitPrice: 1,
      UnitWholesale: 0.8,
      UnitIsDefaultSale: "1",
      UnitIsDefaultPurchase: "1",
      Cost: 1,
      Price: 1.5,
      WholesalePrice: 1.2,
      Stock: 10,
      TaxIncluded: "TRUE",
      TaxPercent: 16,
    },
    {
      SKU: "111",
      VariantLabel: "أحمر",
      ParentName: "كوب",
      Brand: "Acme",
      Department: "منزلية",
      Categories: "منزلية, أكواب",
      BaseUnit: "قطعة",
      UnitName: "كرتون",
      UnitMultiplier: 24,
      UnitCost: 11,
      UnitPrice: 20,
      UnitWholesale: 18,
      UnitBarcode: "221",
      UnitIsDefaultSale: "0",
      UnitIsDefaultPurchase: "0",
      Cost: 1,
      Price: 1.5,
      WholesalePrice: 1.2,
      Stock: 10,
      TaxIncluded: "TRUE",
      TaxPercent: 16,
    },
    {
      SKU: "112",
      VariantLabel: "أزرق",
      ParentName: "كوب",
      Brand: "Acme",
      Department: "منزلية",
      Categories: "منزلية, أكواب",
      BaseUnit: "قطعة",
      UnitName: "قطعة",
      UnitCost: 0.5,
      UnitPrice: 1,
      UnitWholesale: 0.8,
      Cost: 1.1,
      Price: 1.7,
      WholesalePrice: 1.3,
      Stock: 5,
    },
    {
      SKU: "112",
      VariantLabel: "أزرق",
      ParentName: "كوب",
      Brand: "Acme",
      Department: "منزلية",
      Categories: "منزلية, أكواب",
      BaseUnit: "قطعة",
      UnitName: "كرتون",
      UnitCost: 11,
      UnitPrice: 20,
      UnitWholesale: 18,
      UnitBarcode: "221",
      Cost: 1.1,
      Price: 1.7,
      WholesalePrice: 1.3,
      Stock: 5,
    },
  ]);

  const groups = await parseCatalogExcel(buf1);
  check("parsed exactly 1 product group", groups.length === 1);
  const g = groups[0];

  check("product name preserved", g.productName === "كوب");
  check("brand resolved", g.brand === "Acme");
  check("department resolved", g.department === "منزلية");
  check("multi-category split (2)", g.categories.length === 2 && g.categories.includes("أكواب"));
  check("tax percent parsed", g.taxPercent === 16);
  check("tax included defaults true", g.taxIncluded === true);

  check("two variants merged (no dups)", g.variants.length === 2);
  const v1 = g.variants.find((v) => v.barcode === "111");
  const v2 = g.variants.find((v) => v.barcode === "112");
  check("variant 1 label", v1?.label === "أحمر");
  check("variant 1 stock", v1?.stock === 10);
  check("variant 1 explicit price wins", v1?.sellingPrice === 1.5);
  check("variant 2 label", v2?.label === "أزرق");
  check("variant 2 stock", v2?.stock === 5);
  check("variant 2 explicit price wins", v2?.sellingPrice === 1.7);

  check("two units deduped (not x4)", g.units.length === 2);
  const piece = g.units.find((u) => u.unitName === "قطعة");
  const carton = g.units.find((u) => u.unitName === "كرتون");
  check("piece multiplier 1", piece?.qtyMultiplier === 1);
  check("piece is default sale", piece?.isDefaultSale === true);
  check("piece is default purchase", piece?.isDefaultPurchase === true);
  check("carton multiplier 24", carton?.qtyMultiplier === 24);
  check("carton barcode 221", carton?.barcode === "221");
  check("carton not default sale", carton?.isDefaultSale === false);

  // ── Blank price inherits parent; no units ────────────────────────────
  const buf2 = await buildWorkbook([
    {
      SKU: "200",
      VariantLabel: "",
      ParentName: "منتج جديد",
      Cost: 3,
      Price: 4,
      Stock: 0,
    },
  ]);
  const groups2 = await parseCatalogExcel(buf2);
  check("blank-unit group parsed", groups2.length === 1);
  const g2 = groups2[0];
  check("no units when blank", g2.units.length === 0);
  check("parent price kept", g2.sellingPrice === 4 && g2.costPrice === 3);

  // ── Unit barcode absent → null-safe ──────────────────────────────────
  const buf3 = await buildWorkbook([
    {
      SKU: "300",
      ParentName: "بدون وحدة باركود",
      UnitName: "قطعة",
      UnitMultiplier: 1,
      UnitCost: 0,
      UnitPrice: 1,
    },
  ]);
  const groups3 = await parseCatalogExcel(buf3);
  check("unit without barcode parsed", groups3[0].units[0].barcode === null);

  console.log(`\nExcel catalog round-trip: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
