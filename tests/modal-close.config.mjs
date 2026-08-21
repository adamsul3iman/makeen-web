import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./",
  testMatch: /modal-close\.e2e\.mjs/,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:3199",
    channel: "chrome",
    headless: true,
    launchOptions: {
      args: ["--disable-features=Serial"],
    },
    trace: "off",
    screenshot: "off",
    video: "off",
    locale: "ar-JO",
  },
});
