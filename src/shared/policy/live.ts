import type { PlaybackMode } from "../types";

export interface LiveCodecCandidate {
  protocolName: string;
  formatName: string;
  codecName: string;
}

export interface LivePlaylistItem {
  url: string;
  kind: "playlist" | "media";
  durationSeconds: number | null;
}

const MB = 1024 * 1024;

export function sortLiveCandidates(
  mode: PlaybackMode,
  candidates: LiveCodecCandidate[],
): LiveCodecCandidate[] {
  const stableOrder = ["fmp4", "flv", "ts"];
  const lowLatencyOrder = ["flv", "fmp4", "ts"];
  const chosen = mode === "lowLatency" ? lowLatencyOrder : stableOrder;

  return [...candidates].sort((a, b) => {
    const ap = priority(a.formatName, chosen);
    const bp = priority(b.formatName, chosen);
    if (ap !== bp) {
      return ap - bp;
    }
    return codecScore(b.codecName) - codecScore(a.codecName);
  });
}

function priority(name: string, order: string[]): number {
  const idx = order.findIndex((item) => item === name);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function codecScore(codecName: string): number {
  const lower = codecName.toLowerCase();
  if (lower.includes("avc")) return 3;
  if (lower.includes("hevc") || lower.includes("hev")) return 2;
  if (lower.includes("av1")) return 1;
  return 0;
}

export function parseLivePlaylistItems(baseUrl: string, text: string): LivePlaylistItem[] {
  const results: LivePlaylistItem[] = [];
  let pendingDuration: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const extinf = trimmed.match(/^#EXTINF:([0-9.]+)/i);
    if (extinf?.[1]) {
      const duration = Number(extinf[1]);
      pendingDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
      continue;
    }

    if (trimmed.startsWith("#")) {
      const mapMatch = trimmed.match(/URI="([^"]+)"/);
      if (mapMatch?.[1]) {
        const tagName = trimmed.slice(1).split(":", 1)[0]?.toUpperCase() ?? "";
        const uriUrl = new URL(mapMatch[1], baseUrl).toString();
        if (tagName === "EXT-X-MAP") {
          results.push({
            url: uriUrl,
            kind: "media",
            durationSeconds: null,
          });
        } else if (tagName === "EXT-X-MEDIA" || tagName === "EXT-X-I-FRAME-STREAM-INF") {
          results.push({
            url: uriUrl,
            kind: /\.m3u8(\?|$)/.test(uriUrl) ? "playlist" : "media",
            durationSeconds: null,
          });
        }
      }
      continue;
    }

    const url = new URL(trimmed, baseUrl).toString();
    results.push({
      url,
      kind: /\.m3u8(\?|$)/.test(url) ? "playlist" : "media",
      durationSeconds: pendingDuration,
    });
    pendingDuration = null;
  }

  return results;
}

export function resolveLivePrefetchWindow(input: {
  totalSegments: number;
  bufferedSeconds: number;
  targetBufferSeconds: number;
  avgSegmentSeconds: number | null;
}): number {
  if (input.totalSegments <= 0) {
    return 0;
  }
  const target = Math.max(3, input.targetBufferSeconds);
  const avgSegmentSeconds = Math.max(0.5, input.avgSegmentSeconds ?? 2);
  const desired = Math.ceil(target / avgSegmentSeconds);
  if (input.bufferedSeconds < 1.5) {
    return Math.min(input.totalSegments, Math.max(4, desired * 2));
  }
  const headroom = input.bufferedSeconds < target ? Math.ceil(desired * 0.5) : 1;
  return Math.min(input.totalSegments, Math.max(3, desired + headroom));
}

export function resolveLiveCacheTargetBytes(input: {
  targetBufferSeconds: number;
  avgSegmentSeconds: number | null;
  recentBytesPerRequest: number;
  quality: number | null;
}): number {
  const targetSeconds = Math.max(3, input.targetBufferSeconds);
  const avgSegmentSeconds = Math.max(0.5, input.avgSegmentSeconds ?? 2);
  const measuredBytesPerSecond =
    input.recentBytesPerRequest > 0 ? input.recentBytesPerRequest / avgSegmentSeconds : 0;
  const fallbackBps = (input.quality ?? 0) >= 10000 ? 50_000_000 : 12_000_000;
  const bytesPerSecond = measuredBytesPerSecond > 0 ? measuredBytesPerSecond : fallbackBps / 8;
  const targetBytes = Math.round(bytesPerSecond * targetSeconds * 1.6);
  const minBytes = (input.quality ?? 0) >= 10000 ? 64 * MB : 32 * MB;
  const maxBytes = (input.quality ?? 0) >= 10000 ? 384 * MB : 192 * MB;
  return clampBytes(targetBytes, minBytes, maxBytes);
}

function clampBytes(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
