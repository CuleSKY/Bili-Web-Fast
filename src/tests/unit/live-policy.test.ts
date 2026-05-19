import { describe, expect, it } from "vitest";
import {
  parseLivePlaylistItems,
  resolveLiveCacheTargetBytes,
  resolveLivePrefetchWindow,
  sortLiveCandidates,
} from "../../shared/policy/live";

describe("sortLiveCandidates", () => {
  const candidates = [
    { protocolName: "http_stream", formatName: "flv", codecName: "avc" },
    { protocolName: "http_hls", formatName: "fmp4", codecName: "avc" },
    { protocolName: "http_hls", formatName: "ts", codecName: "avc" },
  ];

  it("prefers fmp4 in stable mode", () => {
    const ranked = sortLiveCandidates("stable", candidates);
    expect(ranked[0]?.formatName).toBe("fmp4");
  });

  it("prefers flv in low latency mode", () => {
    const ranked = sortLiveCandidates("lowLatency", candidates);
    expect(ranked[0]?.formatName).toBe("flv");
  });

  it("classifies nested playlists separately from media segments", () => {
    const items = parseLivePlaylistItems("https://live.example.com/master/index.m3u8", [
      "#EXTM3U",
      "chunklist/index_0.m3u8",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"main\",URI=\"audio/index.m3u8\"",
      "#EXTINF:1.8,",
      "segment0001.m4s",
    ].join("\n"));

    expect(items).toEqual([
      {
        url: "https://live.example.com/master/chunklist/index_0.m3u8",
        kind: "playlist",
        durationSeconds: null,
      },
      {
        url: "https://live.example.com/master/init.mp4",
        kind: "media",
        durationSeconds: null,
      },
      {
        url: "https://live.example.com/master/audio/index.m3u8",
        kind: "playlist",
        durationSeconds: null,
      },
      {
        url: "https://live.example.com/master/segment0001.m4s",
        kind: "media",
        durationSeconds: 1.8,
      },
    ]);
  });

  it("uses media duration rather than a fixed tiny segment cap for live prefetch", () => {
    const window = resolveLivePrefetchWindow({
      totalSegments: 240,
      bufferedSeconds: 2,
      targetBufferSeconds: 12,
      avgSegmentSeconds: 1,
    });

    expect(window).toBeGreaterThan(8);
    expect(window).toBeLessThan(240);
  });

  it("bounds high-bitrate live cache independently of the VOD byte target", () => {
    const target = resolveLiveCacheTargetBytes({
      targetBufferSeconds: 8,
      avgSegmentSeconds: 1,
      recentBytesPerRequest: 6_250_000,
      quality: 10000,
    });

    expect(target).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(target).toBeLessThanOrEqual(384 * 1024 * 1024);
  });
});
