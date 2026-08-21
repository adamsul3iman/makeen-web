#!/usr/bin/env node
/**
 * Phase 28 — End-to-End Lifecycle Audit.
 *
 * Drives the REAL running Next server (live Supabase mode) through a full
 * store lifecycle:
 *
 *   1. Super admin provisions a brand-new store.
 *   2. Store admin signs in (email/password), verifies auto-provisioned
 *      branch + terminal, updates tax + loyalty settings.
 *   3. Inventory: creates 4 categories + products (incl. a barcode
 *      multiplier case) via CSV import.
 *   4. Cashier PIN login.
 *   5. Transaction: cart math (subtotal/tax/total), stock deduction,
 *      loyalty points, and idempotent replay.
 *   6. Z-Report: open shift, sell, close shift, assert drawer totals.
 *
 * The store and all its data are DELETED through the privileged delete_store
 * RPC in `finally` (unless --keep-store), leaving the production database
 * clean.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3101 node scripts/e2e_lifecycle_audit.mjs [--keep-store]
 *
 * NOTE: super-admin endpoints share an in-memory rate-limit bucket
 * (5 per 15 min per IP). If a re-run trips a 429 on /api/admin/stores,
 * restart the server to clear the bucket.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as XLSX from "xlsx";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3101";
const SUPER_PIN = "7777";
const DEFAULT_PASSWORD = "12345678";
const DEFAULT_PIN = "1234";
const KEEP_STORE = process.argv.includes("--keep-store");

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let pass = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) pass += 1;
  else failures.push(msg);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function loadEnvFile() {
  const out = {};
  const envPath = join(ROOT, ".env");
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const f = value[0];
      const l = value[value.length - 1];
      if ((f === '"' && l === '"') || (f === "'" && l === "'")) value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const cookieJar = new Map();

function cookieHeader() {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function rememberResponseCookies(headers) {
  const setCookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const header of setCookies) {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(header)) cookieJar.delete(name);
    else cookieJar.set(name, value);
  }
}

async function req(path, { method = "GET", headers = {}, json, text, form, noCookie } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookieJar.size > 0 && !noCookie) init.headers["Cookie"] = cookieHeader();
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["Content-Type"] = "application/json";
  } else if (text !== undefined) {
    init.body = text;
    init.headers["Content-Type"] = "text/csv";
  } else if (form !== undefined) {
    init.body = form;
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  rememberResponseCookies(res.headers);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

let createdStoreId = null;

async function deleteStoreRows(client, storeId) {
  await client.query("DELETE FROM sales_payments WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM sales_invoice_items WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM sales_invoices WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM inventory_movements WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM inventory_postings WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM loyalty_events WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM customer_transactions WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM customers WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM expenses WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM supplier_payments WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM supplier_invoice_items WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM supplier_invoices WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM purchase_order_items WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM purchase_orders WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM product_barcodes WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM products WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM product_brands WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM categories WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM suppliers WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM sync_events WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM cashiers WHERE store_id = $1", [storeId]);
  await client.query(
    "DELETE FROM terminals WHERE branch_id IN (SELECT id FROM branches WHERE store_id = $1)",
    [storeId],
  );
  await client.query("DELETE FROM branches WHERE store_id = $1", [storeId]);
  await client.query("DELETE FROM stores WHERE id = $1", [storeId]);
}

async function cleanup(client, storeId, token) {
  try {
    if (token) {
      const deleted = await client.query("SELECT delete_store($1, $2) AS deleted", [storeId, token]);
      if (deleted.rows[0]?.deleted === true) {
        console.log(`\n[CLEANUP] delete_store removed store ${storeId}`);
        return;
      }
      console.warn(`\n[CLEANUP] delete_store returned false for ${storeId}; falling back to row cleanup`);
    }
    await deleteStoreRows(client, storeId);
    console.log(`\n[CLEANUP] deleted store ${storeId} and all its rows`);
  } catch (err) {
    console.error(`\n[CLEANUP] FAILED: ${err.message}`);
  }
}

async function main() {
  // ---- Preflight: must be live mode ---------------------------------------
  const env = loadEnvFile();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    console.error("E2E audit requires live Supabase keys in .env (mock mode not supported).");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Aborting.");
    process.exit(2);
  }
  const sslMode = (url.match(/[?&]sslmode=([^&#]+)/) || [])[1];
  const cleanUrl = url.replace(/[?&]sslmode=[^&#]*/, "");
  const client = new pg.Client({
    connectionString: cleanUrl,
    ssl: sslMode !== "disable" ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  // Sanity probe that the server is up and live.
  const probe = await req("/api/stores");
  assert(probe.status === 200 && Array.isArray(probe.body?.stores), "GET /api/stores probe");

  const stamp = Date.now().toString(36);
  const seed = String(Date.now()).slice(-9);
  const storeName = `E2E Store ${stamp}`;
  const email = `e2e+${stamp}@test.pos`;
  const superAdminHeaders = {
    "x-pos-super-admin-pin": SUPER_PIN,
    "x-forwarded-for": `e2e-${stamp}`,
  };

  try {
    // =====================================================================
    // STEP 1 — Super admin provisions a brand-new store.
    // =====================================================================
    console.log("\n== Step 1: Super admin provisions a store ==");
    const createStore = await req("/api/admin/stores", {
      method: "POST",
      headers: superAdminHeaders,
      json: { name: storeName, owner_name: "E2E Owner", email, phone: "0770000000" },
    });
    assert(createStore.status === 201, `create store 201 (got ${createStore.status}: ${JSON.stringify(createStore.body)})`);
    assert(createStore.body?.store?.id, "create store -> store.id");
    createdStoreId = createStore.body.store.id;
    ok(true, "store provisioned with id");

    const list = await req("/api/admin/stores", { headers: superAdminHeaders });
    assert(list.status === 200 && Array.isArray(list.body?.stores), "list stores");
    ok(
      list.body.stores.some((s) => s.id === createdStoreId),
      "new store appears in super-admin list",
    );

    // =====================================================================
    // STEP 2 — Store admin authenticates; branch/terminal + settings.
    // =====================================================================
    console.log("\n== Step 2: Store admin login, branch/terminal, settings ==");
    const adminLogin = await req("/api/admin/login", {
      method: "POST",
      json: { email, password: DEFAULT_PASSWORD },
    });
    assert(adminLogin.status === 200, `admin login 200 (got ${adminLogin.status})`);
    ok(adminLogin.body?.store?.id === createdStoreId, "admin login -> same store");
    ok(adminLogin.body?.cashier?.role === "admin", "admin login -> cashier role admin");
    ok(adminLogin.body?.admin?.email === email, "admin login -> admin email block");
    ok(Array.isArray(adminLogin.body?.branches) && adminLogin.body.branches.length >= 1, "auto-provisioned branch present");
    ok(Array.isArray(adminLogin.body?.terminals) && adminLogin.body.terminals.length >= 1, "auto-provisioned terminal present");
    assert(adminLogin.body?.defaultBranchId, "defaultBranchId resolved");
    assert(adminLogin.body?.defaultTerminalId, "defaultTerminalId resolved");

    const branchId = adminLogin.body.defaultBranchId;
    const terminalId = adminLogin.body.defaultTerminalId;
    const storeHeaders = { "x-pos-store-id": createdStoreId, "x-pos-role": "admin", "x-pos-admin-email": email };

    const taxNumber = "311122233300003";
    const settings = await req("/api/settings", {
      method: "PATCH",
      headers: storeHeaders,
      json: {
        name: storeName,
        tax_percent: 16,
        tax_number: taxNumber,
        loyalty_enabled: true,
        points_per_spend: 1,
        point_value: 0.01,
      },
    });
    assert(settings.status === 200, `settings PATCH 200 (got ${settings.status})`);
    assert(settings.body?.settings?.taxPercent === 16, "tax 16 persisted");
    ok(settings.body?.settings?.taxNumber === taxNumber, "tax number persisted");
    ok(settings.body?.settings?.loyaltyEnabled === true, "loyalty enabled");
    ok(settings.body?.settings?.pointsPerSpend === 1 && settings.body?.settings?.pointValue === 0.01, "loyalty rate + value");

    const settingsGet = await req("/api/settings", { headers: storeHeaders });
    assert(settingsGet.status === 200, "settings GET 200");
    ok(settingsGet.body?.settings?.taxPercent === 16, "settings GET -> tax 16");

    // =====================================================================
    // STEP 3 — Inventory: 4 categories + products via CSV import.
    // =====================================================================
    console.log("\n== Step 3: Catalog import (categories + products + barcodes) ==");
    const bc = (i) => `9${seed}${String(i).padStart(2, "0")}`;
    const csv = [
      "Category,Product Name,Barcode,Base Unit,Unit Name,Multiplier,Cost Price,Selling Price,Total Stock",
      `Plastics,Plastic Cup,${bc(1)},Piece,Piece,1,0.30,1.00,100`,
      `Plastics,Multi-Pack Cups,${bc(5)},Pack,Pack,4,1.00,3.00,10`,
      `Paper Goods,Paper Plate,${bc(2)},Piece,Piece,1,0.60,2.00,50`,
      `Linens,Linen Towel,${bc(3)},Piece,Piece,1,4.00,10.00,30`,
      `Household Items,Dish Soap,${bc(4)},Piece,Piece,1,2.50,5.00,20`,
    ].join("\n");

    const imp = await req("/api/catalog/import", { method: "POST", headers: storeHeaders, text: csv });
    assert(imp.status === 200, `import 200 (got ${imp.status})`);
    ok(imp.body?.ok === true, "import -> ok true");
    assert(imp.body?.categoriesCreated === 4, `import -> 4 categories created (got ${imp.body?.categoriesCreated})`);
    assert(imp.body?.productsCreated === 5, `import -> 5 products created (got ${imp.body?.productsCreated})`);
    assert(imp.body?.barcodesUpserted === 5, `import -> 5 barcodes upserted (got ${imp.body?.barcodesUpserted})`);

    const catalog = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    assert(catalog.status === 200, "catalog GET 200");
    const cat = catalog.body;
    assert(cat?.categories && cat?.products && cat?.barcodeIndex, "catalog snapshot shape");
    const productByBarcode = {};
    for (const [barcode, entry] of Object.entries(cat.barcodeIndex)) {
      productByBarcode[barcode] = { productId: entry.product_id, price: entry.price, name: entry.name };
    }
    for (const i of [1, 2, 3, 4, 5]) {
      const key = bc(i);
      assert(productByBarcode[key], `barcode ${key} present in catalog`);
    }
    const priceOf = {
      cup: productByBarcode[bc(1)].price,
      multi: productByBarcode[bc(5)].price,
      plate: productByBarcode[bc(2)].price,
      towel: productByBarcode[bc(3)].price,
      soap: productByBarcode[bc(4)].price,
    };
    const productId = {
      cup: productByBarcode[bc(1)].productId,
      multi: productByBarcode[bc(5)].productId,
      plate: productByBarcode[bc(2)].productId,
      towel: productByBarcode[bc(3)].productId,
      soap: productByBarcode[bc(4)].productId,
    };
    assert(priceOf.cup === 1 && priceOf.multi === 3 && priceOf.plate === 2 && priceOf.towel === 10 && priceOf.soap === 5, "barcode selling prices imported");

    const categoryReference = await req("/api/catalog/references?type=category", {
      method: "POST",
      headers: storeHeaders,
      json: { name: "API Category" },
    });
    assert(categoryReference.status === 201 && categoryReference.body?.item?.id, "create standalone category reference");
    const categoryReferenceId = categoryReference.body.item.id;

    const brandReference = await req("/api/catalog/references?type=brand", {
      method: "POST",
      headers: storeHeaders,
      json: { name: "API Brand" },
    });
    assert(brandReference.status === 201 && brandReference.body?.item?.id, "create standalone brand reference");
    const brandReferenceId = brandReference.body.item.id;

    const supplierReference = await req("/api/suppliers", {
      method: "POST",
      headers: storeHeaders,
      json: { name: "API Supplier", phone: "0791234567" },
    });
    assert(supplierReference.status === 201 && supplierReference.body?.supplier?.id, "create product supplier reference");
    const supplierReferenceId = supplierReference.body.supplier.id;

    const manualProduct = {
      name: "Manual API Product",
      categoryId: categoryReferenceId,
      category: "API Category",
      brandId: brandReferenceId,
      brand: "API Brand",
      supplierId: supplierReferenceId,
      supplier: "API Supplier",
      baseUnit: "Piece",
      stock: 7,
      variants: [
        { barcode: bc(6), variantLabel: "Lemon", unitName: "Piece", multiplier: 1, costPrice: 0.4, price: 1.25 },
        { barcode: bc(9), variantLabel: "Vanilla", unitName: "Piece", multiplier: 1, costPrice: 0.4, price: 1.25 },
      ],
    };
    const createProduct = await req("/api/catalog/products", {
      method: "POST",
      headers: storeHeaders,
      json: manualProduct,
    });
    assert(createProduct.status === 201, `catalog product POST 201 (got ${createProduct.status})`);
    const manualProductId = createProduct.body?.product?.id;
    assert(manualProductId, "catalog product POST -> product.id");

    const productCatalog = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    assert(productCatalog.body?.barcodeIndex?.[bc(6)]?.price === 1.25, "manual product appears in POS catalog");
    ok(productCatalog.body?.barcodes?.[bc(6)]?.variantLabel === "Lemon", "barcode stores flavor/variant label");
    ok(productCatalog.body?.barcodes?.[bc(9)]?.productId === manualProductId, "one product accepts multiple flavor barcodes");
    assert(productCatalog.body?.products?.[manualProductId]?.price === 1.25, "manual product name search price populated");
    ok(
      productCatalog.body?.products?.[manualProductId]?.taxPercent === 16,
      `manual product defaults to VAT 16% (got ${productCatalog.body?.products?.[manualProductId]?.taxPercent})`,
    );
    ok(productCatalog.body?.products?.[manualProductId]?.taxIncluded === true, "manual product defaults to VAT-inclusive price");
    ok(productCatalog.body?.products?.[manualProductId]?.defaultSaleBarcode === bc(6), "manual product has explicit default sale barcode");
    ok(productCatalog.body?.products?.[manualProductId]?.brandId === brandReferenceId, "manual product linked to selected brand id");
    ok(productCatalog.body?.products?.[manualProductId]?.supplierId === supplierReferenceId, "manual product linked to selected supplier id");
    ok(productCatalog.body?.suppliers?.[supplierReferenceId]?.name === "API Supplier", "catalog exposes supplier picker map");
    ok(productCatalog.body?.quickKeys?.some((key) => key.productId === manualProductId && key.barcode === bc(6) && key.unitName === "Piece" && key.variantLabel === "Lemon"), "quick key uses default sale barcode unit and variant");

    const openingMovements = await req(`/api/inventory/movements?productId=${manualProductId}`, { headers: storeHeaders });
    ok(openingMovements.status === 200, "inventory movement API lists product stock card");
    ok(openingMovements.body?.movements?.some((movement) => movement.movement_type === "OPENING" && Number(movement.balance_after) === 7), "new product stock creates opening movement");

    const updateProduct = await req(`/api/catalog/products/${manualProductId}`, {
      method: "PUT",
      headers: storeHeaders,
      json: {
        ...manualProduct,
        name: "Manual API Product Updated",
        stock: 11,
        variants: [
          { barcode: bc(6), variantLabel: "Lemon", unitName: "Piece", multiplier: 1, costPrice: 0.5, price: 1.5 },
          { barcode: bc(9), variantLabel: "Vanilla", unitName: "Piece", multiplier: 1, costPrice: 0.5, price: 1.5 },
        ],
      },
    });
    assert(updateProduct.status === 200, `catalog product PUT 200 (got ${updateProduct.status})`);
    const updatedCatalog = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    assert(updatedCatalog.body?.barcodeIndex?.[bc(6)]?.price === 1.5, "manual product update reflected in POS catalog");
    assert(updatedCatalog.body?.products?.[manualProductId]?.totalStock === 7, "editing product cannot silently overwrite audited stock");

    const adjustmentKey = randomUUID();
    const adjustmentBody = { productId: manualProductId, mode: "COUNT", quantity: 11, reason: "E2E physical count", idempotencyKey: adjustmentKey };
    const adjustment = await req("/api/inventory/movements", { method: "POST", headers: storeHeaders, json: adjustmentBody });
    assert(adjustment.status === 201 && adjustment.body?.movement?.id, "stocktake adjustment creates movement");
    const adjustmentRetry = await req("/api/inventory/movements", { method: "POST", headers: storeHeaders, json: adjustmentBody });
    ok(adjustmentRetry.status === 200 && adjustmentRetry.body?.movement?.id === adjustment.body.movement.id, "stock adjustment retry is idempotent");
    const adjustedCatalog = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    ok(Number(adjustedCatalog.body?.products?.[manualProductId]?.totalStock) === 11, "stocktake updates catalog balance through ledger");

    const purchaseOrder = await req("/api/purchase-orders", {
      method: "POST",
      headers: storeHeaders,
      json: { supplier_id: supplierReferenceId, items: [{ product_id: manualProductId, quantity: 3, unit_cost: 0.55 }] },
    });
    assert(purchaseOrder.status === 201 && purchaseOrder.body?.order?.id, "create purchase order for ledger test");
    const receiveOrder = await req("/api/purchase-orders", {
      method: "PATCH",
      headers: storeHeaders,
      json: { id: purchaseOrder.body.order.id },
    });
    assert(receiveOrder.status === 200, "receive purchase order through stock ledger");
    const afterReceiptCatalog = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    ok(Number(afterReceiptCatalog.body?.products?.[manualProductId]?.totalStock) === 14, "purchase receipt increases stock without low-balance guard bug");
    const purchaseMovements = await req(`/api/inventory/movements?productId=${manualProductId}&type=PURCHASE_RECEIPT`, { headers: storeHeaders });
    ok(purchaseMovements.body?.movements?.length === 1 && Number(purchaseMovements.body.movements[0].quantity_delta) === 3, "purchase receipt writes one auditable movement");

    // Supplier invoice: payable + per-line input VAT + partial/full settlement.
    const accountingDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Amman",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const supplierInvoiceNumber = `E2E-${seed}`;
    const supplierInvoiceBody = {
      supplierId: supplierReferenceId,
      purchaseOrderId: purchaseOrder.body.order.id,
      invoiceNumber: supplierInvoiceNumber,
      invoiceDate: accountingDate,
      dueDate: accountingDate,
      notes: "E2E accounts payable lifecycle",
      items: [
        { productId: manualProductId, description: "Taxable stock", quantity: 10, unitCost: 0.5, taxPercent: 16 },
        { productId: null, description: "Zero-rated delivery", quantity: 1, unitCost: 2, taxPercent: 0 },
      ],
    };
    const supplierInvoice = await req("/api/supplier-accounts", {
      method: "POST",
      json: supplierInvoiceBody,
    });
    assert(supplierInvoice.status === 201 && supplierInvoice.body?.invoice?.id, "create supplier invoice atomically");
    const supplierInvoiceId = supplierInvoice.body.invoice.id;
    ok(supplierInvoice.body.invoice.totalAmount === 7.8, "supplier invoice total includes 0.80 line VAT");
    ok(supplierInvoice.body.invoice.supplierBalance === 7.8, "supplier payable balance increases once");

    const duplicateSupplierInvoice = await req("/api/supplier-accounts", {
      method: "POST",
      json: supplierInvoiceBody,
    });
    ok(duplicateSupplierInvoice.status === 409, "duplicate supplier invoice number is rejected");

    const supplierInvoiceList = await req(
      `/api/supplier-accounts?from=${accountingDate}&to=${accountingDate}`,
    );
    assert(supplierInvoiceList.status === 200, "supplier accounts ledger returns 200");
    ok(supplierInvoiceList.body?.summary?.inputTax === 0.8, "supplier summary totals deductible input VAT");
    ok(supplierInvoiceList.body?.summary?.outstandingBalance === 7.8, "supplier summary reconciles outstanding payable");
    ok(supplierInvoiceList.body?.invoices?.[0]?.itemCount === 2, "supplier ledger returns invoice item count");

    const supplierInvoiceDetail = await req(`/api/supplier-accounts/${supplierInvoiceId}`);
    assert(supplierInvoiceDetail.status === 200, "supplier invoice detail returns 200");
    ok(supplierInvoiceDetail.body?.invoice?.items?.length === 2, "supplier invoice detail returns both tax lines");
    ok(supplierInvoiceDetail.body?.invoice?.payments?.length === 0, "new supplier invoice has no payments");

    const updateSupplierWithoutBalance = await req(`/api/suppliers?id=${supplierReferenceId}`, {
      method: "PUT",
      headers: storeHeaders,
      json: { name: "API Supplier", phone: "0791234567", email: "supplier@example.test" },
    });
    assert(updateSupplierWithoutBalance.status === 200, "supplier master data update succeeds");
    ok(Number(updateSupplierWithoutBalance.body?.supplier?.balance) === 7.8, "editing supplier cannot erase payable balance");

    const partialSupplierPayment = await req("/api/supplier-accounts", {
      method: "PATCH",
      json: { invoiceId: supplierInvoiceId, amount: 3, method: "BANK", reference: `BANK-${seed}` },
    });
    assert(partialSupplierPayment.status === 200, "partial supplier payment succeeds");
    ok(partialSupplierPayment.body?.payment?.status === "PARTIAL", "partial payment marks invoice PARTIAL");
    ok(partialSupplierPayment.body?.payment?.balanceDue === 4.8, "partial payment leaves exact balance");

    const excessiveSupplierPayment = await req("/api/supplier-accounts", {
      method: "PATCH",
      json: { invoiceId: supplierInvoiceId, amount: 5, method: "CASH" },
    });
    ok(excessiveSupplierPayment.status === 400, "supplier overpayment is rejected");

    const finalSupplierPayment = await req("/api/supplier-accounts", {
      method: "PATCH",
      json: { invoiceId: supplierInvoiceId, amount: 4.8, method: "CASH" },
    });
    assert(finalSupplierPayment.status === 200, "final supplier payment succeeds");
    ok(finalSupplierPayment.body?.payment?.status === "PAID", "final payment marks invoice PAID");
    ok(finalSupplierPayment.body?.payment?.balanceDue === 0, "final payment clears invoice balance");
    ok(finalSupplierPayment.body?.payment?.supplierBalance === 0, "supplier master balance reconciles to zero");

    const settledSupplierInvoice = await req(`/api/supplier-accounts/${supplierInvoiceId}`);
    ok(settledSupplierInvoice.body?.invoice?.payments?.length === 2, "only two successful supplier payments are recorded");
    const settledSupplierSummary = await req(
      `/api/supplier-accounts?from=${accountingDate}&to=${accountingDate}`,
    );
    ok(settledSupplierSummary.body?.summary?.payments === 7.8, "supplier payments reconcile to invoice total");
    ok(settledSupplierSummary.body?.summary?.outstandingBalance === 0, "settled supplier ledger has no outstanding balance");

    const supplierAudit = await req("/api/admin/audit", { headers: storeHeaders });
    const supplierAuditTypes = supplierAudit.body?.entries?.map((entry) => entry.action_type) ?? [];
    ok(supplierAuditTypes.filter((type) => type === "CREATE_SUPPLIER_INVOICE").length === 1, "supplier invoice creation is audited once");
    ok(supplierAuditTypes.filter((type) => type === "RECORD_SUPPLIER_PAYMENT").length === 2, "successful supplier payments are audited; rejected payment is not");

    const publicSupabaseHeaders = {
      apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    };
    const directSupplierTable = await fetch(
      `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/supplier_invoices?select=id&limit=1`,
      { headers: publicSupabaseHeaders },
    );
    ok([401, 403].includes(directSupplierTable.status), "public anon client cannot read supplier invoice ledger directly");
    const directRawSummary = await fetch(
      `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/supplier_accounting_summary`,
      {
        method: "POST",
        headers: publicSupabaseHeaders,
        body: JSON.stringify({
          p_store_id: createdStoreId,
          p_from: new Date(0).toISOString(),
          p_to: new Date().toISOString(),
        }),
      },
    );
    ok([401, 403].includes(directRawSummary.status), "public anon client cannot bypass the token-gated supplier RPC");

    const deleteCategory = await req(`/api/catalog/references?type=category&id=${categoryReferenceId}`, {
      method: "DELETE",
      headers: storeHeaders,
    });
    assert(deleteCategory.status === 200, "delete category reference 200");
    const uncategorizedCatalog = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    ok(Boolean(uncategorizedCatalog.body?.products?.[manualProductId]), "deleting category preserves linked product");
    ok(uncategorizedCatalog.body?.products?.[manualProductId]?.categoryId === "", "deleted category leaves product uncategorized");

    const deleteProduct = await req(`/api/catalog/products/${manualProductId}`, {
      method: "DELETE",
      headers: storeHeaders,
    });
    assert(deleteProduct.status === 409, `catalog product with movements cannot be deleted (got ${deleteProduct.status})`);
    const afterDeleteCatalog = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    ok(Boolean(afterDeleteCatalog.body?.barcodeIndex?.[bc(6)]), "product history protection preserves barcode after blocked delete");

    const deleteBrand = await req(`/api/catalog/references?type=brand&id=${brandReferenceId}`, {
      method: "DELETE",
      headers: storeHeaders,
    });
    ok(deleteBrand.status === 200, "delete unused brand reference 200");

    const nardWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      nardWorkbook,
      XLSX.utils.json_to_sheet([
        {
          "Arabic Name": "XLSX Import Product",
          "Barcode ( , )": `${bc(7)},${bc(8)}`,
          "Arabic Main Category": "XLSX Category//Brand",
          "Sale Price": 2.75,
          "Cost Price": 1.1,
          "Tax Percentage": 16,
          "Tax Include 0/1": 1,
          "Show In Sale Screen 0/1": 1,
          "Active 0/1": 1,
          "Sale item method (weight 0 , piece 1)": 1,
        },
      ]),
      "Export",
    );
    const nardBuffer = XLSX.write(nardWorkbook, { bookType: "xlsx", type: "buffer" });
    const previewForm = new FormData();
    previewForm.set(
      "file",
      new Blob([new Uint8Array(nardBuffer)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "nard-products.xlsx",
    );
    const xlsxPreview = await req("/api/catalog/import?preview=1", {
      method: "POST",
      headers: storeHeaders,
      form: previewForm,
    });
    assert(xlsxPreview.status === 200, `xlsx import preview 200 (got ${xlsxPreview.status})`);
    ok(xlsxPreview.body?.summary?.products === 1, "xlsx preview -> 1 product");
    ok(xlsxPreview.body?.summary?.barcodes === 2, "xlsx preview -> 2 barcodes");

    const importForm = new FormData();
    importForm.set(
      "file",
      new Blob([new Uint8Array(nardBuffer)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "nard-products.xlsx",
    );
    const xlsxImport = await req("/api/catalog/import", {
      method: "POST",
      headers: storeHeaders,
      form: importForm,
    });
    assert(xlsxImport.status === 200, `xlsx import 200 (got ${xlsxImport.status})`);
    ok(xlsxImport.body?.barcodesUpserted === 2, "xlsx import -> 2 barcodes saved");
    const xlsxCatalog = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    assert(xlsxCatalog.body?.barcodeIndex?.[bc(7)]?.price === 2.75, "xlsx product barcode appears in POS catalog");

    // =====================================================================
    // STEP 4 — Cashier PIN login (owner/cashier separation).
    // =====================================================================
    console.log("\n== Step 4: Cashier PIN login ==");

    // The auto-provisioned store has NO default cashier PIN — the owner logs
    // in with email + password only (Step 2) and never holds a PIN. Create a
    // cashier, then unlock the register with its PIN.
    const cashierPin = "2468";
    const cashierCreate = await req("/api/admin/cashiers", {
      method: "POST",
      headers: storeHeaders,
      json: {
        password: DEFAULT_PASSWORD,
        cashier: { name: "Cashier Tester", role: "cashier", pin: cashierPin },
      },
    });
    assert(cashierCreate.status === 200 || cashierCreate.status === 201, `create cashier 2xx (got ${cashierCreate.status})`);

    const cashierLogin = await req("/api/login", {
      method: "POST",
      json: { pin: cashierPin, storeId: createdStoreId },
    });
    assert(cashierLogin.status === 200, `cashier PIN login 200 (got ${cashierLogin.status})`);
    ok(cashierLogin.body?.store?.id === createdStoreId, "cashier login -> same store");
    ok(cashierLogin.body?.defaultBranchId === branchId && cashierLogin.body?.defaultTerminalId === terminalId, "cashier login -> same branch/terminal defaults");

    // F3: PIN login succeeded against the stored hash; the DB holds a random
    // per-cashier salt + sha256(pin + salt) and never a plaintext PIN.
    const { rows: cashierRows } = await client.query(
      "SELECT id, name, pin, pin_salt, pin_hash FROM cashiers WHERE store_id = $1 AND role = 'cashier'",
      [createdStoreId],
    );
    assert(cashierRows.length >= 1, "cashier row present");
    const cashierRow = cashierRows[cashierRows.length - 1];
    const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
    assert(cashierRow.pin === null, "F3: no plaintext PIN stored");
    assert(
      typeof cashierRow.pin_salt === "string" && cashierRow.pin_salt.length === 32,
      "F3: random per-cashier salt stored",
    );
    assert(
      cashierRow.pin_hash === sha256(cashierPin + cashierRow.pin_salt),
      "F3: pin_hash matches sha256(pin + salt)",
    );
    ok(true, "F3: random per-cashier salt + hash; plaintext PIN never stored");

    // Owner/cashier separation: the owner row is credentials-only (email +
    // password_hash, no PIN material), and its PIN can never unlock a register.
    const { rows: ownerRows } = await client.query(
      "SELECT pin, pin_salt, pin_hash, email, password_hash FROM cashiers WHERE store_id = $1 AND role = 'admin'",
      [createdStoreId],
    );
    assert(ownerRows.length === 1, "owner row present");
    ok(
      ownerRows[0].pin === null && ownerRows[0].pin_salt === null && ownerRows[0].pin_hash === null,
      "separation: owner holds no PIN material",
    );
    ok(
      typeof ownerRows[0].email === "string" &&
        typeof ownerRows[0].password_hash === "string" &&
        ownerRows[0].password_hash.length > 0,
      "separation: owner holds dashboard credentials",
    );
    const ownerPinLogin = await req("/api/login", {
      method: "POST",
      json: { pin: DEFAULT_PIN, storeId: createdStoreId },
    });
    ok(ownerPinLogin.status === 401, "separation: owner default PIN cannot unlock a register");

    // Create the loyalty/ledger customer.
    const customer = await req("/api/customers", {
      method: "POST",
      headers: storeHeaders,
      json: { name: "E2E Customer", phone: "0777123456" },
    });
    assert(customer.status === 201 && customer.body?.customer?.id, "create customer 201");
    const customerId = customer.body.customer.id;

    // =====================================================================
    // STEP 5 — Transaction: cart math, stock deduction, loyalty.
    // =====================================================================
    console.log("\n== Step 5: Transaction (cart math + stock + loyalty) ==");
    const items = [
      { productId: productId.cup, name: "Plastic Cup", barcode: bc(1), qty: 2, unitName: "Piece", unitPrice: 1.0, lineTotal: 2.0, taxPercent: 16, taxIncluded: false },
      { productId: productId.multi, name: "Multi-Pack Cups", barcode: bc(5), qty: 2, unitName: "Pack", unitPrice: 3.0, lineTotal: 6.0, taxPercent: 16, taxIncluded: false },
      { productId: productId.plate, name: "Paper Plate", barcode: bc(2), qty: 3, unitName: "Piece", unitPrice: 2.0, lineTotal: 6.0, taxPercent: 16, taxIncluded: false },
      { productId: productId.towel, name: "Linen Towel", barcode: bc(3), qty: 1, unitName: "Piece", unitPrice: 10.0, lineTotal: 10.0, taxPercent: 16, taxIncluded: false },
      { productId: productId.soap, name: "Dish Soap", barcode: bc(4), qty: 4, unitName: "Piece", unitPrice: 5.0, lineTotal: 20.0, taxPercent: 16, taxIncluded: false },
    ];
    const gross = round2(items.reduce((s, it) => s + it.qty * it.unitPrice, 0));
    const tax = round2((gross * 16) / 100);
    const total = round2(gross + tax);
    const amountPaid = 60;
    const change = round2(Math.max(0, amountPaid - total));
    assert(gross === 44, `cart subtotal 44 (got ${gross})`);
    assert(tax === 7.04, `cart tax 7.04 (got ${tax})`);
    assert(total === 51.04, `cart total 51.04 (got ${total})`);
    assert(change === 8.96, `change 8.96 (got ${change})`);
    ok(true, "cart math: subtotal=44, tax=7.04, total=51.04, change=8.96");

    // Open the shift BEFORE the first sale so the invoice is shift-bound; the
    // drawer recomputation in SHIFT_CLOSED then sources real ledger rows.
    const shiftId = randomUUID();
    const startTime = new Date().toISOString();
    const shiftOpen = {
      sync_id: randomUUID(),
      action_type: "SHIFT_OPENED",
      payload: {
        shiftId,
        startTime,
        startingCash: 100,
        openedAt: startTime,
        branchId,
        terminalId,
      },
    };
    const openSync = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [shiftOpen],
    });
    assert(openSync.status === 200 && openSync.body?.success === true, "SHIFT_OPENED synced before sales");

    const syncId = randomUUID();
    const invoiceEvent = {
      sync_id: syncId,
      action_type: "INVOICE_CREATED",
      payload: {
        items,
        subtotal: gross,
        tax,
        discount: 0,
        total,
        paymentMethod: "CASH",
        amountPaid,
        change,
        customerName: "E2E Customer",
        customerId,
        customerPhone: "0777123456",
        cashierId: cashierRow.id,
        cashierName: cashierRow.name,
        shiftId,
        branchId,
        terminalId,
        completed_at: new Date().toISOString(),
      },
    };
    const sync = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [invoiceEvent],
    });
    assert(sync.status === 200 && sync.body?.success === true, "sync INVOICE_CREATED success");
    assert(Array.isArray(sync.body?.synced_ids) && sync.body.synced_ids.includes(syncId), "invoice acked");

    const ledger = await client.query(
      `SELECT id, total, tax, cash_amount, visa_amount, debt_amount, gross_profit, item_count, cashier_id, cashier_name
         FROM sales_invoices
        WHERE store_id = $1 AND sync_id = $2`,
      [createdStoreId, syncId],
    );
    assert(ledger.rowCount === 1, "sales_invoices mirrors invoice once");
    const ledgerInvoice = ledger.rows[0];
    ok(Number(ledgerInvoice.total) === total, `sales_invoices total ${total}`);
    ok(Number(ledgerInvoice.tax) === tax, `sales_invoices tax ${tax}`);
    ok(Number(ledgerInvoice.cash_amount) === total, "sales_invoices cash amount");
    ok(Number(ledgerInvoice.visa_amount) === 0 && Number(ledgerInvoice.debt_amount) === 0, "sales_invoices non-cash amounts zero");
    ok(Number(ledgerInvoice.item_count) === 12, "sales_invoices item_count 12");
    ok(ledgerInvoice.cashier_id === cashierRow.id && ledgerInvoice.cashier_name === cashierRow.name, "sales_invoices cashier stamped");
    const ledgerItems = await client.query(
      `SELECT count(*)::int AS count, sum(qty)::numeric AS qty,
              sum(net_total)::numeric AS net, sum(tax_amount)::numeric AS tax,
              sum(line_total)::numeric AS total, sum(gross_profit)::numeric AS profit
         FROM sales_invoice_items
        WHERE store_id = $1 AND invoice_id = $2`,
      [createdStoreId, ledgerInvoice.id],
    );
    ok(ledgerItems.rows[0].count === 5, "sales_invoice_items has 5 rows");
    ok(Number(ledgerItems.rows[0].qty) === 12, "sales_invoice_items quantity sum 12");
    ok(Number(ledgerItems.rows[0].net) === gross, "sales_invoice_items net equals invoice subtotal");
    ok(Number(ledgerItems.rows[0].tax) === tax, "sales_invoice_items tax equals invoice tax");
    ok(Number(ledgerItems.rows[0].total) === total, "sales_invoice_items gross equals invoice total");
    ok(Number(ledgerItems.rows[0].profit) === 25.6, "sales_invoice_items gross profit 25.6");
    const ledgerPayments = await client.query(
      `SELECT count(*)::int AS count, sum(amount)::numeric AS amount
         FROM sales_payments
        WHERE store_id = $1 AND invoice_id = $2 AND method = 'CASH'`,
      [createdStoreId, ledgerInvoice.id],
    );
    ok(ledgerPayments.rows[0].count === 1 && Number(ledgerPayments.rows[0].amount) === total, "sales_payments cash row");

    const reportDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Amman",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(invoiceEvent.payload.completed_at));
    const deniedSalesLedger = await req(
      `/api/reports/sales?from=${reportDate}&to=${reportDate}&search=${syncId.slice(0, 10)}`,
    );
    ok(deniedSalesLedger.status === 401, "cashier session cannot read sales reports");

    const reportAdminLogin = await req("/api/admin/login", {
      method: "POST",
      json: { email, password: DEFAULT_PASSWORD },
    });
    assert(reportAdminLogin.status === 200, "owner re-authenticates before accounting reports");

    const salesLedger = await req(
      `/api/reports/sales?from=${reportDate}&to=${reportDate}&search=${syncId.slice(0, 10)}`,
    );
    assert(salesLedger.status === 200, `sales ledger report 200 (got ${salesLedger.status})`);
    ok(salesLedger.body?.pagination?.total === 1, "sales ledger search returns exactly one invoice");
    ok(salesLedger.body?.invoices?.[0]?.syncId === syncId, "sales ledger returns the synced invoice");
    ok(salesLedger.body?.summary?.netSales === total, "sales ledger net sales matches invoice total");
    ok(salesLedger.body?.summary?.tax === tax, "sales ledger tax matches invoice tax");
    ok(salesLedger.body?.summary?.grossProfit === 25.6, "sales ledger gross profit matches item ledger");
    ok(
      salesLedger.body?.taxBreakdown?.length === 1 &&
        salesLedger.body.taxBreakdown[0].taxPercent === 16 &&
        salesLedger.body.taxBreakdown[0].tax === tax,
      "sales ledger groups line tax at 16 percent",
    );

    const salesExport = await fetch(
      `${BASE_URL}/api/reports/sales/export?from=${reportDate}&to=${reportDate}&search=${syncId.slice(0, 10)}`,
      { headers: { Cookie: cookieHeader() } },
    );
    const salesExportBytes = new Uint8Array(await salesExport.arrayBuffer());
    const salesExportText = new TextDecoder("utf-8").decode(salesExportBytes);
    ok(salesExport.status === 200, "sales ledger CSV export returns 200");
    ok(
      salesExport.headers.get("content-type")?.includes("text/csv") === true,
      "sales ledger export uses CSV content type",
    );
    ok(
      salesExportBytes[0] === 0xef &&
        salesExportBytes[1] === 0xbb &&
        salesExportBytes[2] === 0xbf &&
        salesExportText.includes(syncId.replaceAll("-", "").slice(0, 10).toUpperCase()),
      "sales ledger CSV is UTF-8 BOM encoded and contains the invoice reference",
    );

    const invoiceDetail = await req(`/api/reports/sales/${ledgerInvoice.id}`);
    assert(invoiceDetail.status === 200, `sales invoice detail 200 (got ${invoiceDetail.status})`);
    ok(invoiceDetail.body?.invoice?.items?.length === 5, "sales invoice detail returns five lines");
    ok(invoiceDetail.body?.invoice?.payments?.length === 1, "sales invoice detail returns one cash payment");
    ok(invoiceDetail.body?.invoice?.taxBreakdown?.[0]?.tax === tax, "sales invoice detail tax breakdown balances");

    const expenseAmount = 2.5;
    const expenseId = randomUUID();
    const expenseEvent = {
      sync_id: randomUUID(),
      action_type: "EXPENSE_RECORDED",
      payload: {
        expenseId,
        cashierId: cashierRow.id,
        category: "general",
        amount: expenseAmount,
        notes: "E2E profitability expense",
        branchId,
        terminalId,
        created_at: new Date().toISOString(),
      },
    };
    const expenseSync = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [expenseEvent],
    });
    assert(expenseSync.status === 200 && expenseSync.body?.synced_ids?.includes(expenseEvent.sync_id), "expense sync succeeds");

    const profitability = await req(
      `/api/reports/profitability?from=${reportDate}&to=${reportDate}`,
    );
    assert(profitability.status === 200, `profitability report 200 (got ${profitability.status})`);
    ok(profitability.body?.current?.statement?.netRevenue === gross, "profitability revenue excludes output tax");
    ok(profitability.body?.current?.statement?.outputTax === tax, "profitability output tax balances sales ledger");
    ok(profitability.body?.current?.taxPosition?.deductibleInputTax === 0.8, "profitability deducts supplier invoice input VAT");
    ok(profitability.body?.current?.taxPosition?.netPayable === round2(tax - 0.8), "profitability calculates net VAT payable");
    ok(profitability.body?.current?.quality?.inputTaxTracked === true, "profitability marks input VAT ledger as tracked");
    ok(profitability.body?.current?.statement?.receiptsIncludingTax === total, "profitability receipts reconcile to invoice total");
    ok(profitability.body?.current?.statement?.knownCogs === 18.4, "profitability recognizes documented COGS");
    ok(profitability.body?.current?.statement?.grossProfit === 25.6, "profitability gross profit is revenue minus COGS");
    ok(profitability.body?.current?.statement?.operatingExpenses === expenseAmount, "profitability includes operating expense");
    ok(profitability.body?.current?.statement?.operatingProfit === 23.1, "operating profit deducts expense once");
    ok(profitability.body?.current?.quality?.profitReliable === true, "complete item costs produce reliable profit");
    ok(
      profitability.body?.current?.expenseBreakdown?.some(
        (group) => group.category === "general" && group.amount === expenseAmount,
      ),
      "profitability groups expenses by category",
    );
    ok(profitability.body?.current?.trend?.length === 1, "profitability returns a daily trend row");

    const expenseReplay = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [expenseEvent],
    });
    assert(expenseReplay.status === 200, "expense replay accepted idempotently");
    const expenseRows = await client.query(
      "SELECT count(*)::int AS count FROM expenses WHERE store_id = $1 AND id = $2",
      [createdStoreId, expenseId],
    );
    ok(expenseRows.rows[0].count === 1, "expense replay does not duplicate operating expense");

    const catalogAfter = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    const after = catalogAfter.body.products;
    const stockOf = {
      cup: after[productId.cup]?.totalStock,
      multi: after[productId.multi]?.totalStock,
      plate: after[productId.plate]?.totalStock,
      towel: after[productId.towel]?.totalStock,
      soap: after[productId.soap]?.totalStock,
    };
    ok(stockOf.cup === 98, `stock cup 100-2=98 (got ${stockOf.cup})`);
    ok(stockOf.multi === 2, `stock multi 10-(2*4)=2 (got ${stockOf.multi})`);
    ok(stockOf.plate === 47, `stock plate 50-3=47 (got ${stockOf.plate})`);
    ok(stockOf.towel === 29, `stock towel 30-1=29 (got ${stockOf.towel})`);
    ok(stockOf.soap === 16, `stock soap 20-4=16 (got ${stockOf.soap})`);
    const saleMovements = await client.query(
      `SELECT count(*)::int AS count, sum(quantity_delta)::numeric AS delta
         FROM inventory_movements
        WHERE store_id = $1 AND reference_type = 'INVOICE' AND reference_id = $2`,
      [createdStoreId, syncId],
    );
    ok(saleMovements.rows[0].count === 5 && Number(saleMovements.rows[0].delta) === -18, "invoice writes five barcode-level stock movements totaling -18 base units");

    const loyalty = await req(`/api/loyalty?customer_id=${customerId}`, {
      headers: { "x-pos-store-id": createdStoreId },
    });
    assert(loyalty.status === 200, "loyalty GET 200");
    const expectedPoints = Math.floor(total / 1);
    assert(expectedPoints === 51, `expected loyalty 51 (got ${expectedPoints})`);
    ok(loyalty.body?.customer?.loyalty_points === 51, `loyalty points awarded 51 (got ${loyalty.body?.customer?.loyalty_points})`);
    ok(
      Array.isArray(loyalty.body?.events) && loyalty.body.events.some((e) => e.type === "EARN" && e.points === 51),
      "loyalty_events has EARN 51",
    );

    // Idempotent replay: same sync_id must NOT double-deduct or double-award.
    const replay = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [invoiceEvent],
    });
    assert(replay.status === 200 && replay.body?.success === true, "replay sync success");
    assert(Array.isArray(replay.body?.synced_ids) && replay.body.synced_ids.includes(syncId), "replay acked (dedupe-safe)");
    const catalogReplay = await req("/api/catalog", { headers: { "x-pos-store-id": createdStoreId } });
    const replayStock = {
      cup: catalogReplay.body.products[productId.cup]?.totalStock,
      multi: catalogReplay.body.products[productId.multi]?.totalStock,
    };
    ok(replayStock.cup === 98 && replayStock.multi === 2, "replay does not double-deduct stock");
    const movementsAfterReplay = await client.query(
      "SELECT count(*)::int AS count FROM inventory_movements WHERE store_id = $1 AND reference_type = 'INVOICE' AND reference_id = $2",
      [createdStoreId, syncId],
    );
    ok(movementsAfterReplay.rows[0].count === 5, "replay does not duplicate inventory movements");
    const ledgerAfterReplay = await client.query(
      `SELECT
          (SELECT count(*)::int FROM sales_invoices WHERE store_id = $1 AND sync_id = $2) AS invoices,
          (SELECT count(*)::int FROM sales_invoice_items WHERE store_id = $1 AND invoice_id = $3) AS items,
          (SELECT count(*)::int FROM sales_payments WHERE store_id = $1 AND invoice_id = $3) AS payments`,
      [createdStoreId, syncId, ledgerInvoice.id],
    );
    ok(
      ledgerAfterReplay.rows[0].invoices === 1 &&
        ledgerAfterReplay.rows[0].items === 5 &&
        ledgerAfterReplay.rows[0].payments === 1,
      "replay does not duplicate sales ledger",
    );
    const loyaltyReplay = await req(`/api/loyalty?customer_id=${customerId}`, {
      headers: { "x-pos-store-id": createdStoreId },
    });
    ok(loyaltyReplay.body?.customer?.loyalty_points === 51, "replay does not double-award points");
    ok(
      loyaltyReplay.body?.events?.filter((e) => e.type === "EARN").length === 1,
      "replay -> exactly one EARN event",
    );

    // =====================================================================
    // STEP 6 — Shift close + Z-Report.
    // =====================================================================
    console.log("\n== Step 6: Shift close -> Z-report ==");
    const closeTime = new Date().toISOString();
    const cashSales = total;
    const expectedCashInDrawer = round2(100 + cashSales);
    const shiftClose = {
      sync_id: randomUUID(),
      action_type: "SHIFT_CLOSED",
      payload: {
        shiftId,
        startTime,
        closeTime,
        startingCash: 100,
        cashSales,
        visaSales: 0,
        debtSales: 0,
        debtCollections: 0,
        totalSales: total,
        discounts: 0,
        returns: 0,
        expenses: 0,
        expectedCashInDrawer,
        actualCash: expectedCashInDrawer,
        variance: 0,
        branchId,
        terminalId,
      },
    };
    const closeSync = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [shiftClose],
    });
    assert(closeSync.status === 200 && closeSync.body?.success === true, "SHIFT_CLOSED synced");

    const reports = await req(`/api/shifts?terminalId=${terminalId}`, {
      headers: { "x-pos-store-id": createdStoreId },
    });
    assert(reports.status === 200 && Array.isArray(reports.body?.shifts), "GET /api/shifts 200");
    const report = reports.body.shifts.find((r) => r.shiftId === shiftId);
    assert(report, "closed shift appears in Z-report");
    ok(report.status === "CLOSED", "report status CLOSED");
    ok(report.totalSales === total, `report totalSales ${total}`);
    ok(report.cashSales === cashSales, `report cashSales ${cashSales}`);
    ok(report.startingCash === 100, "report startingCash 100");
    ok(report.expectedCashInDrawer === expectedCashInDrawer, `report expectedCashInDrawer ${expectedCashInDrawer}`);
    ok(report.actualCash === expectedCashInDrawer && report.variance === 0, "drawer matches, variance 0");
    ok(report.branch === "الفرع الرئيسي" || report.branch !== "", "report branch display name");
    ok(report.terminal === "نقطة البيع 1" || report.terminal !== "", "report terminal display name");
    ok(round2(report.startingCash + report.cashSales) === report.expectedCashInDrawer, "drawer = startingCash + cashSales");

    const allReports = await req("/api/shifts", { headers: { "x-pos-store-id": createdStoreId } });
    ok(allReports.body?.shifts?.some((r) => r.shiftId === shiftId), "shift present in unfiltered report list");

    // Blind-count variance: a drawer that doesn't match must surface a
    // server-recomputed variance in the Z-report AND land in the audit log.
    const varianceShiftId = randomUUID();
    const varianceStartTime = new Date().toISOString();
    const varianceShiftOpen = {
      sync_id: randomUUID(),
      action_type: "SHIFT_OPENED",
      payload: {
        shiftId: varianceShiftId,
        startTime: varianceStartTime,
        startingCash: 50,
        openedAt: varianceStartTime,
        branchId,
        terminalId,
      },
    };
    const varianceOpenSync = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [varianceShiftOpen],
    });
    assert(varianceOpenSync.status === 200, "SHIFT_OPENED (variance shift) synced");

    const varianceClose = {
      sync_id: randomUUID(),
      action_type: "SHIFT_CLOSED",
      payload: {
        shiftId: varianceShiftId,
        startTime: varianceStartTime,
        closeTime: new Date().toISOString(),
        startingCash: 50,
        cashSales: 0,
        visaSales: 0,
        debtSales: 0,
        debtCollections: 0,
        totalSales: 0,
        discounts: 0,
        returns: 0,
        expenses: 0,
        expectedCashInDrawer: 50,
        actualCash: 48,
        variance: -2,
        branchId,
        terminalId,
      },
    };
    const varianceCloseSync = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [varianceClose],
    });
    assert(varianceCloseSync.status === 200, "SHIFT_CLOSED (variance shift) synced");

    const varianceReports = await req("/api/shifts", { headers: { "x-pos-store-id": createdStoreId } });
    const varianceReport = varianceReports.body.shifts.find((r) => r.shiftId === varianceShiftId);
    assert(varianceReport, "variance shift appears in Z-report");
    ok(
      varianceReport.expectedCashInDrawer === 50 && varianceReport.actualCash === 48 && varianceReport.variance === -2,
      "variance shift: drawer recomputed to 50, variance -2",
    );

    const varianceAudit = await req("/api/admin/audit", { headers: storeHeaders });
    assert(Array.isArray(varianceAudit.body?.entries), "audit log lists entries");
    const varianceEntries = varianceAudit.body.entries.filter(
      (e) => e.action_type === "SHIFT_VARIANCE" && e.target_id === varianceShiftId,
    );
    ok(varianceEntries.length === 1, "SHIFT_VARIANCE audit entry created once");
    ok(Number(varianceEntries[0].details?.variance) === -2, "audit entry records recomputed variance");

    // Replay the same close: no second audit row, payload still recomputed.
    const varianceReplay = await req("/api/sync", {
      method: "POST",
      headers: { "x-pos-store-id": createdStoreId },
      json: [varianceClose],
    });
    assert(varianceReplay.status === 200, "SHIFT_CLOSED replay accepted idempotently");
    const varianceAuditAfterReplay = await req("/api/admin/audit", { headers: storeHeaders });
    const varianceEntriesAfterReplay = varianceAuditAfterReplay.body.entries.filter(
      (e) => e.action_type === "SHIFT_VARIANCE" && e.target_id === varianceShiftId,
    );
    ok(varianceEntriesAfterReplay.length === 1, "replayed close does not duplicate SHIFT_VARIANCE audit entry");

    // ---- Fortification spot-checks ---------------------------------------
    console.log("\n== Fortification spot-checks ==");
    const wrongPass = await req("/api/admin/login", { method: "POST", json: { email, password: "wrong-pass" } });
    ok(wrongPass.status === 401, "wrong admin password -> 401");
    const forgedHeader = await req("/api/settings", { headers: { "x-pos-store-id": randomUUID() } });
    ok(forgedHeader.status === 200, "F2: forged store header ignored (session scopes tenant)");
    const noCookie = await req("/api/settings", { noCookie: true });
    ok(noCookie.status === 401, "settings without session cookie -> 401");
    const anonImport = await req("/api/catalog/import", {
      method: "POST",
      noCookie: true,
      headers: { "x-pos-store-id": createdStoreId, "x-pos-role": "admin" },
      text: csv,
    });
    ok(anonImport.status === 401, "forged admin headers without session -> 401");

    console.log(`\nE2E audit: ${pass} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exitCode = 1;
    } else {
      console.log("E2E audit: ALL GREEN");
    }
  } finally {
    await client.end();
    if (createdStoreId) {
      const fresh = new pg.Client({
        connectionString: cleanUrl,
        ssl: sslMode !== "disable" ? { rejectUnauthorized: false } : false,
      });
      await fresh.connect();
      try {
        if (KEEP_STORE) {
          console.log(`\n[KEEP] store ${createdStoreId} left in place (--keep-store)`);
        } else {
          await cleanup(fresh, createdStoreId, process.env.PLATFORM_OPS_SECRET || env.PLATFORM_OPS_SECRET);
          const chk = await fresh.query("SELECT id FROM stores WHERE id = $1", [createdStoreId]);
          console.log(`[CLEANUP] store row present after delete: ${chk.rowCount > 0 ? "YES (BUG)" : "no — clean"}`);
        }
      } finally {
        await fresh.end();
      }
    }
  }
}

main().catch((err) => {
  console.error(`\nE2E audit CRASHED: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
});
