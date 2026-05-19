import fs from "node:fs/promises";
import path from "node:path";
import { chromium, test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export { expect } from "@playwright/test";

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  page: Page;
  extensionPage: (path: string) => Promise<Page>;
};

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use, testInfo) => {
    const extensionPath = path.resolve(process.cwd(), "dist-extension");
    const userDataDir = testInfo.outputPath("chromium-profile");
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=UseEcoQoSForBackgroundProcess",
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker");
    }
    const extensionId = new URL(serviceWorker.url()).host;
    await use(extensionId);
  },

  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },

  extensionPage: async ({ context, extensionId }, use) => {
    await use(async (path: string) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}${path}`);
      return page;
    });
  },
});
