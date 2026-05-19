import { test, expect } from "./fixtures";

test.describe("extension local harness", () => {
  async function expectInjectedState(page: Parameters<typeof test.extend>[0] extends never ? never : any): Promise<void> {
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.bwfContent ?? null)).toBe("ready");
    await expect.poll(async () => page.evaluate(() => ({
      injected: document.documentElement.dataset.bwfPageInjected ?? null,
      bridge: document.documentElement.dataset.bwfBridge ?? null,
      page: document.documentElement.dataset.bwfPage ?? null,
      pageError: document.documentElement.dataset.bwfPageError ?? null,
    }))).toEqual({
      injected: "manifest-main-world",
      bridge: "attached",
      page: "ready",
      pageError: null,
    });
  }

  test("rewrites VOD playurl, injects overlay, and serves prefetched segment from cache", async ({ page }) => {
    const segmentCounts = new Map<string, number>();
    const vodDocument = `
      <html>
        <body>
          <video muted autoplay playsinline controls></video>
          <script>
            window.__TEST__ = { done: false };
            (async () => {
              const playurl = await fetch("https://api.bilibili.com/x/player/wbi/playurl?cid=1&bvid=BV1RrLT6HEEm");
              const json = await playurl.json();
              window.__TEST__.playurl = json;
              const base = json.data.dash.video[0].baseUrl;
              await fetch(base);
              await new Promise((resolve) => setTimeout(resolve, 400));
              await fetch(base.replace("video100.m4s", "video101.m4s"));
              document.querySelector("video").dispatchEvent(new Event("waiting"));
              window.__TEST__.done = true;
            })();
          </script>
        </body>
      </html>
    `;

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://www.bilibili.com/video/BV1RrLT6HEEm/") {
        await route.fulfill({ contentType: "text/html", body: vodDocument });
        return;
      }
      if (url.includes("playurl")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              dash: {
                video: [
                  {
                    id: 120,
                    codecs: "av01.0.12M.08",
                    bandwidth: 18_000_000,
                    width: 7680,
                    height: 4320,
                    baseUrl: "https://upos-sz-mirror.bilivideo.com/upgcxcode/00/00/video100.m4s",
                    backupUrl: ["https://cn-sz-bcache-01.bilivideo.com/upgcxcode/00/00/video100.m4s"],
                  },
                  {
                    id: 120,
                    codecs: "avc1.640033",
                    bandwidth: 12_000_000,
                    width: 7680,
                    height: 4320,
                    baseUrl: "https://upos-sz-mirror.bilivideo.com/upgcxcode/00/00/video100.m4s",
                    backupUrl: ["https://cn-sz-bcache-01.bilivideo.com/upgcxcode/00/00/video100.m4s"],
                  },
                ],
                audio: [
                  {
                    id: 30280,
                    codecs: "mp4a.40.2",
                    baseUrl: "https://upos-sz-mirror.bilivideo.com/upgcxcode/00/00/audio100.m4s",
                    backupUrl: ["https://cn-sz-bcache-01.bilivideo.com/upgcxcode/00/00/audio100.m4s"],
                  },
                ],
              },
            },
          }),
        });
        return;
      }
      if (url.endsWith(".m4s")) {
        segmentCounts.set(url, (segmentCounts.get(url) ?? 0) + 1);
        await route.fulfill({
          status: 200,
          headers: { "content-type": "video/iso.segment", "content-length": "2097152" },
          body: Buffer.alloc(1024, 7),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("https://www.bilibili.com/video/BV1RrLT6HEEm/");

    await expectInjectedState(page);
    await expect(page.locator("#bwf-overlay")).toBeVisible();
    await expect.poll(async () => page.evaluate(() => (window as any).__TEST__?.done)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().protocol)).toBe("dash");
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().quality)).toBe(120);
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().codec)).toContain("avc1");
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().lastRecoveryAction)).toBe("rebuild-playback-state");
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/00/00/video101.m4s")).toBe(1);
    await expect.poll(async () => page.evaluate(() => ({
      activeRangeJobs: window.__BWF_DEBUG__?.getStatus().activeRangeJobs,
      prefetchHits: window.__BWF_DEBUG__?.getStatus().prefetchHitCount,
      targetQualitySatisfied: window.__BWF_DEBUG__?.getStatus().targetQualitySatisfied,
    }))).toEqual({
      activeRangeJobs: 0,
      prefetchHits: 1,
      targetQualitySatisfied: true,
    });
  });

  test("rewrites live play info according to stable and low latency preferences", async ({ page }) => {
    const liveDocument = `
      <html>
        <body>
          <video muted autoplay playsinline controls></video>
        </body>
      </html>
    `;

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://live.bilibili.com/9674114") {
        await route.fulfill({ contentType: "text/html", body: liveDocument });
        return;
      }
      if (url.includes("getRoomPlayInfo")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              playurl_info: {
                playurl: {
                  stream: [
                    {
                      protocol_name: "http_hls",
                      format: [
                        {
                          format_name: "fmp4",
                          codec: [
                            {
                              codec_name: "avc",
                              current_qn: 10000,
                              base_url: "/live-bvc/123/index.m3u8",
                              url_info: [{ host: "https://live-play.acgvideo.com", extra: "?qn=10000" }],
                            },
                          ],
                        },
                      ],
                    },
                    {
                      protocol_name: "http_stream",
                      format: [
                        {
                          format_name: "flv",
                          codec: [
                            {
                              codec_name: "avc",
                              current_qn: 10000,
                              base_url: "/live-bvc/123/index.flv",
                              url_info: [{ host: "https://live-play.acgvideo.com", extra: "?qn=10000" }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("https://live.bilibili.com/9674114");

    await expectInjectedState(page);
    await expect(page.locator("#bwf-overlay")).toBeVisible();
    await page.evaluate(async () => {
      await fetch("https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=9674114");
    });
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().protocol)).toContain("fmp4");

    await page.evaluate(() => window.__BWF_DEBUG__?.setMode("lowLatency"));
    await page.evaluate(async () => {
      await fetch("https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=9674114&mode=low");
    });
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().protocol)).toContain("flv");
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().liveBufferTier)).toBe("low");
  });

  test("overlay can be folded and hidden from page controls", async ({ page }) => {
    const documentHtml = `
      <html>
        <body>
          <video muted autoplay playsinline controls></video>
        </body>
      </html>
    `;
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://www.bilibili.com/video/BV1overlay/") {
        await route.fulfill({ contentType: "text/html", body: documentHtml });
        return;
      }
      await route.continue();
    });

    await page.goto("https://www.bilibili.com/video/BV1overlay/");
    await expect(page.locator("#bwf-overlay")).toBeVisible();
    await page.locator("#bwf-overlay button").first().click();
    await expect.poll(async () => page.locator("#bwf-overlay pre").isVisible()).toBe(false);
    await page.locator("#bwf-overlay button").last().click();
    await expect.poll(async () => page.locator("#bwf-overlay").count()).toBe(0);
  });

  test("popup reflects persisted policy and can toggle runtime controls", async ({ page, extensionPage }) => {
    const documentHtml = `
      <html>
        <body>
          <video muted autoplay playsinline controls></video>
        </body>
      </html>
    `;
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://www.bilibili.com/video/BV1settings/") {
        await route.fulfill({ contentType: "text/html", body: documentHtml });
        return;
      }
      await route.continue();
    });

    await page.goto("https://www.bilibili.com/video/BV1settings/");
    const options = await extensionPage("/src/options/index.html");
    await options.getByTestId("vod-range-chunk-size").fill("512");
    await options.getByTestId("vod-seek-boost-window").fill("3");
    await options.getByTestId("vod-aggressive-prefetch-seconds").fill("48");
    await options.getByTestId("vod-range-split").click();

    await expect.poll(async () => options.getByTestId("vod-range-split").isChecked()).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getPolicy().vod.rangeChunkSizeKb)).toBe(512);
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getPolicy().vod.seekBoostWindow)).toBe(3);
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getPolicy().vod.aggressivePrefetchSeconds)).toBe(48);
    const popup = await extensionPage("/src/popup/index.html");
    await expect.poll(async () => popup.locator("text=Range Split").count()).toBe(1);
    await expect.poll(async () => popup.getByTestId("popup-range-split-toggle").isChecked()).toBe(true);
    await popup.getByTestId("popup-range-split-toggle").click();
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getPolicy().vod.experimentalRangeSplit)).toBe(false);
  });

  test("options page can persist experimental range split", async ({ page, extensionPage }) => {
    const documentHtml = `
      <html>
        <body>
          <video muted autoplay playsinline controls></video>
        </body>
      </html>
    `;
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://www.bilibili.com/video/BV1options/") {
        await route.fulfill({ contentType: "text/html", body: documentHtml });
        return;
      }
      await route.continue();
    });

    await page.goto("https://www.bilibili.com/video/BV1options/");
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getPolicy().vod.experimentalRangeSplit)).toBe(false);

    const options = await extensionPage("/src/options/index.html");
    await expect.poll(async () => options.getByTestId("vod-range-split").isChecked()).toBe(false);
    await options.getByTestId("vod-range-split").click();

    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getPolicy().vod.experimentalRangeSplit)).toBe(true);
    await expect.poll(async () => options.getByTestId("vod-range-split").isChecked()).toBe(true);
  });

  test("reload detaches old page bridge without console spam", async ({ context, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://www.bilibili.com/video/BV1reload/") {
        await route.fulfill({
          contentType: "text/html",
          body: "<html><body><video muted autoplay playsinline controls></video></body></html>",
        });
        return;
      }
      await route.continue();
    });

    await page.goto("https://www.bilibili.com/video/BV1reload/");
    await expectInjectedState(page);

    const serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await serviceWorker.evaluate(() => {
      chrome.runtime.reload();
    });

    await page.evaluate(() => {
      window.__BWF_DEBUG__?.setMode("stable");
    });
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.bwfBridge ?? null)).toBe("detached");
    expect(errors.filter((message) => /Extension context invalidated|Could not establish connection|Receiving end does not exist/i.test(message))).toEqual([]);

  });
});

test.describe("extension real bilibili smoke", () => {
  test("loads VOD page and injects overlay @real", async ({ page }) => {
    await page.goto("https://www.bilibili.com/video/BV1RrLT6HEEm/", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.bwfContent ?? null)).toBe("ready");
    await expect.poll(async () => page.evaluate(() => ({
      injected: document.documentElement.dataset.bwfPageInjected ?? null,
      bridge: document.documentElement.dataset.bwfBridge ?? null,
      page: document.documentElement.dataset.bwfPage ?? null,
      pageError: document.documentElement.dataset.bwfPageError ?? null,
    }))).toEqual({
      injected: "manifest-main-world",
      bridge: "attached",
      page: "ready",
      pageError: null,
    });
    await expect.poll(async () => page.locator("#bwf-overlay").count()).toBeGreaterThan(0);
    await expect.poll(async () => page.evaluate(() => Boolean(window.__BWF_DEBUG__))).toBe(true);
  });

  test("loads live page and injects overlay @real", async ({ page }) => {
    await page.goto("https://live.bilibili.com/9674114", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.bwfContent ?? null)).toBe("ready");
    await expect.poll(async () => page.evaluate(() => ({
      injected: document.documentElement.dataset.bwfPageInjected ?? null,
      bridge: document.documentElement.dataset.bwfBridge ?? null,
      page: document.documentElement.dataset.bwfPage ?? null,
      pageError: document.documentElement.dataset.bwfPageError ?? null,
    }))).toEqual({
      injected: "manifest-main-world",
      bridge: "attached",
      page: "ready",
      pageError: null,
    });
    await expect.poll(async () => page.locator("#bwf-overlay").count()).toBeGreaterThan(0);
    await expect.poll(async () => page.evaluate(() => Boolean(window.__BWF_DEBUG__))).toBe(true);
  });
});
