import { describe, expect, it } from "vitest";
import { rankCodecPreference } from "../../shared/policy/codec";

describe("rankCodecPreference", () => {
  const candidates = [
    { id: 120, codecs: "av01.0.12M.08", bandwidth: 18_000_000 },
    { id: 120, codecs: "hev1.1.6.L153.B0", bandwidth: 16_000_000 },
    { id: 120, codecs: "avc1.640033", bandwidth: 12_000_000 },
  ];

  it("prefers avc in auto mode for stability", () => {
    const ranked = rankCodecPreference(candidates, "auto");
    expect(ranked[0]?.codecs).toContain("avc1");
  });

  it("prefers av1 when forced", () => {
    const ranked = rankCodecPreference(candidates, "av1");
    expect(ranked[0]?.codecs).toContain("av01");
  });
});
