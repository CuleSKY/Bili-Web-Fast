export interface PrefetchDecisionInput {
  preferredWindow: number;
  aggressivePrefetchSeconds: number;
  maxConcurrentRequests: number;
  quality: number | null;
  estimatedBitrate: number | null;
  avgSegmentDurationMs?: number | null;
  phase?: "initial" | "steady" | "seek";
  remainingSeconds?: number | null;
}

export interface PrefetchDecision {
  videoWindow: number;
  audioWindow: number;
  totalConcurrency: number;
  cacheLimitBytes: number;
  targetSeconds: number;
  highBitrateMode: boolean;
}

const MB = 1024 * 1024;

export function resolvePrefetchDecision(input: PrefetchDecisionInput): PrefetchDecision {
  const highBitrateMode =
    (input.quality ?? 0) >= 1440 || (input.estimatedBitrate ?? 0) >= 8_000_000;

  const phase = input.phase ?? "steady";
  const baseWindow = clamp(input.preferredWindow, 4, 24);
  const configuredTargetSeconds = clamp(input.aggressivePrefetchSeconds, 48, 48);
  const remainingSeconds = Number.isFinite(input.remainingSeconds ?? NaN)
    ? Math.max(0, input.remainingSeconds ?? 0)
    : null;
  const targetSeconds =
    remainingSeconds != null && remainingSeconds > 0
      ? Math.min(configuredTargetSeconds, remainingSeconds)
      : configuredTargetSeconds;
  const cacheEntireRemaining = remainingSeconds != null && remainingSeconds <= configuredTargetSeconds;
  const avgSegmentSeconds = Math.max(1, (input.avgSegmentDurationMs ?? 4000) / 1000);
  const futureSegments = Math.max(1, Math.ceil(targetSeconds / avgSegmentSeconds));
  const phaseBoost = phase === "seek" ? 6 : phase === "initial" ? 3 : 0;
  const videoWindow = cacheEntireRemaining
    ? futureSegments
    : clamp(
        Math.max(baseWindow, futureSegments + phaseBoost),
        8,
        phase === "seek" ? 30 : phase === "initial" ? 24 : 18,
      );
  const audioWindow = cacheEntireRemaining
    ? videoWindow
    : clamp(videoWindow, 4, 18);
  const totalConcurrency = clamp(
    Math.max(
      input.maxConcurrentRequests,
      phase === "seek" ? 16 : phase === "initial" ? 14 : Math.min(videoWindow + 2, 12),
    ),
    8,
    16,
  );
  const bitrateEstimate = Math.max(
    2_500_000,
    input.estimatedBitrate ?? (highBitrateMode ? 12_000_000 : 5_000_000),
  );
  const cacheLimitBytes = clampBytes(
    Math.round((bitrateEstimate / 8) * Math.max(targetSeconds, 12) * (phase === "seek" ? 2.1 : 1.8)),
    highBitrateMode ? 192 * MB : 96 * MB,
    highBitrateMode ? 1024 * MB : 384 * MB,
  );

  return {
    videoWindow,
    audioWindow,
    totalConcurrency,
    cacheLimitBytes,
    targetSeconds,
    highBitrateMode,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function clampBytes(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
