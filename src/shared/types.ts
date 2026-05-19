export type PageKind = "vod" | "live" | "unknown";

export type PlaybackMode = "off" | "stable" | "lowLatency";

export type CodecPreference = "auto" | "avc" | "hevc" | "av1";

export type LiveProtocolPreference = "auto" | "flv" | "fmp4" | "ts";

export interface VODPolicy {
  lockQuality: boolean;
  preferredQuality: number | null;
  codecPreference: CodecPreference;
  prefetchWindow: number;
  aggressivePrefetchSeconds: number;
  maxConcurrentRequests: number;
  experimentalRangeSplit: boolean;
  rangeChunkSizeKb: number;
  seekBoostWindow: number;
  hostCooldownMs: number;
  diagnosticsOverlay: boolean;
}

export interface LivePolicy {
  defaultMode: Exclude<PlaybackMode, "off">;
  preferredQuality: number | null;
  preferredProtocol: LiveProtocolPreference;
  enableProtocolFallback: boolean;
  stableBufferTargetSeconds: number;
  hostCooldownMs: number;
  diagnosticsOverlay: boolean;
}

export interface DiagnosticsPolicy {
  overlayEnabled: boolean;
  detailedLogs: boolean;
  logLimit: number;
}

export interface ExtensionPolicy {
  mode: PlaybackMode;
  vod: VODPolicy;
  live: LivePolicy;
  diagnostics: DiagnosticsPolicy;
}

export interface PageStatus {
  pageKind: PageKind;
  mode: PlaybackMode;
  downloadPhase: "initial" | "seek" | "steady" | "liveUrgent";
  quality: number | null;
  codec: string | null;
  host: string | null;
  protocol: string | null;
  bufferedSeconds: number;
  targetBufferSeconds: number;
  avgSegmentDurationMs: number;
  avgVodSegmentSeconds: number;
  prefetchQueueDepth: number;
  cacheBytes: number;
  controllerConcurrency: number;
  recentThroughputMbps: number;
  activeSegmentDownloads: number;
  activeRangeJobs: number;
  rangeSplitActive: boolean;
  prefetchHitCount: number;
  rangeChunkRetryCount: number;
  waitingCount1m: number;
  stalledCount1m: number;
  droppedFrames: number;
  lastRecoveryReason: string | null;
  lastRecoveryAction: string | null;
  lastSeekRecoveryMs: number | null;
  lastSeekTargetBuffered: boolean;
  seekInProgress: boolean;
  targetQualitySatisfied: boolean;
  activeMediaHost: string | null;
  hostHealthSummary: string;
  liveBufferTier: "low" | "target" | "high";
  networkBoundLikely: boolean;
  decodeBoundLikely: boolean;
}

export interface TelemetryEventBase {
  ts: number;
  tabId?: number;
  url: string;
  pageKind: PageKind;
}

export interface PlaybackEvent extends TelemetryEventBase {
  type: "playback";
  event:
    | "play"
    | "pause"
    | "waiting"
    | "stalled"
    | "canplay"
    | "timeupdate"
    | "recovery";
  bufferedSeconds?: number;
  droppedFrames?: number;
  detail?: string;
}

export interface NetworkEvent extends TelemetryEventBase {
  type: "network";
  resourceKind: "playurl" | "livePlayInfo" | "media" | "playlist" | "prefetch" | "mse" | "other";
  resourceUrl: string;
  durationMs: number;
  ok: boolean;
  status?: number;
  bytes?: number;
  detail?: string;
}

export interface RecoveryEvent extends TelemetryEventBase {
  type: "recovery";
  reason: string;
  action: string;
}

export interface ControlEvent extends TelemetryEventBase {
  type: "control";
  action: string;
  detail?: string;
}

export type TelemetryEvent = PlaybackEvent | NetworkEvent | RecoveryEvent | ControlEvent;
