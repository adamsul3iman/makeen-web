import { expect, test } from "@playwright/test";

interface PrintProbe {
  calls: Array<{ source: "window" | "iframe"; at: number }>;
  queueCountAtPrint: number;
}

declare global {
  interface Window {
    __printProbe: PrintProbe;
  }
}

test("checkout invokes browser print fallback after the invoice is durable", async ({ page }) => {
  await page.addInitScript(() => {
    const probe: PrintProbe = { calls: [], queueCountAtPrint: -1 };
    window.__printProbe = probe;

    const readDurableInvoiceCount = () => {
      const request = indexedDB.open("pos_local_db");
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("sync_queue")) {
          probe.queueCountAtPrint = 0;
          db.close();
          return;
        }
        const tx = db.transaction("sync_queue", "readonly");
        const rows = tx.objectStore("sync_queue").getAll();
        rows.onsuccess = () => {
          probe.queueCountAtPrint = rows.result.filter(
            (row) => row?.action_type === "INVOICE_CREATED",
          ).length;
        };
        tx.oncomplete = () => db.close();
      };
    };

    const recordPrint = (source: "window" | "iframe") => {
      probe.calls.push({ source, at: Date.now() });
      readDurableInvoiceCount();
    };

    Object.defineProperty(window, "print", {
      configurable: true,
      value: () => recordPrint("window"),
    });

    const appendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function <T extends Node>(node: T): T {
      const appended = Reflect.apply(appendChild, this, [node]) as T;
      if (node instanceof HTMLIFrameElement && node.contentWindow) {
        Object.defineProperty(node.contentWindow, "print", {
          configurable: true,
          value: () => recordPrint("iframe"),
        });
      }
      return appended;
    };
  });

  await page.goto("/e2e-print-fallback/");
  await expect(page.getByTestId("print-fallback-ready")).toBeAttached();

  await page.getByRole("button", { name: "دفع الفاتورة" }).click();
  await expect(page.getByRole("dialog", { name: "إتمام الدفع" })).toBeVisible();
  await page.getByRole("button", { name: /تأكيد الدفع/ }).click();

  await expect.poll(
    () => page.evaluate(() => window.__printProbe.calls.length),
    { timeout: 15_000, message: "the checkout should invoke a print fallback" },
  ).toBeGreaterThan(0);

  await expect.poll(
    () => page.evaluate(() => window.__printProbe.queueCountAtPrint),
    { timeout: 5_000, message: "the invoice must be in IndexedDB before print()" },
  ).toBeGreaterThan(0);

  const probe = await page.evaluate(() => window.__printProbe);
  expect(probe.calls.some((call) => call.source === "iframe" || call.source === "window")).toBe(true);
  await expect(page.getByText("تم حفظ الفاتورة محلياً وستتم المزامنة")).toBeVisible();
});
