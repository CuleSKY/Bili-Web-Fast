import type { PageStatus, TelemetryEvent } from "../types";
import { cutoff } from "../utils/time";

export function buildStatus(
  partial: Partial<PageStatus>,
  recentTelemetry: TelemetryEvent[],
): PageStatus {
  const recent = cutoff(recentTelemetry, 60_000);
  const waitingCount1m = recent.filter(
    (event) => event.type === "playback" && event.event === "waiting",
  ).length;
  const stalledCount1m = recent.filter(
    (event) => event.type === "playback" && event.event === "stalled",
  ).length;

  return {
    pageKind: partial.pageKind ?? "unknown",
    mode: partial.mode ?? "stable",
    downloadPhase: partial.downloadPhase ?? "steady",
    quality: partial.quality ?? null,
    codec: partial.codec ?? null,
    host: partial.host ?? null,
    protocol: partial.protocol ?? null,
    bufferedSeconds: partial.bufferedSeconds ?? 0,
    targetBufferSeconds: partial.targetBufferSeconds ?? 0,
    avgSegmentDurationMs: partial.avgSegmentDurationMs ?? 0,
    avgVodSegmentSeconds: partial.avgVodSegmentSeconds ?? 4,
    prefetchQueueDepth: partial.prefetchQueueDepth ?? 0,
    cacheBytes: partial.cacheBytes ?? 0,
    controllerConcurrency: partial.controllerConcurrency ?? 0,
    recentThroughputMbps: partial.recentThroughputMbps ?? 0,
    activeSegmentDownloads: partial.activeSegmentDownloads ?? 0,
    activeRangeJobs: partial.activeRangeJobs ?? 0,
    rangeSplitActive: partial.rangeSplitActive ?? false,
    prefetchHitCount: partial.prefetchHitCount ?? 0,
    rangeChunkRetryCount: partial.rangeChunkRetryCount ?? 0,
    waitingCount1m,
    stalledCount1m,
    droppedFrames: partial.droppedFrames ?? 0,
    lastRecoveryReason: partial.lastRecoveryReason ?? null,
    lastRecoveryAction: partial.lastRecoveryAction ?? null,
    lastSeekRecoveryMs: partial.lastSeekRecoveryMs ?? null,
    lastSeekTargetBuffered: partial.lastSeekTargetBuffered ?? true,
    seekInProgress: partial.seekInProgress ?? false,
    targetQualitySatisfied: partial.targetQualitySatisfied ?? false,
    activeMediaHost: partial.activeMediaHost ?? partial.host ?? null,
    hostHealthSummary: partial.hostHealthSummary ?? "",
    liveBufferTier: partial.liveBufferTier ?? "target",
    networkBoundLikely:
      (partial.bufferedSeconds ?? 0) < 1.5 && (waitingCount1m > 0 || stalledCount1m > 0),
    decodeBoundLikely:
      (partial.bufferedSeconds ?? 0) > 3 && (partial.droppedFrames ?? 0) > 10,
  };
}
