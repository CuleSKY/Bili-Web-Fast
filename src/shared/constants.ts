import type { ExtensionPolicy } from "./types";

export const STORAGE_KEYS = {
  policy: "bwf.policy",
  telemetry: "bwf.telemetry",
} as const;

export const PAGE_MESSAGE_SOURCE = "bwf-page";

export const DEFAULT_POLICY: ExtensionPolicy = {
  mode: "stable",
  vod: {
    lockQuality: true,
    preferredQuality: null,
    codecPreference: "auto",
    prefetchWindow: 12,
    aggressivePrefetchSeconds: 48,
    maxConcurrentRequests: 24,
    experimentalRangeSplit: false,
    rangeChunkSizeKb: 2048,
    seekBoostWindow: 12,
    hostCooldownMs: 12_000,
    diagnosticsOverlay: true,
  },
  live: {
    defaultMode: "stable",
    preferredQuality: null,
    preferredProtocol: "auto",
    enableProtocolFallback: true,
    stableBufferTargetSeconds: 8,
    hostCooldownMs: 45_000,
    diagnosticsOverlay: true,
  },
  diagnostics: {
    overlayEnabled: true,
    detailedLogs: true,
    logLimit: 400,
  },
};

export const RECOVERY_LIMITS = {
  sameActionCooldownMs: 10_000,
  qualityDropCooldownMs: 30_000,
  rebuildCooldownMs: 60_000,
};
