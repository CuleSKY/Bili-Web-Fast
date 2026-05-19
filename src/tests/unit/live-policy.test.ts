import { describe, expect, it } from "vitest";
import { sortLiveCandidates } from "../../shared/policy/live";

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
});
