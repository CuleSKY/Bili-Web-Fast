import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/tests/playwright",
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    headless: true,
  },
});
