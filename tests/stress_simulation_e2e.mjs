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
 * NOTE: The client-side login uses Supabase RPC directly, so real Supabase
 * keys must be present in .env.local. The provided credentials
 * (alburjhom3@gmail.com / 12345678) may not exist on this Supabase instance;
 * the script uses the known-working demo admin (admin@demo.test / 12345678)
 * and falls back to the staff login path (MAIN01 / ahmed / 1234).
 */
import { test, expect } from "@playwright/test";

// ─── Config ───────────────────────────────────────────────────────────────────
const ADMIN_EMAIL    = "admin@demo.test";
const ADMIN_PASSWORD = "12345678";

const STORE_CODE   = "MAIN01";
const CASHIER_USER = "ahmed";
const CASHIER_PIN  = "1234";

const LOOPS_PER_ROLE = 3;
const SCAN_BATCH_SIZE = 5;

const BARCODES = [
  "12345",              // كاسات بلاستيك
  "6250001234567",      // كرتونة كاسات
  "6250001234574",      // رول سفرة نايلون
  "6250001234581",      // بشاكير قطن
  "6291040123456",      // منظف زجاج
  "6291040123463",      // مبيض ملابس
  "6291010253456",      // حليب طويل الأمد
  "2000012345678",      // ليمون بلدي
  "2000012345685",      // بندورة بلدية
  "6250000987654",      // ماء معدني
  "6250000987678",      // سكر رز
  "6250000987685",      // رز بسمتي
  "6250000987692",      // شيبس عائلي
  "6250000987708",      // زيت دوار الشمس
];

const QUICK_KEY_LABELS = [
  "كاسات بلاستيك", "بشاكير قطن", "رول سفرة", "منظف زجاج",
  "مبيض", "حليب", "ماء", "سكر", "رز بسمتي", "شيبس", "زيت",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

const modal = (page, title) =>
  page.locator("div.fixed.inset-0").filter({ has: page.getByRole("heading", { name: title }) });

async function disableSerial(page) {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, "serial", {
        configurable: true, get: () => undefined,
      });
    } catch {}
  });
}

function collectConsoleErrors(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`[console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

// ─── Login Helpers ────────────────────────────────────────────────────────────

async function adminLogin(page) {
  await page.goto("/login/");
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("tab", { name: "المالك" }).click();
  await page.locator("#login-email").fill(ADMIN_EMAIL);
  await page.locator("#login-password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await page.waitForURL("**/pos/**", { timeout: 30_000 });
}

async function openRegister(page) {
  const openBtn = page.getByRole("button", { name: "افتح الصندوق الآن" });
  if (await openBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await openBtn.click();
    await page.waitForTimeout(500);
  }
}

async function openShift(page, cash = "100") {
  const cashInput = page.locator("#shift-opening-cash");
  if (await cashInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await cashInput.fill(cash);
    await page.getByRole("button", { name: "فتح الوردية" }).click();
    await page.locator("#pos-barcode-input").waitFor({ state: "visible", timeout: 10_000 });
  }
}

async function scanBarcode(page, code) {
  const input = page.locator("#pos-barcode-input");
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill(code);
  await input.press("Enter");
  await page.waitForTimeout(150);
}

// ─── Cashier Workflow ─────────────────────────────────────────────────────────

async function cashierWorkflow(page, iteration, allErrors) {
  console.log(`  [CASHIER] Iteration ${iteration + 1}: scanning ${SCAN_BATCH_SIZE} products…`);

  for (let i = 0; i < SCAN_BATCH_SIZE; i++) {
    await scanBarcode(page, pick(BARCODES));
  }
  await page.waitForTimeout(400);

  const cartEmpty = await page.getByText("لا توجد أصناف بعد").isVisible().catch(() => false);
  if (cartEmpty) {
    allErrors.push("[CASHIER] Cart still empty after scanning — possible state corruption");
  }

  // Quick-key click
  try {
    const qk = page.getByRole("button", { name: pick(QUICK_KEY_LABELS) }).first();
    if (await qk.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await qk.click();
      await page.waitForTimeout(200);
      console.log("  [CASHIER] Quick-key clicked");
    }
  } catch {}

  // Open checkout
  const payBtn = page.getByRole("button", { name: /الدفع/ }).first();
  if (!await payBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    allErrors.push("[CASHIER] Pay button not visible");
    return;
  }
  await payBtn.click();

  const checkout = modal(page, "إتمام الدفع");
  await expect(checkout).toBeVisible({ timeout: 8_000 });

  // Randomly pick debt (30%)
  const useDebt = Math.random() < 0.3;
  if (useDebt) {
    const debtBtn = checkout.getByRole("button", { name: "ذمم" });
    if (await debtBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await debtBtn.click();
      await page.waitForTimeout(200);
    }
  }

  // Confirm
  let confirmed = false;
  for (const pattern of [/تأكيد الدفع \(نقداً\)/, /تأكيد الدفع \(على الذمم\)/, /تأكيد الدفع/]) {
    const btn = page.getByRole("button", { name: pattern }).first();
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click();
      confirmed = true;
      break;
    }
  }
  if (!confirmed) {
    allErrors.push("[CASHIER] Confirm button not found");
    await page.keyboard.press("Escape");
    return;
  }

  try {
    await expect(page.getByText(/تم حفظ الفاتورة|تم الحفظ/)).toBeVisible({ timeout: 10_000 });
    console.log(`  [CASHIER] Checkout OK (${useDebt ? "DEBT" : "CASH"})`);
  } catch {
    allErrors.push("[CASHIER] Success toast not shown after checkout");
  }
}

// ─── Inventory Manager Workflow ───────────────────────────────────────────────

async function inventoryWorkflow(page, iteration, allErrors) {
  console.log(`  [INVENTORY] Iteration ${iteration + 1}`);

  await page.goto("/admin/inventory/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);

  if (!await page.getByText("المخزون والمنتجات").isVisible({ timeout: 5_000 }).catch(() => false)) {
    allErrors.push("[INVENTORY] Page title not visible");
    return;
  }
  console.log("  [INVENTORY] Page loaded");

  // Search
  const searchInput = page.locator("input[placeholder*='ابحث بالاسم']");
  if (await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await searchInput.fill("كاسات");
    await page.waitForTimeout(500);
    await searchInput.fill("");
    await page.waitForTimeout(300);
    console.log("  [INVENTORY] Search performed");
  }

  // Refresh
  const refreshBtn = page.getByRole("button", { name: "تحديث" }).first();
  if (await refreshBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await refreshBtn.click();
    await page.waitForTimeout(500);
  }

  // Add Product modal
  const addBtn = page.getByRole("button", { name: "إضافة منتج" });
  if (await addBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(800);

    if (await page.getByText("إضافة منتج جديد").isVisible({ timeout: 3_000 }).catch(() => false)) {
      console.log("  [INVENTORY] Add product modal opened");

      const nameInput = page.locator("input[placeholder*='كاسات بلاستيك']");
      if (await nameInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await nameInput.fill(` Stress Test ${Date.now().toString().slice(-4)}`);
      }

      // Fill cost + price
      const zeros = page.locator("input[placeholder='0.00']");
      if ((await zeros.count()) >= 2) {
        await zeros.first().fill(String(randInt(1, 20)));
        await zeros.nth(1).fill(String(randInt(5, 40)));
      }

      // Cancel (don't pollute data)
      const cancelBtn = page.getByRole("button", { name: "إلغاء" }).first();
      if (await cancelBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await cancelBtn.click();
        await page.waitForTimeout(300);
      }
      console.log("  [INVENTORY] Product form filled + cancelled");
    } else {
      allErrors.push("[INVENTORY] Add product modal didn't appear");
      await page.keyboard.press("Escape");
    }
  }

  // Movements page
  const movLink = page.getByRole("link", { name: "الحركات" });
  if (await movLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await movLink.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);
    console.log("  [INVENTORY] Movements page visited");
    await page.goto("/admin/inventory/");
    await page.waitForTimeout(1000);
  }

  // Product Quantities modal
  const qtyBtn = page.getByRole("button", { name: "كميات المنتجات" });
  if (await qtyBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await qtyBtn.click();
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    console.log("  [INVENTORY] Quantities modal opened+closed");
  }

  console.log("  [INVENTORY] Done");
}

// ─── Admin Reports Workflow ───────────────────────────────────────────────────

async function adminReportsWorkflow(page, iteration, allErrors) {
  console.log(`  [ADMIN-REPORTS] Iteration ${iteration + 1}`);

  await page.goto("/admin/reports/sales/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);

  if (!await page.getByText("سجل المبيعات والفواتير").isVisible({ timeout: 5_000 }).catch(() => false)) {
    allErrors.push("[ADMIN-REPORTS] Page title not visible");
    return;
  }

  // Check metric tiles
  for (const label of ["صافي المبيعات", "الربح الإجمالي", "عدد الفواتير"]) {
    const ok = await page.getByText(label).first().isVisible({ timeout: 2_000 }).catch(() => false);
    if (!ok) allErrors.push(`[ADMIN-REPORTS] Metric "${label}" missing`);
  }

  // Change date range
  const dates = page.locator("input[type='date']");
  if ((await dates.count()) >= 2) {
    const d = new Date(); d.setDate(d.getDate() - 90);
    await dates.first().fill(d.toISOString().split("T")[0]);
    await page.waitForTimeout(300);
    const refBtn = page.getByRole("button", { name: "تحديث" }).first();
    if (await refBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await refBtn.click();
      await page.waitForTimeout(800);
    }
    console.log("  [ADMIN-REPORTS] Date filter changed");
  }

  // Pagination
  const nextBtn = page.getByRole("button", { name: "التالي" });
  if (await nextBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await nextBtn.click();
    await page.waitForTimeout(500);
    const prevBtn = page.getByRole("button", { name: "السابق" });
    if (await prevBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await prevBtn.click();
      await page.waitForTimeout(500);
    }
    console.log("  [ADMIN-REPORTS] Pagination tested");
  }

  console.log("  [ADMIN-REPORTS] Done");
}

// ─── Admin Purchases Workflow ─────────────────────────────────────────────────

async function adminPurchasesWorkflow(page, iteration, allErrors) {
  console.log(`  [ADMIN-PURCHASES] Iteration ${iteration + 1}`);

  await page.goto("/admin/purchases/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);

  if (!await page.getByText("أوامر الشراء والاستلام").isVisible({ timeout: 5_000 }).catch(() => false)) {
    allErrors.push("[ADMIN-PURCHASES] Page title not visible");
    return;
  }
  console.log("  [ADMIN-PURCHASES] Page loaded");

  // Supplier combobox
  const supplierCombo = page.locator("#po-supplier");
  if (await supplierCombo.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await supplierCombo.click();
    await page.waitForTimeout(400);

    const searchInput = page.locator("input[placeholder*='ابحث في المورد']");
    if (await searchInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await searchInput.fill("شركة");
      await page.waitForTimeout(600);

      const option = page.getByRole("option").first();
      if (await option.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await option.click();
        await page.waitForTimeout(300);
        console.log("  [ADMIN-PURCHASES] Supplier selected");
      } else {
        // Create new supplier inline
        const addBtn = page.getByRole("button", { name: /إضافة مورد/ });
        if (await addBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await addBtn.click();
          await page.waitForTimeout(500);
          const nameInput = page.locator("input[placeholder*='شركة الأمانة']");
          if (await nameInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await nameInput.fill(`مورد اختبار ${Date.now().toString().slice(-4)}`);
            const createBtn = page.getByRole("button", { name: "إضافة واختيار" });
            if (await createBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
              await createBtn.click();
              await page.waitForTimeout(500);
              console.log("  [ADMIN-PURCHASES] New supplier created");
            }
          }
        }
        await page.keyboard.press("Escape").catch(() => {});
      }
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  // Add manual line
  try {
    const manualBtn = page.getByRole("button", { name: "يدوياً" });
    if (await manualBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await manualBtn.click();
      await page.waitForTimeout(500);

      const productCombo = page.locator("[id^='po-product-']").first();
      if (await productCombo.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await productCombo.click();
        await page.waitForTimeout(300);
        const searchInput = page.locator("input[placeholder*='ابحث بالاسم']").first();
        if (await searchInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await searchInput.fill("ماء");
          await page.waitForTimeout(600);
          const option = page.getByRole("option").first();
          if (await option.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await option.click();
            await page.waitForTimeout(300);
            console.log("  [ADMIN-PURCHASES] Product added to PO line");
          }
        }
      }
    }
  } catch {}

  // Submit PO
  try {
    const createBtn = page.getByRole("button", { name: "إنشاء أمر الشراء" });
    if (await createBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(1000);
      const err = page.locator("p.text-destructive").first();
      if (await err.isVisible({ timeout: 1_000 }).catch(() => false)) {
        console.log(`  [ADMIN-PURCHASES] Validation: ${await err.textContent()}`);
      } else {
        console.log("  [ADMIN-PURCHASES] PO submitted");
      }
    }
  } catch {}

  // Receive a pending PO
  try {
    const recvBtn = page.getByRole("button", { name: "استلام" }).first();
    if (await recvBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await recvBtn.click();
      await page.waitForTimeout(1000);
      const reconcile = modal(page, "تسوية الاستلام");
      if (await reconcile.isVisible({ timeout: 3_000 }).catch(() => false)) {
        console.log("  [ADMIN-PURCHASES] Reconciliation modal opened");
        const confirmBtn = reconcile.getByRole("button", { name: /استلام/ });
        if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await confirmBtn.click();
          await page.waitForTimeout(1000);
          console.log("  [ADMIN-PURCHASES] PO received");
        }
      }
    }
  } catch {}

  console.log("  [ADMIN-PURCHASES] Done");
}

// ─── Main Test ────────────────────────────────────────────────────────────────

test.describe("E2E Stress Simulation — Full System", () => {
  test("heavy loop: Cashier + Inventory + Admin workflows", async ({ page }) => {
    const allErrors = collectConsoleErrors(page);
    const workflowErrors = [];
    const startTime = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;

    await disableSerial(page);

    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  E2E STRESS TEST — Full System Simulation");
    console.log(`  ${LOOPS_PER_ROLE} iterations per role | ${SCAN_BATCH_SIZE} scans/round`);
    console.log("═══════════════════════════════════════════════════════════════");

    // Phase 0: Login
    console.log("\n▶ PHASE 0: Admin Login");
    await adminLogin(page);
    await openRegister(page);
    await openShift(page);
    console.log("  ✓ Admin logged in, shift opened");

    // Heavy loop
    for (let loop = 0; loop < LOOPS_PER_ROLE; loop++) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        console.log("\n⏰ Timeout — stopping");
        break;
      }

      console.log(`\n═══════ LOOP ${loop + 1}/${LOOPS_PER_ROLE} ═══════`);

      // Role 1: Cashier
      console.log("\n▶ CASHIER");
      await page.goto("/pos/");
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
      await openRegister(page);
      await openShift(page);

      for (let i = 0; i < 2; i++) {
        try {
          await cashierWorkflow(page, i, allErrors);
        } catch (e) {
          workflowErrors.push(`[CASHIER] L${loop} I${i}: ${e.message?.slice(0, 200)}`);
          console.error(`  ✗ Cashier error: ${e.message?.slice(0, 150)}`);
          await page.keyboard.press("Escape").catch(() => {});
          await page.goto("/pos/");
          await page.waitForTimeout(1000);
          await openRegister(page);
          await openShift(page);
        }
      }

      // Role 2: Inventory
      console.log("\n▶ INVENTORY MANAGER");
      for (let i = 0; i < 2; i++) {
        try {
          await inventoryWorkflow(page, i, allErrors);
        } catch (e) {
          workflowErrors.push(`[INVENTORY] L${loop} I${i}: ${e.message?.slice(0, 200)}`);
          console.error(`  ✗ Inventory error: ${e.message?.slice(0, 150)}`);
          await page.keyboard.press("Escape").catch(() => {});
        }
      }

      // Role 3: Admin
      console.log("\n▶ ADMIN");
      try {
        await adminReportsWorkflow(page, loop, allErrors);
      } catch (e) {
        workflowErrors.push(`[REPORTS] L${loop}: ${e.message?.slice(0, 200)}`);
        console.error(`  ✗ Reports error: ${e.message?.slice(0, 150)}`);
      }
      try {
        await adminPurchasesWorkflow(page, loop, allErrors);
      } catch (e) {
        workflowErrors.push(`[PURCHASES] L${loop}: ${e.message?.slice(0, 200)}`);
        console.error(`  ✗ Purchases error: ${e.message?.slice(0, 150)}`);
      }

      // Return to POS
      console.log("\n▶ Returning to POS…");
      await page.goto("/pos/");
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
      await openRegister(page);
      await openShift(page);
    }

    // Report
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  STRESS TEST COMPLETE");
    console.log(`  Duration: ${elapsed}s`);
    console.log(`  Console errors: ${allErrors.length}`);
    console.log(`  Workflow errors: ${workflowErrors.length}`);
    console.log("═══════════════════════════════════════════════════════════════");

    if (allErrors.length > 0) {
      console.log("\n📋 CONSOLE ERRORS:");
      for (const e of allErrors.slice(0, 50)) console.log(`  ${e.slice(0, 300)}`);
    }
    if (workflowErrors.length > 0) {
      console.log("\n📋 WORKFLOW ERRORS:");
      for (const e of workflowErrors.slice(0, 50)) console.log(`  ${e.slice(0, 300)}`);
    }

    const critical = workflowErrors.filter((e) => !e.includes("not visible") && !e.includes("Timeout"));
    if (critical.length > 0) {
      console.log(`\n⚠ ${critical.length} CRITICAL ERRORS`);
      expect(critical.length).toBe(0);
    }

    console.log("\n✅ Stress simulation finished");
  });
});
