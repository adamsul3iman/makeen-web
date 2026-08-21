import { test, expect } from "@playwright/test";

/**
 * Regression spec (F-6): every POS modal's X (close) button must actually
 * close its dialog. Root cause fixed: PosLayout rendered several keyed
 * siblings with the SAME `key={modalSession}` value — React requires unique
 * keys among siblings, and the duplicate keys broke the unmount commit, so
 * clicking X set the store flag but the modal stayed on screen. Keys are now
 * per-modal (`search-${modalSession}`, `hub-${modalSession}`, ...).
 *
 * Opens each modal, scopes its X button inside that modal's backdrop, clicks
 * it, and asserts the modal unmounts.
 */
const ADMIN_EMAIL = "admin@demo.test";
const ADMIN_PASSWORD = "12345678";

async function login(page) {
  await page.goto("/login");
  await page.locator("#admin-email").fill(ADMIN_EMAIL);
  await page.locator("#admin-password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await page.waitForURL("**/pos");
  for (const digit of "1234") {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await page.locator("#shift-opening-cash").fill("100");
  await page.getByRole("button", { name: "فتح الوردية" }).click();
  await expect(page.locator("#pos-barcode-input")).toBeVisible();
}

async function scan(page, code) {
  await page.locator("#pos-barcode-input").fill(code);
  await page.locator("#pos-barcode-input").press("Enter");
}

const modal = (page, title) =>
  page
    .locator("div.fixed.inset-0")
    .filter({ has: page.getByRole("heading", { name: title }) });

const closeBtn = (modalLocator) =>
  modalLocator
    .getByRole("button", { name: "إغلاق", exact: true })
    .or(modalLocator.getByRole("button", { name: "إلغاء", exact: true }));

test("X button closes every modal (scoped)", async ({ page }) => {  await login(page);
  await scan(page, "12345");

  const results = {};

  const tryClose = async (name, openModal, title) => {
    await openModal();
    const m = modal(page, title);
    await expect(m).toBeVisible({ timeout: 8000 });
    const btn = closeBtn(m);
    await btn.first().waitFor({ state: "visible", timeout: 8000 });
    await btn.first().click();
    await expect(m).toBeHidden({ timeout: 8000 });
    results[name] = "OK";
  };

  await tryClose(
    "AdminHub",
    () => page.keyboard.press("Control+Shift+A"),
    "لوحة التحكم"
  );
  await tryClose("SmartSearch", () => page.keyboard.press("Control+k"), "بحث");
  await tryClose("Checkout", () => page.keyboard.press("F2"), "إتمام الدفع");
  await tryClose("HeldInvoices", () => page.keyboard.press("F9"), "الفاتورات المعلقة");
  await tryClose("CloseShift", () => page.keyboard.press("F10"), "تقرير نهاية الوردية (Z)");
  await tryClose("DebtSettlement", () => page.keyboard.press("F7"), "سداد الذمم");
  await tryClose(
    "Expense",
    () => page.getByRole("button", { name: "مصروف" }).click(),
    "تسجيل مصروف"
  );
  await tryClose(
    "Discount",
    () => page.getByRole("button", { name: "خصم على الفاتورة" }).click(),
    "خصم على الفاتورة"
  );

  await page.keyboard.press("Control+Shift+A");
  const hub = modal(page, "لوحة التحكم");
  await hub.getByRole("link", { name: "إدارة الموظفين" }).click();
  await page.waitForURL("**/admin/staff");
  await page.goto("/pos");
  await page.keyboard.press("Control+Shift+A");
  await hub.getByRole("button", { name: "الفواتير السابقة" }).click();
  await tryClose(
    "PreviousInvoices",
    () => Promise.resolve(),
    "الفواتير السابقة"
  );
  await page.keyboard.press("Control+Shift+A");
  await hub.getByRole("button", { name: "سجل الرقابة" }).click();
  await tryClose(
    "AuditLog",
    () => Promise.resolve(),
    "سجل الرقابة"
  );

  console.log("\n=== X-button results ===");
  for (const [k, v] of Object.entries(results)) console.log(`${v.padEnd(6)} ${k}`);
});
