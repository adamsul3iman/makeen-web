import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--disable-features=Serial"] });
const context = await browser.newContext({ locale: "ar-JO" });
const page = await context.newPage();

// Track all failed requests
const failedRequests = [];
page.on("requestfailed", (req) => {
  failedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
});
page.on("response", (resp) => {
  if (resp.status() >= 400) {
    console.log(`[HTTP ${resp.status()}] ${resp.url().slice(0, 150)}`);
  }
});

try {
  await page.goto("http://127.0.0.1:3199/login/", { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(3000);

  console.log("\nFailed requests:");
  for (const r of failedRequests) {
    console.log(`  ${r.url.slice(0, 120)} — ${r.failure}`);
  }

  // Check if React hydrated
  const hydrated = await page.evaluate(() => {
    return typeof window.__NEXT_DATA__ !== 'undefined' || document.querySelector('[data-reactroot]') !== null;
  });
  console.log("\nReact hydrated:", hydrated);

  // Check script loading
  const scripts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script')).map(s => ({
      src: s.src?.slice(0, 100) || '(inline)',
      loaded: s.readyState || 'unknown'
    }));
  });
  console.log("\nScripts:", JSON.stringify(scripts.slice(0, 10), null, 2));

  // Check for any JS errors in the page
  const jsCheck = await page.evaluate(() => {
    try {
      return `React: ${typeof window.React}, Next: ${typeof window.__NEXT_DATA__}`;
    } catch(e) { return e.message; }
  });
  console.log("\nJS check:", jsCheck);
} catch (e) {
  console.error("ERROR:", e.message?.slice(0, 300));
} finally {
  await browser.close();
}
