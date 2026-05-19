import { describe, expect, it } from "vitest";
import { resolvePrefetchDecision } from "../../shared/policy/prefetch";

describe("resolvePrefetchDecision", () => {
  it("keeps a fixed 48 second future window and boosts initial loading", () => {
    const decision = resolvePrefetchDecision({
      preferredWindow: 12,
      aggressivePrefetchSeconds: 48,
      maxConcurrentRequests: 12,
      quality: 1080,
      estimatedBitrate: 6_000_000,
      avgSegmentDurationMs: 4_000,
      phase: "initial",
    });

    expect(decision.videoWindow).toBe(15);
    expect(decision.audioWindow).toBe(15);
    expect(decision.totalConcurrency).toBe(14);
    expect(decision.targetSeconds).toBe(48);
    expect(decision.cacheLimitBytes).toBeGreaterThanOrEqual(128 * 1024 * 1024);
    expect(decision.highBitrateMode).toBe(false);
  });

  it("fetches all remaining resources when less than 48 seconds remain", () => {
    const decision = resolvePrefetchDecision({
      preferredWindow: 12,
      aggressivePrefetchSeconds: 48,
      maxConcurrentRequests: 12,
      quality: 1080,
      estimatedBitrate: 6_000_000,
      avgSegmentDurationMs: 4_000,
      remainingSeconds: 20,
      phase: "steady",
    });

    expect(decision.videoWindow).toBe(5);
    expect(decision.audioWindow).toBe(5);
    expect(decision.targetSeconds).toBe(20);
    expect(decision.highBitrateMode).toBe(false);
  });

  it("boosts seek concurrency for high bitrate video", () => {
    const decision = resolvePrefetchDecision({
      preferredWindow: 12,
      aggressivePrefetchSeconds: 48,
      maxConcurrentRequests: 12,
      quality: 4320,
      estimatedBitrate: 18_000_000,
      avgSegmentDurationMs: 4_000,
      phase: "seek",
    });

    expect(decision.videoWindow).toBe(18);
    expect(decision.audioWindow).toBe(18);
    expect(decision.totalConcurrency).toBe(16);
    expect(decision.targetSeconds).toBe(48);
    expect(decision.cacheLimitBytes).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(decision.highBitrateMode).toBe(true);
  });
});
