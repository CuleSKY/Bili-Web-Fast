import { describe, expect, it } from "vitest";
import { resolveDownloadController } from "../../shared/policy/download-controller";

describe("resolveDownloadController", () => {
  it("raises concurrency when throughput climbs and errors stay low", () => {
    const decision = resolveDownloadController({
      phase: "initial",
      minConcurrency: 10,
      maxConcurrency: 20,
      currentConcurrency: 14,
      previousThroughputBps: 10_000_000,
      recentThroughputBps: 11_000_000,
      recentErrorRate: 0.01,
      queueDepth: 12,
      lowGainStreak: 0,
      bufferedSeconds: 6,
      targetBufferSeconds: 48,
      seekUrgent: false,
      liveUrgent: false,
      cacheSatisfied: false,
    });

    expect(decision.nextConcurrency).toBe(16);
    expect(decision.nextLowGainStreak).toBe(0);
  });

  it("lowers concurrency when error rate rises", () => {
    const decision = resolveDownloadController({
      phase: "steady",
      minConcurrency: 8,
      maxConcurrency: 16,
      currentConcurrency: 12,
      previousThroughputBps: 8_000_000,
      recentThroughputBps: 8_100_000,
      recentErrorRate: 0.06,
      queueDepth: 8,
      lowGainStreak: 0,
      bufferedSeconds: 20,
      targetBufferSeconds: 48,
      seekUrgent: false,
      liveUrgent: false,
      cacheSatisfied: false,
    });

    expect(decision.nextConcurrency).toBe(10);
  });

  it("pins concurrency to the phase ceiling during urgent seek", () => {
    const decision = resolveDownloadController({
      phase: "seek",
      minConcurrency: 12,
      maxConcurrency: 24,
      currentConcurrency: 18,
      previousThroughputBps: 12_000_000,
      recentThroughputBps: 11_000_000,
      recentErrorRate: 0.02,
      queueDepth: 20,
      lowGainStreak: 1,
      bufferedSeconds: 0.4,
      targetBufferSeconds: 48,
      seekUrgent: true,
      liveUrgent: false,
      cacheSatisfied: false,
    });

    expect(decision.nextConcurrency).toBe(24);
    expect(decision.nextLowGainStreak).toBe(0);
  });
});
