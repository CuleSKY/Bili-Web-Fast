import type { CodecPreference } from "../types";

export interface CodecCandidate {
  id: number;
  codecs: string;
  bandwidth?: number;
  width?: number;
  height?: number;
}

export function rankCodecPreference(
  candidates: CodecCandidate[],
  preference: CodecPreference,
): CodecCandidate[] {
  const order = preference === "auto"
    ? ["avc", "hev", "hvc", "av01"]
    : preference === "avc"
      ? ["avc", "hev", "hvc", "av01"]
      : preference === "hevc"
        ? ["hev", "hvc", "avc", "av01"]
        : ["av01", "avc", "hev", "hvc"];

  return [...candidates].sort((a, b) => {
    const ai = codecPriority(a.codecs, order);
    const bi = codecPriority(b.codecs, order);
    if (ai !== bi) {
      return ai - bi;
    }
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  });
}

function codecPriority(codecs: string, order: string[]): number {
  const lower = codecs.toLowerCase();
  const idx = order.findIndex((item) => lower.includes(item));
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}
