import type { PageKind, PlaybackMode } from "../types";

export interface RecoveryDecisionInput {
  pageKind: PageKind;
  mode: PlaybackMode;
  bufferedSeconds: number;
  droppedFrames: number;
  backupHostsAvailable: boolean;
  enableProtocolFallback: boolean;
  hostFailures: number;
  repeatedStalls: number;
}

export function selectRecoveryAction(input: RecoveryDecisionInput): string {
  if (input.mode === "off") {
    return "noop";
  }
  if (input.bufferedSeconds < 1.25) {
    return input.pageKind === "live" ? "rebuild-live-player" : "rebuild-playback-state";
  }
  if (input.pageKind === "live" && input.enableProtocolFallback && input.repeatedStalls >= 2) {
    return "switch-live-protocol";
  }
  if (input.droppedFrames >= 12) {
    return "prefer-stable-codec";
  }
  if (input.hostFailures >= 2) {
    return "drop-quality";
  }
  return input.pageKind === "live" ? "rebuild-live-player" : "rebuild-playback-state";
}
