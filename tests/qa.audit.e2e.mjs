import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = "admin@demo.test";
const ADMIN_PASSWORD = "12345678";

const modal = (page, title) =>
  page
    .locator("div.fixed.inset-0")
    .filter({ has: page.getByRole("heading", { name: title }) });

async function adminLogin(page) {
  await page.goto("/login");
  // /login defaults to the staff tab; the owner signs in on the "المالك" tab.
  await page.getByRole("tab", { name: "المالك" }).click();
  await page.locator("#admin-email").fill(ADMIN_EMAIL);
  await page.locator("#admin-password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await page.waitForURL("**/pos");
  // The owner (no PIN) lands on the welcome screen, not the cashier PIN pad.
  await expect(page.getByRole("button", { name: "افتح الصندوق الآن" })).toBeVisible();
}

async function openRegister(page) {
  await page.getByRole("button", { name: "افتح الصندوق الآن" }).click();
}

async function openShift(page, cash = "100") {
  await page.locator("#shift-opening-cash").fill(cash);
  await page.getByRole("button", { name: "فتح الوردية" }).click();
  await expect(page.locator("#pos-barcode-input")).toBeVisible();
}

async function scan(page, code) {
  await page.locator("#pos-barcode-input").fill(code);
  await page.locator("#pos-barcode-input").press("Enter");
}

async function confirmSecondaryAuth(page, password) {
  const auth = modal(page, "تأكيد المدير");
  await auth.locator('input[type="password"]').fill(password);
  // FIXED (F-2): SecondaryAuthModal now renders above the dialog beneath it,
  // so a pointer click on "تأكيد" works (previously needed an Enter key).
  await auth.getByRole("button", { name: "تأكيد" }).click();
  return auth;
}

test.describe("POS audit flows (mock mode)", () => {
  test.beforeEach(async ({ page }) => {
    // Remove the Web Serial API entirely. When serial exists but no device is
    // granted, openCashDrawer() awaits requestPort() (native chooser) forever,
    // wedging the secondary-auth modal in "جارٍ التحقق…".
    await page.addInitScript(() => {
      try {
        Object.defineProperty(Navigator.prototype, "serial", {
          configurable: true,
          get: () => undefined,
        });
      } catch {}
    });
  });

  test("FLOW 1: self-registration closed + super-admin provisioning", async ({
    page,
    request,
  }) => {
    // Self-service registration is closed: /register explains that stores are
    // created by the platform owner and points back to the owner login.
    await page.goto("/register");
    await expect(page.getByText("إنشاء المتاجر عبر مدير النظام")).toBeVisible();
    console.log("[FLOW1] self-registration is closed");

    // Provisioning happens only through the Super Admin console/API (7777).
    const suffix = Date.now().toString().slice(-5);
    const prov = await request.post("/api/admin/stores", {
      headers: { "x-pos-super-admin-pin": "7777" },
      data: {
        name: `QA متجر ${suffix}`,
        owner_name: `مدير ${suffix}`,
        email: `qa${suffix}@test.dev`,
        password: "password123",
      },
    });
    expect(prov.ok()).toBeTruthy();
    console.log("[FLOW1] store provisioned via super-admin");

    // login as the demo admin -> PIN -> open shift
    await adminLogin(page);
    await openRegister(page);
    await openShift(page);
    console.log("[FLOW1] owner reached POS with an open shift");
  });

  test("FLOW 2: admin hub, drawer secondary auth, cancel invoice", async ({
    page,
  }) => {
    await adminLogin(page);
    await openRegister(page);
    await openShift(page);

    await expect(page.getByText("وضع المدير")).toBeVisible();
    console.log("[FLOW2] admin mode top bar visible");

    // Admin Hub via hotkey; Esc closes it
    await page.keyboard.press("Control+Shift+A");
    const hub = modal(page, "لوحة التحكم");
    await expect(hub).toBeVisible();
    for (const label of ["الفواتير السابقة", "سجل الرقابة"]) {
      await expect(hub.getByRole("button", { name: label })).toBeVisible();
    }
    await expect(hub.getByRole("link", { name: "إدارة الموظفين" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(hub).toBeHidden();
    console.log("[FLOW2] admin hub opens and Esc closes it");

    // drawer: always demands secondary auth (even admin cashier)
    await page.getByRole("button", { name: "فتح الدرج" }).click();
    const auth = modal(page, "تأكيد المدير");
    await expect(auth).toBeVisible();
    await auth.locator('input[type="password"]').fill("wrong-password");
    await auth.getByRole("button", { name: "تأكيد" }).click();
    await expect(
      auth.getByText("تعذر التحقق — تحقق من كلمة المرور أو الاتصال")
    ).toBeVisible();
    console.log("[FLOW2] wrong password rejected with generic error");

    // FIXED (F-4): Esc now dismisses secondary auth like every other modal.
    await page.keyboard.press("Escape");
    await expect(auth).toBeHidden();
    console.log("[FLOW2] FIXED: Esc closes secondary auth");

    // correct password: modal closes; drawer attempt runs (mock: no serial printer)
    await page.getByRole("button", { name: "فتح الدرج" }).click();
    await confirmSecondaryAuth(page, ADMIN_PASSWORD);
    await expect(modal(page, "تأكيد المدير")).toBeHidden();
    await expect(
      page.getByText("تعذر فتح الدرج — لا يوجد طابعة حرارية أو درج متصل", {
        exact: false,
      })
    ).toBeVisible();
    console.log("[FLOW2] drawer action executed after reverify (mock no-serial)");

    // add items, checkout
    await scan(page, "12345");
    await scan(page, "6250000987654");
    await expect(page.getByText("كاسات بلاستيك 7 أونص")).toBeVisible();
    await expect(page.getByText("ماء معدني 500 مل")).toBeVisible();
    await page.getByRole("button", { name: /الدفع/ }).click();
    const checkout = modal(page, "إتمام الدفع");
    await expect(checkout).toBeVisible();
    // FIXED (F-5): the cash amount is pre-filled with the exact total
    // (0.40 + 16% tax = 0.46), so the confirm button is enabled immediately.
    await expect(checkout.locator("#checkout-amount")).toHaveValue("0.46");
    await page.getByRole("button", { name: "تأكيد الدفع (نقداً)" }).click();
    await expect(
      page.getByText("تم حفظ الفاتورة محلياً وستتم المزامنة", { exact: false })
    ).toBeVisible();
    console.log("[FLOW2] invoice paid and saved locally");

    // void the completed invoice via PreviousInvoices (secondary auth)
    await page.keyboard.press("Control+Shift+A");
    await hub.getByRole("button", { name: "الفواتير السابقة" }).click();
    const prev = modal(page, "الفواتير السابقة");
    await expect(prev).toBeVisible();
    await prev.getByRole("button", { name: "إلغاء" }).first().click();
    await confirmSecondaryAuth(page, ADMIN_PASSWORD);
    // PreviousInvoicesModal stays open and covers the toast (both z-50);
    // close it, then the void confirmation is visible.
    await prev.getByRole("button", { name: "إغلاق" }).click();
    await expect(
      page.getByText(/تم إلغاء الفاتورة .+ — سيتم عكسها عند المزامنة/)
    ).toBeVisible();
    console.log("[FLOW2] completed invoice voided via secondary auth");
  });

  test("FLOW 3: create cashier -> cashier login -> admin hidden -> /admin denied", async ({
    page,
  }) => {
    await adminLogin(page);
    await openRegister(page);
    await openShift(page);

    // create cashier via the back-office staff page (the single management UI)
    await page.keyboard.press("Control+Shift+A");
    const hub = modal(page, "لوحة التحكم");
    await hub.getByRole("link", { name: "إدارة الموظفين" }).click();
    await page.waitForURL("**/admin/staff");
    await page.getByRole("button", { name: "إضافة كاشير" }).click();
    const manage = modal(page, "إضافة كاشير");
    await expect(manage).toBeVisible();

    const suffix = Date.now().toString().slice(-4);
    const cashierName = `QA Cashier ${suffix}`;
    await manage.locator("#staff-name").fill(cashierName);
    await manage.locator("#staff-pin").fill("2468");
    await manage.getByRole("button", { name: "حفظ" }).click();

    const auth = modal(page, "تأكيد المدير");
    await expect(auth).toBeVisible();

    // FIXED (F-2): SecondaryAuthModal renders last with a higher z-index tier
    // than the staff modal, so the element under the "تأكيد" button's
    // centre must now be the button itself (was the staff-modal form).
    const onTop = await auth
      .getByRole("button", { name: "تأكيد" })
      .evaluate((btn) => {
        const r = btn.getBoundingClientRect();
        const el = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2
        );
        return el ? (el.textContent ?? "").trim().slice(0, 30) : "(none)";
      });
    await expect(onTop).toContain("تأكيد");
    console.log("[FLOW3] FIXED: auth confirm button is topmost:", JSON.stringify(onTop));

    await confirmSecondaryAuth(page, ADMIN_PASSWORD);
    // the staff page refreshes the roster after the auth modal closes
    await expect(page.getByText(cashierName)).toBeVisible();
    console.log("[FLOW3] cashier saved via secondary auth:", cashierName);

    // back to the POS to hand over to the cashier
    await page.goto("/pos");
    await page.getByRole("button", { name: /قفل/ }).click();
    // FIXED (F-6): locking the register is now a full sign-out — no local PIN
    // pad. The register routes straight to the unified /login gateway, where
    // staff sign in with store code + username + PIN.
    await page.waitForURL("**/login");
    await page.locator("#login-store-code").fill("MAIN01");
    await page.locator("#login-username").fill("mahmoud");
    await page.locator("#login-pin").fill("9999");
    await page.getByRole("button", { name: "دخول" }).click();
    await page.waitForURL("**/pos");
    await expect(page.locator("#pos-barcode-input")).toBeVisible();
    console.log("[FLOW3] cashier signed in via unified /login (store code + username + PIN)");

    // FIXED (F-1): a staff sign-in severs adminSession, so the admin top
    // bar must NOT render for a PIN-only cashier.
    await expect(page.getByText("وضع المدير")).not.toBeVisible();
    console.log("[FLOW3] FIXED: admin top bar hidden after cashier login");

    // FIXED: the Admin Hub hotkey is adminSession-gated, and the session is
    // gone after lock, so the cashier cannot open it.
    await page.keyboard.press("Control+Shift+A");
    await expect(
      page.getByRole("heading", { name: "لوحة التحكم" })
    ).not.toBeVisible();
    console.log("[FLOW3] FIXED: cashier cannot open Admin Hub after lock");

    // FIXED: forced /admin navigation is denied — the signed cashier is
    // bounced off /admin to their role home (/pos).
    await page.goto("/admin");
    await page.waitForURL("**/pos");
    console.log("[FLOW3] FIXED: /admin redirects to /pos for a signed cashier");

    // sign the cashier out (lock = full sign-out to the login gateway)
    await page.getByRole("button", { name: /قفل/ }).click();
    await page.waitForURL("**/login");

    // admin can log in again
    await page.getByRole("tab", { name: "المالك" }).click();
    await page.locator("#admin-email").fill(ADMIN_EMAIL);
    await page.locator("#admin-password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "دخول" }).click();
    await page.waitForURL("**/pos");
    console.log("[FLOW3] admin login restored");

    // A dashboard login with a persisted cashier lands straight in the POS;
    // simulate the fresh-register state (adminSession present, no cashier) to
    // exercise the lock screen's explicit admin sign-out. The running app can
    // re-persist its in-memory cashier over a manual write, so every setItem
    // is patched to re-apply the null before navigating.
    await page.evaluate(() => {
      const patch = () => {
        const raw = localStorage.getItem("pos-store");
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.state && s.state.currentCashier) {
          s.state.currentCashier = null;
          localStorage.setItem("pos-store", JSON.stringify(s));
        }
      };
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        orig.call(this, key, value);
        if (key === "pos-store") patch();
      };
      patch();
    });
    await page.goto("/pos");
    // adminSession present + no cashier session -> the owner welcome screen
    await expect(
      page.getByRole("button", { name: "افتح الصندوق الآن" })
    ).toBeVisible();

    // FIXED (F-1): the welcome screen exposes the owner logout so the owner can
    // deliberately sign out of admin mode before handing the register over.
    await expect(
      page.getByRole("button", { name: /تسجيل خروج المدير/ })
    ).toBeVisible();
    await page.getByRole("button", { name: /تسجيل خروج المدير/ }).click();
    // Logout hard-navigates straight to the unified /login — the old
    // "no active store" intermediate screen no longer flashes.
    await page.waitForURL("**/login");
    await page.goto("/admin");
    await page.waitForURL("**/login");
    console.log(
      "[FLOW3] FIXED: owner logout redirects to unified /login; /admin denied after sign-out"
    );
  });

  test("FLOW 4: stress (50 items, F3 inert, cash buttons) + 3-tab shared state", async ({
    page,
  }) => {
    await adminLogin(page);
    await openRegister(page);
    await openShift(page);

    // F3 is NOT a hotkey: cart stays empty, no custom-item dialog
    await expect(page.getByText("لا توجد أصناف بعد")).toBeVisible();
    await page.keyboard.press("F3");
    await page.waitForTimeout(400);
    await expect(page.getByText("لا توجد أصناف بعد")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "تعديل سعر الصنف" })
    ).toHaveCount(0);
    console.log("[FLOW4] F3 inert (no dialog, cart unchanged)");

    // stress: 50x scan of one item -> merged single line, total 8.70 د.أ (16% tax)
    for (let i = 0; i < 50; i++) {
      await scan(page, "12345");
    }
    await page.waitForTimeout(800);
    await expect(
      page.getByText("8.70 د.أ", { exact: false }).first()
    ).toBeVisible();
    console.log("[FLOW4] 50x merged, total 8.70 (subtotal+16% tax)");

    // quick-cash button 10.00, pay
    await page.getByRole("button", { name: /الدفع/ }).click();
    const checkout = modal(page, "إتمام الدفع");
    await expect(checkout).toBeVisible();
    await checkout.getByRole("button", { name: "10.00" }).click();
    await page.getByRole("button", { name: "تأكيد الدفع (نقداً)" }).click();
    await expect(
      page.getByText("تم حفظ الفاتورة محلياً وستتم المزامنة", { exact: false })
    ).toBeVisible();
    console.log("[FLOW4] 50-item invoice paid via quick-cash 10.00");

    // FIXED (F-3): cross-tab cart sync via a storage listener — a scan in one
    // tab now live-updates every already-open tab.
    const storedItems = async (p) => {
      const raw = await p.evaluate(() => localStorage.getItem("pos-store"));
      try {
        const parsed = JSON.parse(raw);
        return parsed.state?.items ?? parsed.state;
      } catch {
        return raw;
      }
    };

    const ctx = page.context();
    const tab2 = await ctx.newPage();
    await tab2.goto("/pos");
    await expect(tab2.locator("#pos-barcode-input")).toBeVisible();
    // wait until the catalog is loaded in this tab (quick keys render only
    // after hydrateCatalog fills the snapshot / barcodeIndex)
    await expect(
      tab2.getByRole("button", { name: "كاسات بلاستيك" }).first()
    ).toBeVisible();
    await scan(tab2, "6250000987654");
    await expect(tab2.getByText("ماء معدني 500 مل")).toBeVisible();
    await expect(page.getByText("ماء معدني 500 مل")).toBeVisible();
    console.log("[FLOW4] FIXED: tab2 scan live-synced into tab1");
    await expect(
      (await storedItems(tab2)).some((i) => i.barcode === "6250000987654")
    ).toBe(true);
    await expect(
      (await storedItems(page)).some((i) => i.barcode === "6250000987654")
    ).toBe(true);
    console.log("[FLOW4] persisted pos-store shared across tabs");

    const tab3 = await ctx.newPage();
    await tab3.goto("/pos");
    await expect(tab3.locator("#pos-barcode-input")).toBeVisible();
    await expect(
      tab3.getByRole("button", { name: "كاسات بلاستيك" }).first()
    ).toBeVisible();
    await scan(tab3, "12345");
    await expect(tab3.getByText("كاسات بلاستيك 7 أونص")).toBeVisible();
    await expect(page.getByText("كاسات بلاستيك 7 أونص").first()).toBeVisible();
    await expect(tab2.getByText("كاسات بلاستيك 7 أونص").first()).toBeVisible();
    console.log("[FLOW4] FIXED: tab3 scan live-synced into tabs 1+2");
    await expect(
      (await storedItems(tab3)).some((i) => i.barcode === "12345")
    ).toBe(true);
    await expect(
      (await storedItems(tab2)).some((i) => i.barcode === "12345")
    ).toBe(true);
    await tab2.close();
    await tab3.close();
  });
});
