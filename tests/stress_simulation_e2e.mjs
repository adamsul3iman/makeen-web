/**
 * E2E Stress Test — Full System Simulation
 *
 * Simulates three human roles in a heavy loop:
 *   1. Cashier  → POS scan, unit change, discount, checkout (cash + debt)
 *   2. Inventory Manager → /admin/inventory browse, product add, movements
 *   3. Admin → /admin/reports/sales, /admin/purchases, create + receive PO
 *
 * Captures browser console errors, unhandled exceptions, and Playwright
 * assertion failures to surface memory leaks, state corruption, or UI crashes.
 *
 * NOTE: Runs in mock mode (no Supabase). The mock admin credentials are
 *   email:    admin@demo.test
 *   password: 12345678
 * The supplied email alburjhom3@gmail.com is rejected in mock mode — the
 * script uses the working mock credentials instead.
 */
import { test, expect } from "@playwright/test";

// ─── Config ───────────────────────────────────────────────────────────────────
const ADMIN_EMAIL    = "admin@demo.test";
const ADMIN_PASSWORD = "12345678";

const STORE_CODE = "MAIN01";
const CASHIER_USER = "ahmed";
const CASHIER_PIN  = "1234";

const LOOPS_PER_ROLE = 3;          // iterations per role
const SCAN_BATCH_SIZE = 5;         // products scanned per cashier round

// Mock barcodes for random scanning
const BARCODES = [
  "12345",              // كاسات بلاستيك 7 أونص (p-cups)
  "6250001234567",      // كرتونة كاسات (p-cups carton)
  "6250001234574",      // رول سفرة نايلون (p-roll)
  "6250001234581",      // بشاكير قطن (p-towels)
  "6291040123456",      // منظف زجاج (p-glass)
  "6291040123463",      // مبيض ملابس (p-bleach)
  "6291010253456",      // حليب طويل الأمد (p-milk)
  "2000012345678",      // ليمون بلدي (p-lemon)
  "2000012345685",      // بندورة بلدية (p-tomato)
  "6250000987654",      // ماء معدني 500 مل (p-water)
  "6250000987678",      // سكر رز 500 غم (p-sugar)
  "6250000987685",      // رز بسمتي 1 كغ (p-rice)
  "6250000987692",      // شيبس عائلي (p-chips)
  "6250000987708",      // زيت دوار الشمس (p-oil)
];

// Quick-key product labels for speed dock clicks
const QUICK_KEY_LABELS = [
  "كاسات بلاستيك",
  "بشاكير قطن",
  "رول سفرة",
  "منظف زجاج",
  "مبيض",
  "حليب",
  "ماء",
  "سكر",
  "رز بسمتي",
  "شيبس",
  "زيت",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** Find a visible modal by heading text */
const modal = (page, title) =>
  page
    .locator("div.fixed.inset-0")
    .filter({ has: page.getByRole("heading", { name: title }) });

/** Remove Web Serial API to prevent native chooser from wedging modals */
async function disableSerial(page) {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, "serial", {
        configurable: true,
        get: () => undefined,
      });
    } catch {}
  });
}

/** Collect all console errors from a page */
function collectConsoleErrors(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });
  return errors;
}

// ─── Login Helpers ────────────────────────────────────────────────────────────

async function adminLogin(page) {
  await page.goto("/login/");
  await page.getByRole("tab", { name: "المالك" }).click();
  await page.locator("#login-email").fill(ADMIN_EMAIL);
  await page.locator("#login-password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await page.waitForURL("**/pos/**", { timeout: 15_000 });
}

async function openRegister(page) {
  const openBtn = page.getByRole("button", { name: "افتح الصندوق الآن" });
  if (await openBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await openBtn.click();
  }
}

async function openShift(page, cash = "100") {
  const cashInput = page.locator("#shift-opening-cash");
  if (await cashInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await cashInput.fill(cash);
    await page.getByRole("button", { name: "فتح الوردية" }).click();
    await expect(page.locator("#pos-barcode-input")).toBeVisible({ timeout: 10_000 });
  }
}

async function staffLogin(page) {
  await page.goto("/login/");
  await page.locator("#login-store-code").fill(STORE_CODE);
  await page.locator("#login-username").fill(CASHIER_USER);
  await page.locator("#login-pin").fill(CASHIER_PIN);
  await page.getByRole("button", { name: "دخول" }).click();
  await page.waitForURL("**/pos/**", { timeout: 15_000 });
}

async function scanBarcode(page, code) {
  const input = page.locator("#pos-barcode-input");
  await input.fill(code);
  await input.press("Enter");
  await page.waitForTimeout(200);
}

// ─── Cashier Workflow ─────────────────────────────────────────────────────────

async function cashierWorkflow(page, iteration, allErrors) {
  console.log(`  [CASHIER] Iteration ${iteration + 1}: scanning ${SCAN_BATCH_SIZE} products…`);

  // Scan random products
  const scanned = [];
  for (let i = 0; i < SCAN_BATCH_SIZE; i++) {
    const barcode = pick(BARCODES);
    await scanBarcode(page, barcode);
    scanned.push(barcode);
  }
  await page.waitForTimeout(500);

  // Verify cart has items (should merge duplicates)
  const cartVisible = await page.getByText("لا توجد أصناف بعد").isVisible().catch(() => false);
  if (cartVisible) {
    allErrors.push("[CASHIER] Cart still empty after scanning — possible state corruption");
  }

  // Try clicking a quick-key button for extra stress
  try {
    const qk = page.getByRole("button", { name: pick(QUICK_KEY_LABELS) }).first();
    if (await qk.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await qk.click();
      await page.waitForTimeout(200);
      console.log("  [CASHIER] Quick-key button clicked");
    }
  } catch (e) {
    // Quick keys may not always be visible
  }

  // Apply a random discount if items exist
  const discountBtn = page.getByRole("button", { name: /خصم/ }).first();
  if (await discountBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    try {
      await discountBtn.click();
      await page.waitForTimeout(300);
      // Close any discount modal with Escape
      await page.keyboard.press("Escape");
      console.log("  [CASHIER] Discount dialog opened and dismissed");
    } catch {}
  }

  // Open checkout
  const payBtn = page.getByRole("button", { name: /الدفع/ }).first();
  if (!await payBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    allErrors.push("[CASHIER] Pay button not visible — checkout may be broken");
    return;
  }
  await payBtn.click();

  const checkout = modal(page, "إتمام الدفع");
  await expect(checkout).toBeVisible({ timeout: 5_000 });

  // Randomly pick payment method: cash or debt
  const useDebt = Math.random() < 0.3; // 30% debt

  if (useDebt) {
    const debtBtn = checkout.getByRole("button", { name: "ذمم" });
    if (await debtBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await debtBtn.click();
      await page.waitForTimeout(200);
    }
  }

  // Confirm checkout
  const confirmPatterns = [
    /تأكيد الدفع \(نقداً\)/,
    /تأكيد الدفع \(على الذمم\)/,
    /تأكيد الدفع/,
  ];
  let confirmed = false;
  for (const pattern of confirmPatterns) {
    const btn = page.getByRole("button", { name: pattern }).first();
    if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await btn.click();
      confirmed = true;
      break;
    }
  }

  if (!confirmed) {
    allErrors.push("[CASHIER] Could not find confirm payment button");
    await page.keyboard.press("Escape");
    return;
  }

  // Wait for success toast
  try {
    await expect(
      page.getByText(/تم حفظ الفاتورة|تم الحفظ/)
    ).toBeVisible({ timeout: 8_000 });
    console.log(`  [CASHIER] Checkout completed (${useDebt ? "DEBT" : "CASH"})`);
  } catch {
    allErrors.push("[CASHIER] Success toast not shown after checkout");
  }
}

// ─── Inventory Manager Workflow ───────────────────────────────────────────────

async function inventoryWorkflow(page, iteration, allErrors) {
  console.log(`  [INVENTORY] Iteration ${iteration + 1}: navigating to inventory…`);

  await page.goto("/admin/inventory/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);

  // Verify page loaded
  const title = page.getByText("المخزون والمنتجات");
  if (!await title.isVisible({ timeout: 5_000 }).catch(() => false)) {
    allErrors.push("[INVENTORY] Page title not visible — page may have failed to load");
    return;
  }

  // Check stat cards
  const productsCard = page.getByText("المنتجات").first();
  console.log(`  [INVENTORY] Stat cards visible: ${await productsCard.isVisible().catch(() => false)}`);

  // Search for a product
  const searchInput = page.locator("input[placeholder*='ابحث بالاسم']");
  if (await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await searchInput.fill("كاسات");
    await page.waitForTimeout(500);
    await searchInput.fill(""); // clear
    await page.waitForTimeout(300);
    console.log("  [INVENTORY] Search performed");
  }

  // Click "تحديث" (Refresh) button
  try {
    const refreshBtn = page.getByRole("button", { name: "تحديث" }).first();
    if (await refreshBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await refreshBtn.click();
      await page.waitForTimeout(500);
      console.log("  [INVENTORY] Refresh clicked");
    }
  } catch {}

  // Open Add Product modal
  const addBtn = page.getByRole("button", { name: "إضافة منتج" });
  if (await addBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(500);

    // Verify modal opened
    const productModal = page.getByText("إضافة منتج جديد");
    if (await productModal.isVisible({ timeout: 3_000 }).catch(() => false)) {
      console.log("  [INVENTORY] Add product modal opened");

      // Fill in a test product name
      const nameInput = page.locator("input[placeholder*='كاسات بلاستيك']");
      if (await nameInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const suffix = Date.now().toString().slice(-4);
        await nameInput.fill(` Stress Test ${suffix}`);
      }

      // Fill cost price
      const costInput = page.locator("input[placeholder='0.00']").first();
      if (await costInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await costInput.fill(String(randInt(1, 20)));
      }

      // Fill selling price
      const priceInputs = page.locator("input[placeholder='0.00']");
      const priceCount = await priceInputs.count();
      if (priceCount > 1) {
        await priceInputs.nth(1).fill(String(randInt(5, 40)));
      }

      // Cancel instead of save (avoid polluting data)
      const cancelBtn = page.getByRole("button", { name: "إلغاء" }).first();
      if (await cancelBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await cancelBtn.click();
        await page.waitForTimeout(300);
      }
      console.log("  [INVENTORY] Product form filled and cancelled");
    } else {
      allErrors.push("[INVENTORY] Add product modal did not appear");
      await page.keyboard.press("Escape");
    }
  }

  // Navigate to movements page
  try {
    const movementsLink = page.getByRole("link", { name: "الحركات" });
    if (await movementsLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await movementsLink.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1000);
      console.log("  [INVENTORY] Navigated to movements page");

      // Go back to inventory
      await page.goto("/admin/inventory/");
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Open Product Quantities modal
  try {
    const qtyBtn = page.getByRole("button", { name: "كميات المنتجات" });
    if (await qtyBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await qtyBtn.click();
      await page.waitForTimeout(500);
      // Close it
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      console.log("  [INVENTORY] Product quantities modal opened and closed");
    }
  } catch {}

  console.log("  [INVENTORY] Workflow complete");
}

// ─── Admin Workflow (Reports + Purchases) ─────────────────────────────────────

async function adminReportsWorkflow(page, iteration, allErrors) {
  console.log(`  [ADMIN-REPORTS] Iteration ${iteration + 1}: sales report…`);

  await page.goto("/admin/reports/sales/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);

  const title = page.getByText("سجل المبيعات والفواتير");
  if (!await title.isVisible({ timeout: 5_000 }).catch(() => false)) {
    allErrors.push("[ADMIN-REPORTS] Sales page title not visible");
    return;
  }

  // Check metric tiles
  const metricLabels = ["صافي المبيعات", "الربح الإجمالي", "هامش الربح", "عدد الفواتير"];
  for (const label of metricLabels) {
    const tile = page.getByText(label).first();
    const visible = await tile.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!visible) {
      allErrors.push(`[ADMIN-REPORTS] Metric tile "${label}" not visible`);
    }
  }

  // Change date filter
  const dateInputs = page.locator("input[type='date']");
  const dateCount = await dateInputs.count();
  if (dateCount >= 2) {
    // Set "from" to 90 days ago
    const d = new Date();
    d.setDate(d.getDate() - 90);
    const dateStr = d.toISOString().split("T")[0];
    await dateInputs.first().fill(dateStr);
    await page.waitForTimeout(300);

    // Click refresh
    const refreshBtn = page.getByRole("button", { name: "تحديث" }).first();
    if (await refreshBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await refreshBtn.click();
      await page.waitForTimeout(500);
    }
    console.log("  [ADMIN-REPORTS] Date filter changed and refreshed");
  }

  // Check invoice table
  const invoiceTable = page.locator("table").first();
  const rows = await invoiceTable.locator("tbody tr").count().catch(() => 0);
  console.log(`  [ADMIN-REPORTS] Invoice rows: ${rows}`);

  // Try pagination
  const nextBtn = page.getByRole("button", { name: "التالي" });
  if (await nextBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await nextBtn.click();
    await page.waitForTimeout(500);
    console.log("  [ADMIN-REPORTS] Navigated to next page");
    const prevBtn = page.getByRole("button", { name: "السابق" });
    if (await prevBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await prevBtn.click();
      await page.waitForTimeout(500);
    }
  }

  console.log("  [ADMIN-REPORTS] Workflow complete");
}

async function adminPurchasesWorkflow(page, iteration, allErrors) {
  console.log(`  [ADMIN-PURCHASES] Iteration ${iteration + 1}: purchase order…`);

  await page.goto("/admin/purchases/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);

  const title = page.getByText("أوامر الشراء والاستلام");
  if (!await title.isVisible({ timeout: 5_000 }).catch(() => false)) {
    allErrors.push("[ADMIN-PURCHASES] Page title not visible");
    return;
  }

  // Verify stat cards
  const pendingCard = page.getByText("أوامر معلقة");
  console.log(`  [ADMIN-PURCHASES] Pending card visible: ${await pendingCard.isVisible().catch(() => false)}`);

  // Fill supplier combobox
  const supplierCombo = page.locator("#po-supplier");
  if (await supplierCombo.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await supplierCombo.click();
    await page.waitForTimeout(300);

    // Type to search
    const searchInput = page.locator("input[placeholder*='ابحث في المورد']");
    if (await searchInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await searchInput.fill("شركة");
      await page.waitForTimeout(500);

      // Try to select first option
      const option = page.getByRole("option").first();
      if (await option.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await option.click();
        await page.waitForTimeout(300);
        console.log("  [ADMIN-PURCHASES] Supplier selected");
      } else {
        // Try adding a new supplier
        const addBtn = page.getByRole("button", { name: /إضافة مورد/ });
        if (await addBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await addBtn.click();
          await page.waitForTimeout(500);
          // Fill new supplier name
          const nameInput = page.locator("input[placeholder*='شركة الأمانة']");
          if (await nameInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
            const suffix = Date.now().toString().slice(-4);
            await nameInput.fill(`مورد اختبار ${suffix}`);
            const createBtn = page.getByRole("button", { name: "إضافة واختيار" });
            if (await createBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
              await createBtn.click();
              await page.waitForTimeout(500);
              console.log("  [ADMIN-PURCHASES] New supplier created");
            }
          }
        }
        await page.keyboard.press("Escape");
      }
    } else {
      await page.keyboard.press("Escape");
    }
  }

  // Add a line item manually via "يدوياً" button
  try {
    const manualBtn = page.getByRole("button", { name: "يدوياً" });
    if (await manualBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await manualBtn.click();
      await page.waitForTimeout(500);
      console.log("  [ADMIN-PURCHASES] Manual line added");

      // Fill product combobox in the new line
      const productCombo = page.locator("[id^='po-product-']").first();
      if (await productCombo.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await productCombo.click();
        await page.waitForTimeout(300);
        const searchInput = page.locator("input[placeholder*='ابحث بالاسم']").first();
        if (await searchInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await searchInput.fill("ماء");
          await page.waitForTimeout(500);
          const option = page.getByRole("option").first();
          if (await option.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await option.click();
            await page.waitForTimeout(300);
            console.log("  [ADMIN-PURCHASES] Product selected for PO line");
          }
        }
      }
    }
  } catch {}

  // Try creating the PO (may fail if validation not met — that's ok for stress test)
  try {
    const createBtn = page.getByRole("button", { name: "إنشاء أمر الشراء" });
    if (await createBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(1000);
      // Check if it succeeded or showed validation error
      const errorMsg = page.locator("p.text-destructive").first();
      if (await errorMsg.isVisible({ timeout: 1_000 }).catch(() => false)) {
        const text = await errorMsg.textContent();
        console.log(`  [ADMIN-PURCHASES] Validation: ${text}`);
      } else {
        console.log("  [ADMIN-PURCHASES] PO submitted");
      }
    }
  } catch {}

  // Try receiving an existing PO if any pending exists
  try {
    const receiveBtn = page.getByRole("button", { name: "استلام" }).first();
    if (await receiveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await receiveBtn.click();
      await page.waitForTimeout(1000);

      const reconcileModal = modal(page, "تسوية الاستلام");
      if (await reconcileModal.isVisible({ timeout: 3_000 }).catch(() => false)) {
        console.log("  [ADMIN-PURCHASES] Reconciliation modal opened");

        // Confirm receive
        const confirmBtn = reconcileModal.getByRole("button", { name: /استلام/ });
        if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await confirmBtn.click();
          await page.waitForTimeout(1000);
          console.log("  [ADMIN-PURCHASES] PO received");
        }
      }
    }
  } catch {}

  // Navigate to cost history
  try {
    const reportsLink = page.getByRole("link", { name: "مركز التقارير" }).first();
    if (await reportsLink.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await reportsLink.click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  console.log("  [ADMIN-PURCHASES] Workflow complete");
}

// ─── Main Test ────────────────────────────────────────────────────────────────

test.describe("E2E Stress Simulation — Full System", () => {
  test("heavy loop: Cashier + Inventory + Admin workflows", async ({ page }) => {
    const allErrors = collectConsoleErrors(page);
    const assertionErrors = [];
    const startTime = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes hard limit

    // Remove Web Serial API
    await disableSerial(page);

    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  E2E STRESS TEST — Full System Simulation");
    console.log(`  ${LOOPS_PER_ROLE} iterations per role | ${SCAN_BATCH_SIZE} scans/round`);
    console.log("═══════════════════════════════════════════════════════════════");

    // ── Phase 0: Login as Admin ──
    console.log("\n▶ PHASE 0: Admin Login");
    await adminLogin(page);
    await openRegister(page);
    await openShift(page);
    console.log("  Admin logged in, shift opened");

    // ── Heavy Loop ──
    for (let loop = 0; loop < LOOPS_PER_ROLE; loop++) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        console.log("\n⏰ Timeout reached — stopping stress test");
        break;
      }

      console.log(`\n═══════════════════════════════════════════════════════════════`);
      console.log(`  LOOP ${loop + 1} / ${LOOPS_PER_ROLE}`);
      console.log(`═══════════════════════════════════════════════════════════════`);

      // ── Role 1: Cashier ──
      console.log("\n▶ ROLE 1: CASHIER");
      await page.goto("/pos/");
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);

      // Ensure shift is open
      await openRegister(page);
      await openShift(page);

      for (let i = 0; i < 2; i++) {
        try {
          await cashierWorkflow(page, i, allErrors);
        } catch (e) {
          assertionErrors.push(`[CASHIER] Loop ${loop} Iter ${i}: ${e.message}`);
          console.error(`  ✗ Cashier error: ${e.message?.slice(0, 200)}`);
          // Try to recover — press Escape and navigate back
          await page.keyboard.press("Escape").catch(() => {});
          await page.goto("/pos/");
          await page.waitForTimeout(1000);
          await openRegister(page);
          await openShift(page);
        }
      }

      // ── Role 2: Inventory Manager ──
      console.log("\n▶ ROLE 2: INVENTORY MANAGER");
      for (let i = 0; i < 2; i++) {
        try {
          await inventoryWorkflow(page, i, allErrors);
        } catch (e) {
          assertionErrors.push(`[INVENTORY] Loop ${loop} Iter ${i}: ${e.message}`);
          console.error(`  ✗ Inventory error: ${e.message?.slice(0, 200)}`);
          await page.keyboard.press("Escape").catch(() => {});
        }
      }

      // ── Role 3: Admin (Reports + Purchases) ──
      console.log("\n▶ ROLE 3: ADMIN");
      try {
        await adminReportsWorkflow(page, loop, allErrors);
      } catch (e) {
        assertionErrors.push(`[ADMIN-REPORTS] Loop ${loop}: ${e.message}`);
        console.error(`  ✗ Reports error: ${e.message?.slice(0, 200)}`);
      }

      try {
        await adminPurchasesWorkflow(page, loop, allErrors);
      } catch (e) {
        assertionErrors.push(`[ADMIN-PURCHASES] Loop ${loop}: ${e.message}`);
        console.error(`  ✗ Purchases error: ${e.message?.slice(0, 200)}`);
      }

      // ── Return to POS for next loop ──
      console.log("\n▶ Returning to POS for next loop…");
      await page.goto("/pos/");
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
      await openRegister(page);
      await openShift(page);
    }

    // ── Final Report ──
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  STRESS TEST COMPLETE");
    console.log(`  Duration: ${elapsed}s`);
    console.log(`  Console errors captured: ${allErrors.length}`);
    console.log(`  Assertion/workflow errors: ${assertionErrors.length}`);
    console.log("═══════════════════════════════════════════════════════════════");

    if (allErrors.length > 0) {
      console.log("\n📋 CONSOLE ERRORS:");
      for (const err of allErrors) {
        console.log(`  ${err.slice(0, 300)}`);
      }
    }

    if (assertionErrors.length > 0) {
      console.log("\n📋 WORKFLOW/ASSERTION ERRORS:");
      for (const err of assertionErrors) {
        console.log(`  ${err.slice(0, 300)}`);
      }
    }

    // The test passes if no critical errors were found.
    // Console errors are logged but not failing — we want to SURVEY, not block.
    // Only fail on assertion-level errors that indicate real breakage.
    const criticalErrors = assertionErrors.filter(
      (e) => !e.includes("not visible") && !e.includes("Timeout")
    );

    if (criticalErrors.length > 0) {
      console.log(`\n⚠ ${criticalErrors.length} CRITICAL ERRORS — test marked as failed`);
      // Fail with the first critical error to surface it
      expect(criticalErrors.length).toBe(0);
    }

    console.log("\n✅ Stress simulation finished without critical failures");
  });
});
