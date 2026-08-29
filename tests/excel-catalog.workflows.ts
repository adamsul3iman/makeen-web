/**
 * Excel catalog round-trip (parse/pure) suite — runs via tsx, no server needed.
 *
 * Validates the flat-file parsing and grouping logic in lib/excelCatalog.ts
 * (parseCatalogExcel) and the flattened unit grain. DB writes are NOT
 * exercised here (they need a live Supabase); this locks the file-shape and
 * group-normalization invariants that the import depends on.
 */

import { parseCatalogExcel, parseCatalogDetailed, exportCatalogTemplate, EXCEL_COLUMNS, CATALOG_FORMAT } from "../lib/excelCatalog";

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

  // ── Hidden IDs captured (pillar 1) ───────────────────────────────────
  const buf4 = await buildWorkbook([
    {
      SKU: "400",
      VariantLabel: "أحمر",
      ParentName: "منتج بمعرفات",
      UnitName: "قطعة",
      Cost: 2,
      Price: 3,
      ProductID: "prod-abc",
      VariantID: "var-123",
      UnitID: "unit-456",
    },
  ]);
  const groups4 = await parseCatalogExcel(buf4);
  const g4 = groups4[0];
  check("productId captured", g4.productId === "prod-abc");
  check("variantId captured", g4.variants[0]?.variantId === "var-123");
  check("unitId captured", g4.units[0]?.unitId === "unit-456");

  // ── Data shield: blank cells are NOT marked present (pillar 2) ───────
  check("Cost present flag set", g4.present.has("Cost"));
  check("Price present flag set", g4.present.has("Price"));
  check("blank TaxPercent not present", !g4.present.has("TaxPercent"));
  check("blank IsActive not present", !g4.present.has("IsActive"));

  // ── Dry-run errors: duplicate SKU across two parents (pillar 4) ──────
  const buf5 = await buildWorkbook([
    { SKU: "999", ParentName: "منتج أ", UnitName: "قطعة" },
    { SKU: "999", ParentName: "منتج ب", UnitName: "قطعة" },
  ]);
  const parsed5 = await parseCatalogDetailed(buf5);
  check(
    "duplicate SKU across parents flagged",
    parsed5.errors.some((e) => e.includes("999")),
  );
  check("only one group from clean rows", parsed5.groups.length === 1);

  // ── Dry-run errors: missing required fields (pillar 4) ───────────────
  const buf6 = await buildWorkbook([{ ParentName: "بلا باركود" }]);
  const parsed6 = await parseCatalogDetailed(buf6);
  check("missing SKU flagged", parsed6.errors.length === 1);
  check("no group for invalid row", parsed6.groups.length === 0);

  // ── Blank template: headers present, zero product rows ───────────────
  const XLSX = await import("xlsx");
  const templateBuf = (await exportCatalogTemplate("test-store")).arrayBuffer();
  const templateArr = await templateBuf;
  const tbook = XLSX.read(templateArr, { type: "array" });
  const tsheet = tbook.Sheets[tbook.SheetNames.find((n) => n === "المنتجات")!];
  const trows = XLSX.utils.sheet_to_json<Record<string, unknown>>(tsheet, { defval: null });
  check("template has no product rows", trows.length === 0);
  const headers = XLSX.utils.sheet_to_json<Record<string, unknown>>(tsheet, { header: 1, defval: null })[0] as unknown[];
  check(
    "template headers match export columns",
    (headers ?? []).length === EXCEL_COLUMNS.length &&
      EXCEL_COLUMNS.every((c, i) => headers?.[i] === c),
  );
  check("template has _meta sheet", tbook.SheetNames.includes("_meta"));

  check(
    "hidden ID columns present",
    ["ProductID", "VariantID", "UnitID"].every((c) => EXCEL_COLUMNS.includes(c as (typeof EXCEL_COLUMNS)[number])),
  );

  // ── Version contract: _meta format validation (QA bug fix) ───────────
  async function buildWorkbookWithMeta(format: string): Promise<ArrayBuffer> {
    const X = await import("xlsx");
    const sheet = X.utils.json_to_sheet([{ SKU: "777", ParentName: "منتج إصدار", UnitName: "قطعة" }]);
    const meta = X.utils.json_to_sheet([{ key: "format", value: format }]);
    const book = X.utils.book_new();
    X.utils.book_append_sheet(book, sheet, "المنتجات");
    X.utils.book_append_sheet(book, meta, "_meta");
    return X.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  }

  const v3buf = await buildWorkbookWithMeta(CATALOG_FORMAT);
  const parsedV3 = await parseCatalogExcel(v3buf);
  check("v3 meta accepted", parsedV3.length === 1);

  const v2buf = await buildWorkbookWithMeta("pos-catalog-v2");
  let rejectedV2 = false;
  try {
    await parseCatalogExcel(v2buf);
  } catch {
    rejectedV2 = true;
  }
  check("v2 meta rejected", rejectedV2 === true);

  console.log(`\nExcel catalog round-trip: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
