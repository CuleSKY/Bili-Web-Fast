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

  test("rewrites VOD playurl, injects overlay, and keeps HEAD or Range fetches out of streaming side effects", async ({ page }) => {
    const segmentCounts = new Map<string, number>();
    const headCounts = new Map<string, number>();
    const rangeCounts = new Map<string, number>();
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
              const next1 = base.replace("video100.m4s", "video101.m4s");
              const next2 = base.replace("video100.m4s", "video102.m4s");
              const next3 = base.replace("video100.m4s", "video103.m4s");
              const headProbe = "https://upos-sz-mirror.bilivideo.com/upgcxcode/probe/head-only.m4s";
              const rangeProbe = "https://upos-sz-mirror.bilivideo.com/upgcxcode/probe/range-only.m4s";
              await fetch(base);
              await new Promise((resolve) => setTimeout(resolve, 600));
              window.__TEST__.headStatus = (await fetch(headProbe, { method: "HEAD" })).status;
              await fetch(next1);
              await new Promise((resolve) => setTimeout(resolve, 600));
              window.__TEST__.rangeStatus = (await fetch(new Request(rangeProbe, { headers: { range: "bytes=0-99" } }))).status;
              await fetch(next2);
              await new Promise((resolve) => setTimeout(resolve, 600));
              await fetch(next3);
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
        if (route.request().method() === "HEAD") {
          headCounts.set(url, (headCounts.get(url) ?? 0) + 1);
          await route.fulfill({
            status: 200,
            headers: { "content-type": "video/iso.segment", "content-length": "2097152" },
            body: "",
          });
          return;
        }
        const range = route.request().headers().range;
        if (range) {
          rangeCounts.set(url, (rangeCounts.get(url) ?? 0) + 1);
          await route.fulfill({
            status: 206,
            headers: {
              "content-type": "video/iso.segment",
              "content-length": "100",
              "content-range": "bytes 0-99/2097152",
              "accept-ranges": "bytes",
            },
            body: Buffer.alloc(100, 9),
          });
          return;
        }
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
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/00/00/video100.m4s")).toBe(1);
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/00/00/video101.m4s")).toBe(1);
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/00/00/video102.m4s")).toBe(1);
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/00/00/video103.m4s")).toBe(1);
    expect(headCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/probe/head-only.m4s")).toBeGreaterThanOrEqual(1);
    expect(rangeCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/probe/range-only.m4s")).toBeGreaterThanOrEqual(1);
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/probe/head-only.m4s") ?? 0).toBe(0);
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/probe/range-only.m4s") ?? 0).toBe(0);
    await expect.poll(async () => page.evaluate(() => ({
      headStatus: (window as any).__TEST__?.headStatus,
      rangeStatus: (window as any).__TEST__?.rangeStatus,
    }))).toEqual({
      headStatus: 200,
      rangeStatus: 206,
    });
    await expect.poll(async () => page.evaluate(() => ({
      activeRangeJobs: window.__BWF_DEBUG__?.getStatus().activeRangeJobs,
      prefetchHits: window.__BWF_DEBUG__?.getStatus().prefetchHitCount,
      targetQualitySatisfied: window.__BWF_DEBUG__?.getStatus().targetQualitySatisfied,
    }))).toMatchObject({
      activeRangeJobs: 0,
      targetQualitySatisfied: true,
    });
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().prefetchHitCount ?? 0)).toBeGreaterThanOrEqual(3);
  });

  test("keeps VOD page visibility exposed as visible to page scripts", async ({ page }) => {
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://www.bilibili.com/video/BV1visible/") {
        await route.fulfill({
          contentType: "text/html",
          body: "<html><body><video muted autoplay playsinline controls></video></body></html>",
        });
        return;
      }
      await route.continue();
    });

    await page.goto("https://www.bilibili.com/video/BV1visible/");
    await expectInjectedState(page);
    await expect.poll(async () => page.evaluate(() => ({
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      webkitHidden: (document as Document & { webkitHidden?: boolean }).webkitHidden,
    }))).toEqual({
      hidden: false,
      visibilityState: "visible",
      webkitHidden: false,
    });
  });

  test("continues VOD prefetch while hidden without another page media fetch", async ({ page }) => {
    const segmentCounts = new Map<string, number>();
    const vodDocument = `
      <html>
        <body>
          <video muted autoplay playsinline controls></video>
        </body>
      </html>
    `;

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://www.bilibili.com/video/BV1hidden/") {
        await route.fulfill({ contentType: "text/html", body: vodDocument });
        return;
      }
      if (url.includes("playurl")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              timelength: 600_000,
              dash: {
                video: [
                  {
                    id: 120,
                    codecs: "avc1.640033",
                    bandwidth: 8_000_000,
                    width: 3840,
                    height: 2160,
                    baseUrl: "https://upos-sz-mirror.bilivideo.com/upgcxcode/bg/video100.m4s",
                  },
                ],
                audio: [
                  {
                    id: 30280,
                    codecs: "mp4a.40.2",
                    baseUrl: "https://upos-sz-mirror.bilivideo.com/upgcxcode/bg/audio100.m4s",
                  },
                ],
              },
            },
          }),
        });
        return;
      }
      if (url.endsWith(".m4s")) {
        if (route.request().method() === "HEAD") {
          await route.fulfill({
            status: 200,
            headers: { "content-type": "video/iso.segment", "content-length": "1048576" },
            body: "",
          });
          return;
        }
        segmentCounts.set(url, (segmentCounts.get(url) ?? 0) + 1);
        await route.fulfill({
          status: 200,
          headers: { "content-type": "video/iso.segment", "content-length": "1048576" },
          body: Buffer.alloc(2048, 3),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("https://www.bilibili.com/video/BV1hidden/");
    await expectInjectedState(page);
    await page.evaluate(() => window.__BWF_DEBUG__?.setMode("off"));
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().mode)).toBe("off");
    await page.evaluate(async () => {
      const playurl = await fetch("https://api.bilibili.com/x/player/wbi/playurl?cid=2&bvid=BV1hidden");
      const json = await playurl.json();
      await fetch(json.data.dash.video[0].baseUrl);
    });

    expect([...segmentCounts.values()].reduce((sum, value) => sum + value, 0)).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(1200);
    expect([...segmentCounts.values()].reduce((sum, value) => sum + value, 0)).toBe(1);

    await page.evaluate(() => window.__BWF_DEBUG__?.setMode("stable"));
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().mode)).toBe("stable");
    await expect.poll(async () => [...segmentCounts.values()].reduce((sum, value) => sum + value, 0)).toBeGreaterThan(1);
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/bg/video101.m4s") ?? 0).toBeGreaterThan(0);
    expect(segmentCounts.get("https://upos-sz-mirror.bilivideo.com/upgcxcode/bg/audio100.m4s") ?? 0).toBeGreaterThan(0);
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().cacheBytes ?? 0)).toBeGreaterThan(0);
  });

  test("keeps unresolved seek out of aggressive recovery and does not reuse stale seek targets", async ({ page }) => {
    const documentHtml = `
      <html>
        <body>
          <video muted autoplay playsinline controls></video>
          <script>
            window.__SEEK_TEST__ = { rangeStart: 0, rangeEnd: 10 };
            const video = document.querySelector("video");
            Object.defineProperty(video, "buffered", {
              configurable: true,
              get() {
                return {
                  length: 1,
                  start: () => window.__SEEK_TEST__.rangeStart,
                  end: () => window.__SEEK_TEST__.rangeEnd,
                };
              },
            });
          </script>
        </body>
      </html>
    `;

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://www.bilibili.com/video/BV1seek/") {
        await route.fulfill({ contentType: "text/html", body: documentHtml });
        return;
      }
      await route.continue();
    });

    await page.goto("https://www.bilibili.com/video/BV1seek/");
    await expectInjectedState(page);

    await page.evaluate(() => {
      const video = document.querySelector("video")!;
      video.currentTime = 60;
      video.dispatchEvent(new Event("seeking"));
      video.dispatchEvent(new Event("waiting"));
      video.dispatchEvent(new Event("stalled"));
    });

    await expect.poll(async () => page.evaluate(() => ({
      seekInProgress: window.__BWF_DEBUG__?.getStatus().seekInProgress,
      lastRecoveryAction: window.__BWF_DEBUG__?.getStatus().lastRecoveryAction,
    }))).toEqual({
      seekInProgress: true,
      lastRecoveryAction: null,
    });

    await page.evaluate(() => {
      (window as any).__SEEK_TEST__.rangeStart = 59;
      (window as any).__SEEK_TEST__.rangeEnd = 70;
      const video = document.querySelector("video")!;
      video.dispatchEvent(new Event("seeked"));
    });

    await page.waitForTimeout(900);

    await page.evaluate(() => {
      const video = document.querySelector("video")!;
      video.currentTime = 1;
      video.dispatchEvent(new Event("waiting"));
    });

    await expect.poll(async () => page.evaluate(() => ({
      seekInProgress: window.__BWF_DEBUG__?.getStatus().seekInProgress,
      lastRecoveryAction: window.__BWF_DEBUG__?.getStatus().lastRecoveryAction,
      currentTime: Math.round(document.querySelector("video")!.currentTime),
    }))).toEqual({
      seekInProgress: false,
      lastRecoveryAction: "rebuild-playback-state",
      currentTime: 1,
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

  test("continues live nested playlist prefetch through cached playlist hits and refreshes the leaf playlist", async ({ page }) => {
    const requestCounts = new Map<string, number>();
    const liveDocument = `
      <html>
        <body>
          <video muted autoplay playsinline controls></video>
        </body>
      </html>
    `;

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() === "document" && url === "https://live.bilibili.com/9674115") {
        await route.fulfill({ contentType: "text/html", body: liveDocument });
        return;
      }
      if (url.endsWith(".m3u8")) {
        requestCounts.set(url, (requestCounts.get(url) ?? 0) + 1);
        await route.fulfill({
          contentType: "application/vnd.apple.mpegurl",
          body: url.endsWith("master.m3u8")
            ? ["#EXTM3U", "level1.m3u8"].join("\n")
            : ["#EXTM3U", "#EXT-X-MAP:URI=\"init.mp4\"", "#EXTINF:1.0,", "seg0001.m4s", "#EXTINF:1.0,", "seg0002.m4s"].join("\n"),
        });
        return;
      }
      if (url.endsWith(".mp4") || url.endsWith(".m4s")) {
        requestCounts.set(url, (requestCounts.get(url) ?? 0) + 1);
        await route.fulfill({
          status: 200,
          headers: { "content-type": "video/iso.segment", "content-length": "1048576" },
          body: Buffer.alloc(1024, 4),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("https://live.bilibili.com/9674115");
    await expectInjectedState(page);
    await page.evaluate(async () => {
      await fetch("https://live-play.acgvideo.com/live/master.m3u8");
    });
    await expect.poll(async () => requestCounts.get("https://live-play.acgvideo.com/live/level1.m3u8") ?? 0).toBe(1);
    await expect.poll(async () => requestCounts.get("https://live-play.acgvideo.com/live/seg0002.m4s") ?? 0).toBe(1);
    const playlistRequestsBeforeCacheHit = requestCounts.get("https://live-play.acgvideo.com/live/level1.m3u8") ?? 0;
    await page.evaluate(async () => {
      await fetch("https://live-play.acgvideo.com/live/level1.m3u8");
    });
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().prefetchHitCount)).toBeGreaterThan(0);

    expect(requestCounts.get("https://live-play.acgvideo.com/live/level1.m3u8")).toBe(playlistRequestsBeforeCacheHit);
    expect(requestCounts.get("https://live-play.acgvideo.com/live/init.mp4")).toBe(1);
    expect(requestCounts.get("https://live-play.acgvideo.com/live/seg0001.m4s")).toBe(1);
    expect(requestCounts.get("https://live-play.acgvideo.com/live/seg0002.m4s")).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    });
    await page.evaluate(async () => {
      await window.__BWF_DEBUG__?.setMode("stable");
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    await expect.poll(async () => requestCounts.get("https://live-play.acgvideo.com/live/level1.m3u8") ?? 0).toBeGreaterThan(playlistRequestsBeforeCacheHit);
    expect(requestCounts.get("https://live-play.acgvideo.com/live/master.m3u8")).toBe(1);
    await page.evaluate(async () => {
      await fetch("https://live-play.acgvideo.com/live/master.m3u8");
    });
    await expect.poll(async () => requestCounts.get("https://live-play.acgvideo.com/live/master.m3u8") ?? 0).toBeGreaterThan(1);
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().prefetchHitCount)).toBeGreaterThan(0);
    await expect.poll(async () => page.evaluate(() => window.__BWF_DEBUG__?.getStatus().cacheBytes ?? 0)).toBeLessThan(384 * 1024 * 1024);
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
