import { describe, expect, it } from "vitest";
import { buildStatus } from "../../shared/telemetry/diagnostics";
import type { TelemetryEvent } from "../../shared/types";

describe("buildStatus", () => {
  it("marks network-bound when buffer is low and waiting exists", () => {
    const events: TelemetryEvent[] = [
      {
        type: "playback",
        event: "waiting",
        ts: Date.now(),
        url: "https://www.bilibili.com/video/foo",
        pageKind: "vod",
        bufferedSeconds: 0.5,
      },
    ];
    const status = buildStatus(
      {
        pageKind: "vod",
        mode: "stable",
        bufferedSeconds: 0.4,
        droppedFrames: 0,
      },
      events,
    );
    expect(status.networkBoundLikely).toBe(true);
    expect(status.decodeBoundLikely).toBe(false);
  });

  it("marks decode-bound when buffer is healthy but dropped frames are high", () => {
    const status = buildStatus(
      {
        pageKind: "vod",
        mode: "stable",
        bufferedSeconds: 4,
        droppedFrames: 30,
      },
      [],
    );
    expect(status.decodeBoundLikely).toBe(true);
  });

  it("fills extended playback diagnostics with defaults", () => {
    const status = buildStatus(
      {
        pageKind: "live",
        mode: "stable",
        bufferedSeconds: 8,
        targetQualitySatisfied: true,
      },
      [],
    );
    expect(status.activeRangeJobs).toBe(0);
    expect(status.rangeSplitActive).toBe(false);
    expect(status.prefetchHitCount).toBe(0);
    expect(status.rangeChunkRetryCount).toBe(0);
    expect(status.lastSeekRecoveryMs).toBe(null);
    expect(status.lastSeekTargetBuffered).toBe(true);
    expect(status.seekInProgress).toBe(false);
    expect(status.targetQualitySatisfied).toBe(true);
    expect(status.hostHealthSummary).toBe("");
    expect(status.liveBufferTier).toBe("target");
  });
});
