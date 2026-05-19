import { describe, expect, it } from "vitest";
import { selectRecoveryAction } from "../../shared/policy/recovery";

describe("selectRecoveryAction", () => {
  it("rebuilds playback state for low-buffer VOD without switching host", () => {
    const action = selectRecoveryAction({
      pageKind: "vod",
      mode: "stable",
      bufferedSeconds: 0.4,
      droppedFrames: 0,
      backupHostsAvailable: true,
      enableProtocolFallback: true,
      hostFailures: 0,
      repeatedStalls: 1,
    });

    expect(action).toBe("rebuild-playback-state");
  });

  it("switches live protocol after repeated stalls", () => {
    const action = selectRecoveryAction({
      pageKind: "live",
      mode: "stable",
      bufferedSeconds: 2,
      droppedFrames: 0,
      backupHostsAvailable: false,
      enableProtocolFallback: true,
      hostFailures: 0,
      repeatedStalls: 3,
    });

    expect(action).toBe("switch-live-protocol");
  });

  it("marks decode pressure as stable codec fallback", () => {
    const action = selectRecoveryAction({
      pageKind: "vod",
      mode: "stable",
      bufferedSeconds: 6,
      droppedFrames: 24,
      backupHostsAvailable: false,
      enableProtocolFallback: false,
      hostFailures: 0,
      repeatedStalls: 0,
    });

    expect(action).toBe("prefer-stable-codec");
  });
});
