import type { PlaybackMode } from "../types";

export interface LiveCodecCandidate {
  protocolName: string;
  formatName: string;
  codecName: string;
}

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
