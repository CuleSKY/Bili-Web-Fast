export type DownloadPhase = "initial" | "seek" | "steady" | "liveUrgent";

export interface DownloadControllerInput {
  phase: DownloadPhase;
  minConcurrency: number;
  maxConcurrency: number;
  currentConcurrency: number;
  previousThroughputBps: number;
  recentThroughputBps: number;
  recentErrorRate: number;
  queueDepth: number;
  lowGainStreak: number;
  bufferedSeconds: number;
  targetBufferSeconds: number;
  seekUrgent: boolean;
  liveUrgent: boolean;
  cacheSatisfied: boolean;
}

export interface DownloadControllerDecision {
  nextConcurrency: number;
  nextLowGainStreak: number;
}

export function resolveDownloadController(input: DownloadControllerInput): DownloadControllerDecision {
  if (input.seekUrgent || input.liveUrgent) {
    return {
      nextConcurrency: input.maxConcurrency,
      nextLowGainStreak: 0,
    };
  }

  if (input.queueDepth <= 0) {
    const nextConcurrency =
      input.bufferedSeconds > input.targetBufferSeconds + 8 && input.cacheSatisfied
        ? input.minConcurrency
        : clamp(input.currentConcurrency, input.minConcurrency, input.maxConcurrency);
    return {
      nextConcurrency,
      nextLowGainStreak: 0,
    };
  }

  const throughputGain =
    input.previousThroughputBps > 0
      ? (input.recentThroughputBps - input.previousThroughputBps) / input.previousThroughputBps
      : input.recentThroughputBps > 0
        ? 1
        : 0;

  if (input.recentErrorRate >= 0.05) {
    return {
      nextConcurrency: clamp(input.currentConcurrency - 2, input.minConcurrency, input.maxConcurrency),
      nextLowGainStreak: 0,
    };
  }

  if (throughputGain >= 0.08 && input.recentErrorRate < 0.03) {
    return {
      nextConcurrency: clamp(input.currentConcurrency + 2, input.minConcurrency, input.maxConcurrency),
      nextLowGainStreak: 0,
    };
  }

  const nextLowGainStreak = Math.abs(throughputGain) < 0.03 ? input.lowGainStreak + 1 : 0;
  if (nextLowGainStreak >= 3) {
    return {
      nextConcurrency: clamp(input.currentConcurrency - 2, input.minConcurrency, input.maxConcurrency),
      nextLowGainStreak: 0,
    };
  }

  if (input.bufferedSeconds > input.targetBufferSeconds + 8 && input.cacheSatisfied) {
    return {
      nextConcurrency: input.minConcurrency,
      nextLowGainStreak: 0,
    };
  }

  return {
    nextConcurrency: clamp(input.currentConcurrency, input.minConcurrency, input.maxConcurrency),
    nextLowGainStreak,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
