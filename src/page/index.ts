import type {
  CodecPreference,
  ControlEvent,
  ExtensionPolicy,
  PageStatus,
  PlaybackMode,
  RecoveryEvent,
  TelemetryEvent,
} from "../shared/types";
import type { LiveProtocolPreference } from "../shared/types";
import type { PageBridgeMessage, PolicyPatch } from "../shared/messaging/protocol";

type CandidateUrl = { host?: string; extra?: string };
type HostFallbackEntry = { currentHost: string; backups: string[] };
type PrefetchPriority = "seek" | "playback" | "media" | "playlist";
type RangeChunkTask = {
  url: string;
  start: number;
  end: number;
  bytesTotal: number;
  reason: "playback" | "seek";
};
type HostHealth = {
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
  cooldownUntil: number;
  lastFailureAt: number;
  lastSuccessAt: number;
};

type HostFailureSample = {
  ts: number;
  url: string;
};

const PAGE_MESSAGE_SOURCE = "bwf-page";

const DEFAULT_POLICY: ExtensionPolicy = {
  mode: "stable",
  vod: {
    lockQuality: true,
    preferredQuality: null,
    codecPreference: "auto",
    prefetchWindow: 12,
    aggressivePrefetchSeconds: 48,
    maxConcurrentRequests: 12,
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

const RECOVERY_LIMITS = {
  sameActionCooldownMs: 10_000,
  qualityDropCooldownMs: 30_000,
  rebuildCooldownMs: 60_000,
};

interface CacheEntry {
  url: string;
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bytes: number;
  createdAt: number;
  source: "prefetch" | "range";
}

interface PrefetchTask {
  url: string;
  kind: "media" | "playlist";
  priority: PrefetchPriority;
}

interface VodSelection {
  quality: number | null;
  codec: string | null;
  bitrate: number | null;
  height: number | null;
  durationSeconds: number | null;
  availableQualities: number[];
  availableCodecsByQuality: Map<number, string[]>;
  currentTrackPaths: string[];
  videoBaseUrl: string | null;
  audioBaseUrl: string | null;
}

interface LiveSelection {
  quality: number | null;
  protocol: string | null;
  protocolCandidates: string[];
}

interface SeekState {
  active: boolean;
  startedAt: number;
  targetTime: number;
  targetBuffered: boolean;
  resolvedAt: number | null;
}

type BwfDebug = {
  getStatus: () => PageStatus;
  getPolicy: () => ExtensionPolicy;
  getMetrics: () => {
    cacheBytes: number;
    cacheEntries: number;
    prefetchQueueDepth: number;
    hostFallbacks: number;
    activeRangeJobs: number;
    mode: PlaybackMode;
  };
  setMode: (mode: PlaybackMode) => void;
  toggleOverlay: () => void;
};

type VodPrefetchPhase = "initial" | "steady" | "seek";

declare global {
  interface Window {
    __BWF_DEBUG__?: BwfDebug;
    player?: Record<string, unknown>;
    bpxPlayer?: Record<string, unknown>;
  }
}

const pageKind = detectPageKind(location.href);
let policy: ExtensionPolicy = DEFAULT_POLICY;
const telemetry: TelemetryEvent[] = [];
let overlay: HTMLDivElement | null = null;
let overlayBody: HTMLPreElement | null = null;
let overlayExpanded = true;
const recoveryTimestamps = new Map<string, number>();
const hostFallbacks = new Map<string, HostFallbackEntry>();
const hostFailures = new Map<string, number>();
const hostHealth = new Map<string, HostHealth>();
const hostFailureSamples: HostFailureSample[] = [];
const segmentDurations: number[] = [];
const mediaCache = new Map<string, CacheEntry>();
const inflightPrefetches = new Map<string, Promise<CacheEntry | null>>();
const prefetchQueue: PrefetchTask[] = [];
const liveSeenSegments = new Set<string>();
const nativeFetch = window.fetch.bind(window);
const inflightRangeRequests = new Map<string, Promise<Response>>();

let prefetchActive = 0;
let cacheBytes = 0;
let prefetchHitCount = 0;
let rangeChunkRetryCount = 0;
let lastMediaUrl: string | null = null;
let vodSelection: VodSelection = {
  quality: null,
  codec: null,
  bitrate: null,
  height: null,
  durationSeconds: null,
  availableQualities: [],
  availableCodecsByQuality: new Map(),
  currentTrackPaths: [],
  videoBaseUrl: null,
  audioBaseUrl: null,
};
let liveSelection: LiveSelection = {
  quality: null,
  protocol: null,
  protocolCandidates: [],
};
let seekState: SeekState = {
  active: false,
  startedAt: 0,
  targetTime: 0,
  targetBuffered: true,
  resolvedAt: null,
};

const state: PageStatus = buildStatus(
  {
    pageKind,
    mode: DEFAULT_POLICY.mode,
    avgSegmentDurationMs: 0,
    prefetchQueueDepth: 0,
    cacheBytes: 0,
    activeRangeJobs: 0,
    rangeSplitActive: false,
    prefetchHitCount: 0,
    rangeChunkRetryCount: 0,
    lastSeekRecoveryMs: null,
    lastSeekTargetBuffered: true,
    seekInProgress: false,
    targetQualitySatisfied: false,
    activeMediaHost: null,
    hostHealthSummary: "",
    liveBufferTier: "target",
  },
  telemetry,
);

document.documentElement.dataset.bwfPage = "booting";

try {
  installBridge();
  installFetchHook();
  installXhrHook();
  installMediaHooks();
  installMseHooks();
  installDebugSurface();
  publishStatus();
  document.documentElement.dataset.bwfPage = "ready";
} catch (error) {
  document.documentElement.dataset.bwfPage = "error";
  document.documentElement.dataset.bwfPageError =
    error instanceof Error ? `${error.name}:${error.message}` : String(error);
  throw error;
}

function installBridge(): void {
  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data as PageBridgeMessage | undefined;
    if (!data || data.source !== PAGE_MESSAGE_SOURCE) {
      return;
    }
    if (data.kind === "policy") {
      policy = data.policy;
      state.mode = pageKind === "live" ? data.policy.live.defaultMode : data.policy.mode;
      updateDerivedMetrics();
      publishStatus();
      return;
    }
    if (data.kind === "runtimeCommand" && data.command === "setMode") {
      state.mode = pageKind === "live" && data.mode !== "off" ? data.mode : data.mode;
      emitControl("set-mode", data.mode);
      publishStatus();
    }
  });
}

function installFetchHook(): void {
  window.fetch = async (input, init) => {
    const requestUrl = extractRequestUrl(input);
    const resourceKind = classifyResource(requestUrl);
    const cacheHit = takeCachedResponse(requestUrl);
    if (cacheHit) {
      prefetchHitCount += 1;
      emitNetworkEvent("prefetch", requestUrl, 0, true, undefined, "cache-hit");
      return cacheHit;
    }

    const prefetched = await takeInflightPrefetch(requestUrl);
    if (prefetched) {
      prefetchHitCount += 1;
      emitNetworkEvent("prefetch", requestUrl, 0, true, prefetched.body.byteLength, "await-prefetch");
      return responseFromCache(prefetched);
    }

    const started = performance.now();
    const splitResponse =
      resourceKind === "media" ? await maybeServeMediaWithRangeSplit(requestUrl, input, init) : null;
    const { response, finalUrl } = splitResponse
      ? { response: splitResponse, finalUrl: requestUrl }
      : await performFetchWithFallback(nativeFetch, input, init, requestUrl, resourceKind);
    const responseForPage = await maybeRewriteFetchResponse(requestUrl, response);
    const durationMs = Math.round(performance.now() - started);
    const clone = responseForPage.clone();
    noteActiveMediaHost(finalUrl, resourceKind);
    noteHostSuccess(finalUrl, durationMs);
    void handleFetchResponse(finalUrl, resourceKind, clone, durationMs);

    if (resourceKind === "media" && responseForPage.ok) {
      noteSegmentDuration(durationMs);
      scheduleVodPrefetch(finalUrl);
    } else if (resourceKind === "playlist" && responseForPage.ok) {
      void scheduleLivePlaylistPrefetch(finalUrl, responseForPage.clone());
    }
    return responseForPage;
  };
}

function installXhrHook(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function open(
    this: XMLHttpRequest & { __bwfUrl?: string; __bwfStart?: number },
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    const originalUrl = String(url);
    this.__bwfUrl = originalUrl;
    return originalOpen.call(this, method, originalUrl, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function send(
    this: XMLHttpRequest & { __bwfUrl?: string; __bwfStart?: number },
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    this.__bwfStart = performance.now();
    this.addEventListener("loadend", () => {
      const duration = Math.round(performance.now() - (this.__bwfStart ?? performance.now()));
      const url = this.__bwfUrl ?? "";
      emitNetworkEvent(
        classifyResource(url),
        url,
        duration,
        this.status >= 200 && this.status < 400,
        undefined,
        `xhr:${this.status}`,
      );
      if (this.status >= 400) {
        noteHostFailure(url);
      }
    });
    return originalSend.call(this, body);
  };
}

function installMediaHooks(): void {
  const attached = new WeakSet<HTMLVideoElement>();
  const attach = () => {
    const video = document.querySelector("video");
    if (!video || attached.has(video)) {
      return;
    }
    attached.add(video);
    video.addEventListener("seeking", () => {
      beginSeekTracking(video);
      pushPlayback("timeupdate", "seeking");
      publishStatus();
    });
    video.addEventListener("seeked", () => {
      resolveSeekTracking(video, "seeked");
      pushPlayback("timeupdate", "seeked");
      publishStatus();
    });
    video.addEventListener("play", () => pushPlayback("play"));
    video.addEventListener("pause", () => pushPlayback("pause"));
    video.addEventListener("progress", () => {
      updateBuffered(video);
      pushPlayback("timeupdate", "progress");
    });
    video.addEventListener("waiting", () => {
      updateBuffered(video);
      pushPlayback("waiting");
      maybeRecover("waiting", video);
    });
    video.addEventListener("stalled", () => {
      updateBuffered(video);
      pushPlayback("stalled");
      maybeRecover("stalled", video);
    });
    video.addEventListener("canplay", () => {
      updateBuffered(video);
      resolveSeekTracking(video, "canplay");
      pushPlayback("canplay");
    });
    video.addEventListener("timeupdate", () => {
      updateBuffered(video);
      updateDroppedFrames(video);
      if (seekState.active && state.bufferedSeconds > 0.75) {
        resolveSeekTracking(video, "timeupdate");
      }
      publishStatus();
    });
  };

  const observer = new MutationObserver(() => attach());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  attach();
}

function installMseHooks(): void {
  const mediaSourceProto = window.MediaSource?.prototype;
  const sourceBufferProto = window.SourceBuffer?.prototype;
  if (!mediaSourceProto || !sourceBufferProto) {
    return;
  }

  const originalAddSourceBuffer = mediaSourceProto.addSourceBuffer;
  mediaSourceProto.addSourceBuffer = function addSourceBuffer(this: MediaSource, mimeType: string): SourceBuffer {
    const buffer = originalAddSourceBuffer.call(this, mimeType);
    patchSourceBuffer(buffer, mimeType);
    return buffer;
  };
}

function patchSourceBuffer(buffer: SourceBuffer, mimeType: string): void {
  const originalAppendBuffer = buffer.appendBuffer.bind(buffer);
  if ((buffer as SourceBuffer & { __bwfPatched?: boolean }).__bwfPatched) {
    return;
  }
  (buffer as SourceBuffer & { __bwfPatched?: boolean }).__bwfPatched = true;

  buffer.appendBuffer = ((data: BufferSource) => {
    const started = performance.now();
    const bytes = bufferSourceBytes(data);
    const finalize = (ok: boolean, detail: string) => {
      const duration = Math.round(performance.now() - started);
      emitNetworkEvent("mse", mimeType, duration, ok, bytes, detail);
      if (ok) {
        noteSegmentDuration(duration);
      }
    };

    const onUpdateEnd = () => {
      cleanup();
      finalize(true, "appendBuffer:updateend");
    };
    const onError = () => {
      cleanup();
      finalize(false, "appendBuffer:error");
    };
    const cleanup = () => {
      buffer.removeEventListener("updateend", onUpdateEnd);
      buffer.removeEventListener("error", onError);
    };

    buffer.addEventListener("updateend", onUpdateEnd, { once: true });
    buffer.addEventListener("error", onError, { once: true });
    try {
      originalAppendBuffer(data);
    } catch (error) {
      cleanup();
      finalize(false, `appendBuffer:throw:${error instanceof Error ? error.name : "unknown"}`);
      throw error;
    }
  }) as typeof buffer.appendBuffer;
}

async function handleFetchResponse(
  url: string,
  resourceKind: ReturnType<typeof classifyResource>,
  response: Response,
  durationMs: number,
): Promise<void> {
  const bytesHeader = response.headers.get("content-length");
  const bytes = bytesHeader ? Number(bytesHeader) : undefined;
  emitNetworkEvent(resourceKind, url, durationMs, response.ok, bytes);

  if (resourceKind === "playurl" && response.ok) {
    const json = await response.json().catch(() => null);
    if (json) {
      handleVodPlayurl(json);
    }
  } else if (resourceKind === "livePlayInfo" && response.ok) {
    const json = await response.json().catch(() => null);
    if (json) {
      handleLivePlayInfo(json);
    }
  } else if (resourceKind === "media" && response.ok) {
    await storeFetchedMediaResponse(url, response);
  }
}

function handleVodPlayurl(payload: any): void {
  const container = payload?.data?.dash
    ? payload.data
    : payload?.result?.video_info?.dash
      ? payload.result.video_info
      : null;
  const dash = container?.dash;
  if (!dash) {
    return;
  }

  const videos = Array.isArray(dash.video) ? dash.video : [];
  const audios = Array.isArray(dash.audio) ? dash.audio : [];
  const preferredQuality = policy.vod.lockQuality ? policy.vod.preferredQuality : null;
  const filteredVideos =
    preferredQuality != null
      ? videos.filter((item: any) => item.id === preferredQuality)
      : videos;
  const candidates = filteredVideos.length > 0 ? filteredVideos : videos;
  const ranked = rankCodecPreference(
    candidates.map((item: any) => ({
      id: item.id,
      codecs: item.codecs ?? "",
      bandwidth: item.bandwidth,
      width: item.width,
      height: item.height,
    })),
    resolveVodCodecPreference(),
  );
  const top = ranked[0];
  const chosenVideo =
    candidates.find((item: any) => item.id === top?.id && item.codecs === top?.codecs) ?? candidates[0];
  const chosenAudio = audios[0] ?? null;
  if (!chosenVideo) {
    return;
  }

  const availableCodecsByQuality = new Map<number, string[]>();
  for (const video of videos) {
    const list = availableCodecsByQuality.get(video.id) ?? [];
    list.push(String(video.codecs ?? ""));
    availableCodecsByQuality.set(video.id, list);
  }

  vodSelection = {
    quality: chosenVideo.id ?? null,
    codec: chosenVideo.codecs ?? null,
    bitrate: chosenVideo.bandwidth ?? null,
    height: chosenVideo.height ?? null,
    durationSeconds: resolveVodDurationSeconds(payload),
    availableQualities: [...new Set<number>(videos.map((item: any) => Number(item.id)).filter((item: number) => Number.isFinite(item)))].sort((a, b) => b - a),
    availableCodecsByQuality,
    currentTrackPaths: [chosenVideo.baseUrl ?? chosenVideo.base_url, chosenAudio?.baseUrl ?? chosenAudio?.base_url]
      .filter((item: string | undefined): item is string => Boolean(item))
      .map(pathKeyFromUrl),
    videoBaseUrl: chosenVideo.baseUrl ?? chosenVideo.base_url ?? null,
    audioBaseUrl: chosenAudio?.baseUrl ?? chosenAudio?.base_url ?? null,
  };

  state.quality = vodSelection.quality;
  state.codec = vodSelection.codec;
  state.host = parseHost(chosenVideo.baseUrl ?? chosenAudio?.baseUrl ?? null);
  state.protocol = "dash";
  updateDerivedMetrics();
  publishStatus();
  if (vodSelection.videoBaseUrl) {
    scheduleVodPrefetch(vodSelection.videoBaseUrl);
  }
}

function handleLivePlayInfo(payload: any): void {
  const playurl = payload?.data?.playurl_info?.playurl;
  const streams = playurl?.stream;
  if (!Array.isArray(streams)) {
    return;
  }

  const candidates: Array<{ stream: any; format: any; codec: any }> = [];
  for (const stream of streams) {
    for (const format of stream?.format ?? []) {
      for (const codec of format?.codec ?? []) {
        candidates.push({ stream, format, codec });
      }
    }
  }

  const ranked = rankLiveCandidates(candidates);
  const best = ranked[0];
  if (!best) {
    return;
  }
  const original = candidates.find(
    (item) =>
      item.stream.protocol_name === best.protocolName &&
      item.format.format_name === best.formatName &&
      item.codec.codec_name === best.codecName,
  );
  if (!original) {
    return;
  }

  const urlInfos = (original.codec.url_info as CandidateUrl[] | undefined) ?? [];
  const liveUrl = buildLiveUrl(original.codec.base_url ?? original.codec.baseUrl ?? "", urlInfos[0]);

  liveSelection = {
    quality: original.codec.current_qn ?? null,
    protocol: `${best.protocolName}/${best.formatName}`,
    protocolCandidates: ranked.map((item) => `${item.protocolName}/${item.formatName}`),
  };

  state.quality = liveSelection.quality;
  state.codec = original.codec.codec_name ?? null;
  state.host = parseHost(liveUrl);
  state.protocol = liveSelection.protocol;
  updateDerivedMetrics();
  publishStatus();
}

function updateBuffered(video: HTMLVideoElement): void {
  const buffered = video.buffered;
  if (buffered.length > 0) {
    state.bufferedSeconds = Math.max(0, buffered.end(buffered.length - 1) - video.currentTime);
  } else {
    state.bufferedSeconds = 0;
  }
  publishStatus();
}

function updateDroppedFrames(video: HTMLVideoElement): void {
  const quality = video.getVideoPlaybackQuality?.();
  state.droppedFrames = quality?.droppedVideoFrames ?? state.droppedFrames;
}

function maybeRecover(reason: string, video: HTMLVideoElement): void {
  if (state.mode === "off") {
    return;
  }
  const now = Date.now();
  if (now - (recoveryTimestamps.get(reason) ?? 0) < RECOVERY_LIMITS.sameActionCooldownMs) {
    return;
  }

  const action = selectRecoveryAction({
    pageKind,
    mode: state.mode,
    bufferedSeconds: state.bufferedSeconds,
    droppedFrames: state.droppedFrames,
    backupHostsAvailable: false,
    enableProtocolFallback: policy.live.enableProtocolFallback,
    hostFailures: recentHostFailures(),
    repeatedStalls: state.waitingCount1m + state.stalledCount1m,
  });
  if (action === "noop") {
    return;
  }

  recoveryTimestamps.set(reason, now);
  void executeRecovery(action, video);
  state.lastRecoveryReason = reason;
  state.lastRecoveryAction = action;

  const event: RecoveryEvent = {
    type: "recovery",
    ts: now,
    url: location.href,
    pageKind,
    reason,
    action,
  };
  emitTelemetry(event);
  pushPlayback("recovery", action);
  publishStatus();
}

async function executeRecovery(action: string, video: HTMLVideoElement): Promise<void> {
  switch (action) {
    case "switch-live-protocol": {
      requestPolicyPatch({
        live: {
          preferredProtocol: nextLiveProtocolPreference(),
        },
      });
      attemptPlayerMethod(["reload", "restart", "replay"]);
      softSeek(video);
      await ensurePlayback(video);
      return;
    }
    case "prefer-stable-codec": {
      requestPolicyPatch({
        vod: {
          codecPreference: "avc",
        },
      });
      const currentQuality = currentPlayerQuality();
      if (state.quality != null && currentQuality !== state.quality) {
        attemptPlayerMethod(["requestQuality", "setQuality"], state.quality);
      }
      await ensurePlayback(video);
      return;
    }
    case "drop-quality": {
      const nextQuality = nextLowerQuality(state.quality);
      if (nextQuality != null) {
        requestPolicyPatch({
          vod: {
            lockQuality: true,
            preferredQuality: nextQuality,
          },
          live: {
            preferredQuality: nextQuality,
          },
        });
        state.quality = nextQuality;
        const currentQuality = currentPlayerQuality();
        if (currentQuality !== nextQuality) {
          attemptPlayerMethod(["requestQuality", "setQuality", "switchQuality"], nextQuality);
        }
      }
      await ensurePlayback(video);
      return;
    }
    case "rebuild-live-player":
    case "rebuild-playback-state":
    default: {
      attemptPlayerMethod(["reload", "restart", "replay"]);
      softSeek(video);
      await ensurePlayback(video);
    }
  }
}

function pushPlayback(
  event: "play" | "pause" | "waiting" | "stalled" | "canplay" | "timeupdate" | "recovery",
  detail?: string,
): void {
  emitTelemetry({
    type: "playback",
    ts: Date.now(),
    url: location.href,
    pageKind,
    event,
    bufferedSeconds: state.bufferedSeconds,
    droppedFrames: state.droppedFrames,
    detail,
  });
}

function emitTelemetry(event: TelemetryEvent): void {
  telemetry.push(event);
  while (telemetry.length > policy.diagnostics.logLimit) {
    telemetry.shift();
  }
  window.postMessage(
    { source: PAGE_MESSAGE_SOURCE, kind: "telemetry", event } satisfies PageBridgeMessage,
    "*",
  );
}

function emitControl(action: string, detail?: string): void {
  const event: ControlEvent = {
    type: "control",
    ts: Date.now(),
    url: location.href,
    pageKind,
    action,
    detail,
  };
  emitTelemetry(event);
}

function emitNetworkEvent(
  resourceKind: "playurl" | "livePlayInfo" | "media" | "playlist" | "prefetch" | "mse" | "other",
  resourceUrl: string,
  durationMs: number,
  ok: boolean,
  bytes?: number,
  detail?: string,
): void {
  emitTelemetry({
    type: "network",
    ts: Date.now(),
    url: location.href,
    pageKind,
    resourceKind,
    resourceUrl,
    durationMs,
    ok,
    status: ok ? 200 : undefined,
    bytes,
    detail,
  });
}

function publishStatus(): void {
  updateDerivedMetrics();
  const next = buildStatus(state, telemetry);
  Object.assign(state, next);
  updateOverlay();
  window.postMessage(
    { source: PAGE_MESSAGE_SOURCE, kind: "status", status: next } satisfies PageBridgeMessage,
    "*",
  );
}

function updateDerivedMetrics(): void {
  state.avgSegmentDurationMs =
    segmentDurations.length > 0
      ? Math.round(segmentDurations.reduce((sum, value) => sum + value, 0) / segmentDurations.length)
      : 0;
  state.prefetchQueueDepth = prefetchQueue.length + inflightPrefetches.size;
  state.cacheBytes = cacheBytes;
  state.activeRangeJobs = inflightRangeRequests.size;
  state.prefetchHitCount = prefetchHitCount;
  state.rangeChunkRetryCount = rangeChunkRetryCount;
  state.rangeSplitActive = inflightRangeRequests.size > 0;
  state.seekInProgress = seekState.active;
  state.lastSeekTargetBuffered = seekState.targetBuffered;
  state.activeMediaHost = parseHost(lastMediaUrl) ?? state.host;
  state.hostHealthSummary = summarizeHostHealth();
  state.targetQualitySatisfied = isTargetQualitySatisfied();
  state.liveBufferTier = classifyLiveBufferTier(state.bufferedSeconds);
}

function updateOverlay(): void {
  if (!policy.diagnostics.overlayEnabled || state.mode === "off") {
    overlay?.remove();
    overlayBody = null;
    overlay = null;
    return;
  }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "bwf-overlay";
    overlay.dataset.bwf = "overlay";
    overlay.style.cssText = [
      "position:fixed",
      "top:12px",
      "right:12px",
      "z-index:2147483647",
      "background:rgba(17,19,24,0.92)",
      "color:#eef2ff",
      "padding:0",
      "border-radius:8px",
      "font:12px/1.4 Consolas, monospace",
      "box-shadow:0 6px 24px rgba(0,0,0,.35)",
      "max-width:360px",
      "pointer-events:auto",
      "overflow:hidden",
    ].join(";");
    const header = document.createElement("div");
    header.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "padding:8px 10px",
      "border-bottom:1px solid rgba(255,255,255,0.08)",
      "cursor:default",
      "gap:8px",
    ].join(";");
    const title = document.createElement("strong");
    title.textContent = "BWF";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex; gap:6px;";
    const toggleButton = document.createElement("button");
    toggleButton.textContent = "Fold";
    toggleButton.style.cssText = overlayButtonStyle();
    toggleButton.addEventListener("click", () => {
      overlayExpanded = !overlayExpanded;
      toggleButton.textContent = overlayExpanded ? "Fold" : "Show";
      updateOverlay();
    });
    const closeButton = document.createElement("button");
    closeButton.textContent = "Hide";
    closeButton.style.cssText = overlayButtonStyle();
    closeButton.addEventListener("click", () => {
      emitControl("overlay-hide");
      requestPolicyPatch({
        diagnostics: {
          overlayEnabled: false,
        },
      });
      publishStatus();
    });
    actions.append(toggleButton, closeButton);
    header.append(title, actions);
    overlayBody = document.createElement("pre");
    overlayBody.style.cssText = [
      "margin:0",
      "padding:10px 12px",
      "white-space:pre-wrap",
      "pointer-events:none",
    ].join(";");
    overlay.append(header, overlayBody);
    document.documentElement.appendChild(overlay);
  }
  if (overlayBody) {
    overlayBody.style.display = overlayExpanded ? "block" : "none";
    overlayBody.textContent = [
    `mode=${state.mode} page=${state.pageKind}`,
    `quality=${state.quality ?? "-"} codec=${state.codec ?? "-"}`,
    `host=${state.host ?? "-"}`,
    `protocol=${state.protocol ?? "-"}`,
    `buffer=${state.bufferedSeconds.toFixed(2)}s ready=${currentReadyState()}`,
    `seg=${state.avgSegmentDurationMs}ms prefetch=${state.prefetchQueueDepth} cache=${formatBytes(state.cacheBytes)}`,
    `range=${state.activeRangeJobs} split=${state.rangeSplitActive} hits=${state.prefetchHitCount} retries=${state.rangeChunkRetryCount}`,
    `wait1m=${state.waitingCount1m} stall1m=${state.stalledCount1m} dropped=${state.droppedFrames}`,
    `seek=${state.seekInProgress ? "active" : state.lastSeekRecoveryMs == null ? "-" : `${state.lastSeekRecoveryMs}ms`} targetBuffered=${state.lastSeekTargetBuffered}`,
    `targetQuality=${state.targetQualitySatisfied} liveBuffer=${state.liveBufferTier}`,
    `hostHealth=${state.hostHealthSummary || "-"}`,
    `networkBound=${state.networkBoundLikely} decodeBound=${state.decodeBoundLikely}`,
    `recovery=${state.lastRecoveryAction ?? "-"}`,
  ].join("\n");
  }
}

function installDebugSurface(): void {
  window.__BWF_DEBUG__ = {
    getStatus: () => ({ ...state }),
    getPolicy: () => structuredClone(policy),
    getMetrics: () => ({
      cacheBytes,
      cacheEntries: mediaCache.size,
      prefetchQueueDepth: prefetchQueue.length + inflightPrefetches.size,
      hostFallbacks: hostFallbacks.size,
      activeRangeJobs: inflightRangeRequests.size,
      mode: state.mode,
    }),
    setMode: (mode: PlaybackMode) => {
      emitControl("debug-set-mode", mode);
      window.postMessage(
        { source: PAGE_MESSAGE_SOURCE, kind: "runtimeCommand", command: "setMode", mode } satisfies PageBridgeMessage,
        "*",
      );
    },
    toggleOverlay: () => {
      overlayExpanded = !overlayExpanded;
      emitControl("debug-toggle-overlay", overlayExpanded ? "expanded" : "collapsed");
      updateOverlay();
    },
  };
}

function classifyResource(url: string): "playurl" | "livePlayInfo" | "media" | "playlist" | "other" {
  if (/x\/player\/wbi\/playurl/.test(url)) {
    return "playurl";
  }
  if (/xlive\/web-room\/v2\/index\/getRoomPlayInfo/.test(url)) {
    return "livePlayInfo";
  }
  if (/\.m3u8(\?|$)/.test(url)) {
    return "playlist";
  }
  if (/\.m4s(\?|$)|\.mp4(\?|$)|\.flv(\?|$)|\.ts(\?|$)|\.cmfv(\?|$)/.test(url)) {
    return "media";
  }
  return "other";
}

async function maybeRewriteFetchResponse(url: string, response: Response): Promise<Response> {
  const resourceKind = classifyResource(url);
  if (!response.ok || (resourceKind !== "playurl" && resourceKind !== "livePlayInfo")) {
    return response;
  }

  const json = await response.clone().json().catch(() => null);
  if (!json) {
    return response;
  }

  const rewritten = resourceKind === "playurl" ? rewriteVodPayload(json) : rewriteLivePayload(json);
  if (rewritten === json) {
    return response;
  }

  return new Response(JSON.stringify(rewritten), {
    status: response.status,
    statusText: response.statusText,
    headers: cloneHeaders(response.headers),
  });
}

function rewriteVodPayload(payload: any): any {
  const container = payload?.data?.dash
    ? payload.data
    : payload?.result?.video_info?.dash
      ? payload.result.video_info
      : null;
  const dash = container?.dash;
  if (!dash) {
    return payload;
  }

  const videos = Array.isArray(dash.video) ? dash.video : [];
  const audios = Array.isArray(dash.audio) ? dash.audio : [];
  let candidates = videos;
  if (policy.vod.lockQuality && policy.vod.preferredQuality != null) {
    const sameQuality = videos.filter((item: any) => item.id === policy.vod.preferredQuality);
    if (sameQuality.length > 0) {
      candidates = sameQuality;
    }
  }

  const ranked = rankCodecPreference(
    candidates.map((item: any) => ({
      id: item.id,
      codecs: item.codecs ?? "",
      bandwidth: item.bandwidth,
      width: item.width,
      height: item.height,
    })),
    resolveVodCodecPreference(),
  );
  const selected =
    candidates.find((item: any) => item.id === ranked[0]?.id && item.codecs === ranked[0]?.codecs) ??
    candidates[0];
  if (!selected) {
    return payload;
  }

  dash.video = [selected];
  if (audios[0]) {
    dash.audio = [audios[0]];
  }
  return payload;
}

function rewriteLivePayload(payload: any): any {
  const playurl = payload?.data?.playurl_info?.playurl;
  if (!playurl?.stream) {
    return payload;
  }
  const candidates: Array<{ stream: any; format: any; codec: any }> = [];
  for (const stream of playurl.stream) {
    for (const format of stream?.format ?? []) {
      for (const codec of format?.codec ?? []) {
        candidates.push({ stream, format, codec });
      }
    }
  }
  const ranked = rankLiveCandidates(candidates);
  const selected = ranked[0];
  if (!selected) {
    return payload;
  }

  const chosen = candidates.find(
    (item) =>
      item.stream.protocol_name === selected.protocolName &&
      item.format.format_name === selected.formatName &&
      item.codec.codec_name === selected.codecName,
  );
  if (!chosen) {
    return payload;
  }

  playurl.stream = [
    {
      ...chosen.stream,
      format: [
        {
          ...chosen.format,
          codec: [chosen.codec],
        },
      ],
    },
  ];
  return payload;
}

function rankLiveCandidates(candidates: Array<{ stream: any; format: any; codec: any }>) {
  const filtered = candidates.filter((item) => {
    if (policy.live.preferredQuality != null && item.codec.current_qn !== policy.live.preferredQuality) {
      return false;
    }
    return true;
  });
  const pool = filtered.length > 0 ? filtered : candidates;
  const sorted = sortLiveCandidates(
    state.mode === "off" ? "stable" : state.mode,
    pool.map((item) => ({
      protocolName: item.stream.protocol_name ?? "",
      formatName: item.format.format_name ?? "",
      codecName: item.codec.codec_name ?? "",
    })),
  );
  return preferLiveProtocol(sorted, policy.live.preferredProtocol);
}

function preferLiveProtocol<T extends { protocolName: string; formatName: string }>(
  candidates: T[],
  preferredProtocol: LiveProtocolPreference,
): T[] {
  if (preferredProtocol === "auto") {
    return candidates;
  }
  return [...candidates].sort((a, b) => {
    const ap = Number(a.formatName !== preferredProtocol);
    const bp = Number(b.formatName !== preferredProtocol);
    return ap - bp;
  });
}

function resolveVodCodecPreference(): CodecPreference {
  if (pageKind === "vod") {
    return policy.vod.codecPreference;
  }
  return "auto";
}

function scheduleVodPrefetch(currentUrl: string): void {
  if (pageKind !== "vod" || state.mode === "off") {
    return;
  }
  const context = getVodPrefetchContext();
  const decision = resolvePrefetchDecision({
    preferredWindow: policy.vod.prefetchWindow,
    aggressivePrefetchSeconds: policy.vod.aggressivePrefetchSeconds,
    maxConcurrentRequests: policy.vod.maxConcurrentRequests,
    quality: state.quality,
    estimatedBitrate: vodSelection.bitrate,
    avgSegmentDurationMs: estimateVodSegmentDurationMs(context),
    phase: context.phase,
    remainingSeconds: context.remainingSeconds,
  });
  evictCache(decision.cacheLimitBytes);
  for (const task of buildVodPrefetchTasks(currentUrl, decision, context)) {
    queuePrefetch(task);
  }
}

async function scheduleLivePlaylistPrefetch(playlistUrl: string, response: Response): Promise<void> {
  if (pageKind !== "live" || state.mode === "off") {
    return;
  }
  const text = await response.text().catch(() => "");
  if (!text) {
    return;
  }

  const urls = parsePlaylistUrls(playlistUrl, text);
  const liveWindow = resolveLivePrefetchWindow(urls.length);
  const urgent = state.bufferedSeconds < 1.5;
  for (const url of urls.slice(0, liveWindow)) {
    if (liveSeenSegments.has(url)) {
      continue;
    }
    liveSeenSegments.add(url);
    queuePrefetch({ url, kind: "media", priority: urgent ? "seek" : "playlist" });
  }

  while (liveSeenSegments.size > 64) {
    const first = liveSeenSegments.values().next();
    if (first.done) {
      break;
    }
    liveSeenSegments.delete(first.value);
  }
}

function getVodPrefetchContext(): {
  phase: VodPrefetchPhase;
  currentTime: number | null;
  durationSeconds: number | null;
  remainingSeconds: number | null;
} {
  const video = document.querySelector("video");
  const currentTime = video && Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : null;
  const durationSeconds =
    video && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : vodSelection.durationSeconds;
  const remainingSeconds =
    durationSeconds != null
      ? Math.max(0, durationSeconds - (currentTime ?? 0))
      : null;
  const phase: VodPrefetchPhase = shouldBoostSeekPrefetch()
    ? "seek"
    : currentTime == null || currentTime < 3 || state.bufferedSeconds < 4 || segmentDurations.length < 2
      ? "initial"
      : "steady";
  return {
    phase,
    currentTime,
    durationSeconds,
    remainingSeconds,
  };
}

function resolveVodDurationSeconds(payload: any): number | null {
  const milliseconds = Number(payload?.data?.timelength ?? payload?.result?.video_info?.timelength ?? NaN);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return milliseconds / 1000;
  }
  const seconds = Number(payload?.data?.dash?.duration ?? payload?.result?.video_info?.dash?.duration ?? NaN);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds;
  }
  return null;
}

function estimateVodSegmentDurationMs(_context: { currentTime: number | null; durationSeconds: number | null }): number {
  return 4_000;
}

function buildVodPrefetchTasks(
  currentUrl: string,
  decision: {
    videoWindow: number;
    audioWindow: number;
    targetSeconds: number;
  },
  context: {
    phase: VodPrefetchPhase;
    remainingSeconds: number | null;
  },
): PrefetchTask[] {
  const tasks: PrefetchTask[] = [];
  const priority: PrefetchPriority = context.phase === "seek" ? "seek" : "media";
  const boostCount = context.phase === "seek" ? Math.max(4, policy.vod.seekBoostWindow) : 0;
  const currentTrack = inferVodTrack(currentUrl);
  const currentWindow = currentTrack === "audio" ? decision.audioWindow : decision.videoWindow;

  appendTrackPrefetchTasks(tasks, currentUrl, Math.max(0, currentWindow - 1), priority, boostCount);

  const currentSequence = extractUrlSequence(currentUrl);
  if (currentSequence != null) {
    const counterpartBaseUrl =
      currentTrack === "audio" ? vodSelection.videoBaseUrl : vodSelection.audioBaseUrl;
    const counterpartWindow = currentTrack === "audio" ? decision.videoWindow : decision.audioWindow;
    if (counterpartBaseUrl) {
      const counterpartCurrent = replaceUrlSequence(counterpartBaseUrl, currentSequence);
      if (counterpartCurrent) {
        queueTask(tasks, counterpartCurrent, priority);
      }
      appendTrackPrefetchTasks(
        tasks,
        counterpartCurrent ?? counterpartBaseUrl,
        Math.max(0, counterpartWindow - 1),
        priority,
        boostCount,
      );
    }
  }

  return tasks;
}

function appendTrackPrefetchTasks(
  tasks: PrefetchTask[],
  baseUrl: string,
  windowCount: number,
  priority: PrefetchPriority,
  boostCount: number,
): void {
  const futureUrls = inferNextSequenceUrls(baseUrl, windowCount);
  for (const [index, url] of futureUrls.entries()) {
    const taskPriority = index < boostCount ? "seek" : priority;
    queueTask(tasks, url, taskPriority);
  }
}

function queueTask(tasks: PrefetchTask[], url: string, priority: PrefetchPriority): void {
  if (tasks.some((task) => task.url === url)) {
    return;
  }
  tasks.push({ url, kind: "media", priority });
}

function extractUrlSequence(url: string): number | null {
  const parsed = safelyParseUrl(url);
  if (!parsed) {
    return null;
  }
  const match = parsed.pathname.match(/^(.*?)(\d+)(\.[^.\/]+)$/);
  if (!match) {
    return null;
  }
  const value = Number(match[2]);
  return Number.isFinite(value) ? value : null;
}

function replaceUrlSequence(templateUrl: string, sequence: number): string | null {
  const parsed = safelyParseUrl(templateUrl);
  if (!parsed) {
    return null;
  }
  const match = parsed.pathname.match(/^(.*?)(\d+)(\.[^.\/]+)$/);
  if (!match) {
    return null;
  }
  parsed.pathname = `${match[1]}${sequence}${match[3]}`;
  return parsed.toString();
}

function queuePrefetch(task: PrefetchTask): void {
  const normalized = task.url;
  if (mediaCache.has(normalized) || inflightPrefetches.has(normalized)) {
    return;
  }
  const existingIndex = prefetchQueue.findIndex((item) => item.url === normalized);
  if (existingIndex >= 0) {
    const existing = prefetchQueue[existingIndex];
    if (priorityScore(existing.priority) <= priorityScore(task.priority)) {
      return;
    }
    prefetchQueue.splice(existingIndex, 1, task);
    prefetchQueue.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority));
    updateDerivedMetrics();
    return;
  }
  prefetchQueue.push(task);
  prefetchQueue.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority));
  updateDerivedMetrics();
  drainPrefetchQueue();
}

function drainPrefetchQueue(): void {
  const decision = resolvePrefetchDecision({
    preferredWindow: policy.vod.prefetchWindow,
    aggressivePrefetchSeconds: policy.vod.aggressivePrefetchSeconds,
    maxConcurrentRequests: policy.vod.maxConcurrentRequests,
    quality: state.quality,
    estimatedBitrate: vodSelection.bitrate,
    avgSegmentDurationMs: state.avgSegmentDurationMs,
  });
  while (prefetchActive < decision.totalConcurrency && prefetchQueue.length > 0) {
    const task = takeNextPrefetchTask();
    if (!task) {
      break;
    }
    const promise = runPrefetch(task)
      .catch(() => null)
      .finally(() => {
        inflightPrefetches.delete(task.url);
        prefetchActive = Math.max(0, prefetchActive - 1);
        updateDerivedMetrics();
        drainPrefetchQueue();
      });
    inflightPrefetches.set(task.url, promise);
    prefetchActive += 1;
  }
  updateDerivedMetrics();
}

async function runPrefetch(task: PrefetchTask): Promise<CacheEntry | null> {
  const started = performance.now();
  const response = await nativeFetch(task.url, { cache: "no-store", credentials: "include" });
  const durationMs = Math.round(performance.now() - started);
  if (!response.ok) {
    noteHostFailure(task.url);
    emitNetworkEvent("prefetch", task.url, durationMs, false, undefined, task.priority);
    return null;
  }
  noteHostSuccess(task.url, durationMs);
  const body = await response.arrayBuffer();
  const entry: CacheEntry = {
    url: task.url,
    body,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    bytes: body.byteLength,
    createdAt: Date.now(),
    source: "prefetch",
  };
  storeCacheEntry(entry);
  emitNetworkEvent("prefetch", task.url, durationMs, true, body.byteLength, task.priority);
  noteSegmentDuration(durationMs);
  return entry;
}

function takeCachedResponse(url: string): Response | null {
  const entry = mediaCache.get(url);
  if (!entry) {
    return null;
  }
  mediaCache.delete(url);
  cacheBytes = Math.max(0, cacheBytes - entry.bytes);
  updateDerivedMetrics();
  return responseFromCache(entry);
}

async function takeInflightPrefetch(url: string): Promise<CacheEntry | null> {
  const entry = inflightPrefetches.get(url);
  if (!entry) {
    return null;
  }
  return entry;
}

function responseFromCache(entry: CacheEntry): Response {
  return new Response(entry.body.slice(0), {
    status: entry.status,
    statusText: entry.statusText,
    headers: new Headers(entry.headers),
  });
}

async function storeFetchedMediaResponse(url: string, response: Response): Promise<void> {
  if (mediaCache.has(url)) {
    return;
  }
  const body = await response.arrayBuffer().catch(() => null);
  if (!body) {
    return;
  }
  storeCacheEntry({
    url,
    body,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    bytes: body.byteLength,
    createdAt: Date.now(),
    source: "prefetch",
  });
}

async function maybeServeMediaWithRangeSplit(
  url: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response | null> {
  if (!shouldUseRangeSplit(url, init)) {
    return null;
  }
  const cacheKey = `${url}::seek=${seekState.active && !seekState.targetBuffered ? "1" : "0"}`;
  const inflight = inflightRangeRequests.get(cacheKey);
  if (inflight) {
    return inflight;
  }
  const promise = runRangeSplitRequest(url, input, init)
    .catch(() => null)
    .finally(() => {
      inflightRangeRequests.delete(cacheKey);
      publishStatus();
    });
  inflightRangeRequests.set(cacheKey, promise.then((response) => response ?? new Response(null, { status: 599 })));
  publishStatus();
  const response = await promise;
  return response;
}

function shouldUseRangeSplit(url: string, init: RequestInit | undefined): boolean {
  if (pageKind !== "vod" || state.mode === "off" || !policy.vod.experimentalRangeSplit) {
    return false;
  }
  if (!/\.m4s(\?|$)|\.mp4(\?|$)|\.cmfv(\?|$)/.test(url)) {
    return false;
  }
  const method = init?.method?.toUpperCase();
  if (method && method !== "GET") {
    return false;
  }
  return !((init?.headers instanceof Headers && init.headers.has("range")) || hasRangeHeader(init?.headers));
}

async function runRangeSplitRequest(
  url: string,
  _input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response | null> {
  const head = await nativeFetch(url, {
    method: "HEAD",
    cache: "no-store",
    credentials: "include",
    headers: cloneRequestHeaders(init?.headers),
  }).catch(() => null);
  if (!head?.ok) {
    return null;
  }
  const acceptsRanges = /bytes/i.test(head.headers.get("accept-ranges") ?? "");
  const contentLength = Number(head.headers.get("content-length") ?? "0");
  if (!acceptsRanges || !Number.isFinite(contentLength) || contentLength <= 0) {
    return null;
  }

  const chunkSize = Math.max(256 * 1024, policy.vod.rangeChunkSizeKb * 1024);
  const tasks: RangeChunkTask[] = [];
  for (let start = 0; start < contentLength; start += chunkSize) {
    const end = Math.min(contentLength - 1, start + chunkSize - 1);
    tasks.push({
      url,
      start,
      end,
      bytesTotal: contentLength,
      reason: seekState.active && !seekState.targetBuffered ? "seek" : "playback",
    });
  }

  const concurrency = resolveRangeSplitConcurrency(tasks[0]?.reason ?? "playback");
  const buffers = await runRangeChunkTasks(tasks, init, concurrency);
  if (buffers.some((buffer) => buffer == null)) {
    return null;
  }
  const merged = concatArrayBuffers(buffers as ArrayBuffer[]);
  emitNetworkEvent("media", url, 0, true, merged.byteLength, `range-split:${tasks.length}`);
  return new Response(merged, {
    status: 200,
    statusText: "OK",
    headers: cloneHeaders(head.headers),
  });
}

async function fetchRangeChunk(task: RangeChunkTask, init: RequestInit | undefined): Promise<ArrayBuffer | null> {
  const headers = cloneRequestHeaders(init?.headers);
  headers.set("range", `bytes=${task.start}-${task.end}`);
  const started = performance.now();
  try {
    const response = await nativeFetch(task.url, {
      ...init,
      cache: "no-store",
      credentials: "include",
      headers,
    });
    const durationMs = Math.round(performance.now() - started);
    if (!response.ok || response.status !== 206) {
      noteHostFailure(task.url);
      noteHostCooldown(task.url);
      emitNetworkEvent("media", task.url, durationMs, false, undefined, `range:${task.start}-${task.end}`);
      return retryRangeChunk(task, init);
    }
    noteHostSuccess(task.url, durationMs);
    return await response.arrayBuffer();
  } catch {
    noteHostFailure(task.url);
    noteHostCooldown(task.url);
    return retryRangeChunk(task, init);
  }
}

async function retryRangeChunk(task: RangeChunkTask, init: RequestInit | undefined): Promise<ArrayBuffer | null> {
  rangeChunkRetryCount += 1;
  const headers = cloneRequestHeaders(init?.headers);
  headers.set("range", `bytes=${task.start}-${task.end}`);
  const started = performance.now();
  const response = await nativeFetch(task.url, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers,
  }).catch(() => null);
  const durationMs = Math.round(performance.now() - started);
  if (!response || !response.ok || response.status !== 206) {
    noteHostFailure(task.url);
    noteHostCooldown(task.url);
    emitNetworkEvent("media", task.url, durationMs, false, undefined, `range-retry:${task.start}-${task.end}`);
    return null;
  }
  noteHostSuccess(task.url, durationMs);
  return await response.arrayBuffer();
}

async function runRangeChunkTasks(
  tasks: RangeChunkTask[],
  init: RequestInit | undefined,
  concurrency: number,
): Promise<Array<ArrayBuffer | null>> {
  const results = new Array<ArrayBuffer | null>(tasks.length).fill(null);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fetchRangeChunk(tasks[current], init);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    merged.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return merged.buffer;
}

function cloneRequestHeaders(headers: HeadersInit | undefined): Headers {
  const next = new Headers();
  if (!headers) {
    return next;
  }
  new Headers(headers).forEach((value, key) => next.set(key, value));
  return next;
}

function hasRangeHeader(headers: HeadersInit | undefined): boolean {
  if (!headers) {
    return false;
  }
  return new Headers(headers).has("range");
}

function storeCacheEntry(entry: CacheEntry): void {
  if (mediaCache.has(entry.url)) {
    const previous = mediaCache.get(entry.url);
    if (previous) {
      cacheBytes = Math.max(0, cacheBytes - previous.bytes);
    }
  }
  mediaCache.set(entry.url, entry);
  cacheBytes += entry.bytes;
  const decision = resolvePrefetchDecision({
    preferredWindow: policy.vod.prefetchWindow,
    aggressivePrefetchSeconds: policy.vod.aggressivePrefetchSeconds,
    maxConcurrentRequests: policy.vod.maxConcurrentRequests,
    quality: state.quality,
    estimatedBitrate: vodSelection.bitrate,
    avgSegmentDurationMs: state.avgSegmentDurationMs,
  });
  evictCache(decision.cacheLimitBytes);
  updateDerivedMetrics();
}

function evictCache(limitBytes: number): void {
  if (cacheBytes <= limitBytes) {
    return;
  }
  const entries = [...mediaCache.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of entries) {
    if (cacheBytes <= limitBytes) {
      break;
    }
    mediaCache.delete(entry.url);
    cacheBytes = Math.max(0, cacheBytes - entry.bytes);
  }
}

async function performFetchWithFallback(
  nativeFetch: typeof window.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  _originalUrl: string,
  resourceKind: ReturnType<typeof classifyResource>,
): Promise<{ response: Response; finalUrl: string }> {
  const firstUrl = extractRequestUrl(input);
  try {
    const response = await nativeFetch(input, init);
    if (response.ok || (resourceKind !== "media" && resourceKind !== "playlist")) {
      return { response, finalUrl: firstUrl };
    }
    noteHostFailure(firstUrl);
    return { response, finalUrl: firstUrl };
  } catch (error) {
    if (resourceKind !== "media" && resourceKind !== "playlist") {
      throw error;
    }
    noteHostFailure(firstUrl);
    throw error;
  }
}

function rewriteRequestInfo(input: RequestInfo | URL, nextUrl?: string | null): RequestInfo | URL {
  if (!nextUrl) {
    return input;
  }
  if (typeof input === "string") {
    return nextUrl;
  }
  if (input instanceof Request) {
    return new Request(nextUrl, input);
  }
  return new URL(nextUrl);
}


function noteHostFailure(url: string): void {
  const host = parseHost(url);
  if (!host) {
    return;
  }
  const now = Date.now();
  hostFailures.set(host, (hostFailures.get(host) ?? 0) + 1);
  hostFailureSamples.push({ ts: now, url });
  trimHostFailureSamples(now);
  const health = hostHealth.get(host) ?? emptyHostHealth();
  health.failureCount += 1;
  health.lastFailureAt = now;
  hostHealth.set(host, health);
}

function noteHostSuccess(url: string, durationMs: number): void {
  const host = parseHost(url);
  if (!host) {
    return;
  }
  const now = Date.now();
  const health = hostHealth.get(host) ?? emptyHostHealth();
  health.successCount += 1;
  health.totalDurationMs += Math.max(1, durationMs);
  health.lastSuccessAt = now;
  if (health.cooldownUntil < now) {
    health.cooldownUntil = 0;
  }
  hostHealth.set(host, health);
}

function noteHostCooldown(url: string): void {
  const host = parseHost(url);
  if (!host) {
    return;
  }
  const health = hostHealth.get(host) ?? emptyHostHealth();
  health.cooldownUntil = Date.now() + (pageKind === "live" ? policy.live.hostCooldownMs : policy.vod.hostCooldownMs);
  hostHealth.set(host, health);
}

function totalHostFailures(): number {
  trimHostFailureSamples(Date.now());
  return [...hostFailures.values()].reduce((sum, value) => sum + value, 0);
}

function recentHostFailures(windowMs = 90_000): number {
  const now = Date.now();
  trimHostFailureSamples(now, windowMs);
  return hostFailureSamples.length;
}


function trimHostFailureSamples(now: number, windowMs = 90_000): void {
  while (hostFailureSamples.length > 0 && now - hostFailureSamples[0].ts > windowMs) {
    const sample = hostFailureSamples.shift();
    if (!sample) {
      continue;
    }
    const host = parseHost(sample.url);
    if (!host) {
      continue;
    }
    const nextCount = Math.max(0, (hostFailures.get(host) ?? 0) - 1);
    if (nextCount === 0) {
      hostFailures.delete(host);
    } else {
      hostFailures.set(host, nextCount);
    }
  }
}

function noteActiveMediaHost(url: string, resourceKind: ReturnType<typeof classifyResource>): void {
  if (resourceKind !== "media" && resourceKind !== "playlist") {
    return;
  }
  lastMediaUrl = url;
  if (resourceKind === "media" || pageKind === "live") {
    state.host = parseHost(url);
  }
}

function emptyHostHealth(): HostHealth {
  return {
    successCount: 0,
    failureCount: 0,
    totalDurationMs: 0,
    cooldownUntil: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
  };
}

function inferNextSequenceUrls(url: string, count: number): string[] {
  const parsed = safelyParseUrl(url);
  if (!parsed) {
    return [];
  }
  const match = parsed.pathname.match(/^(.*?)(\d+)(\.[^.\/]+)$/);
  if (!match) {
    return [];
  }
  const prefix = match[1];
  const current = Number(match[2]);
  const suffix = match[3];
  if (!Number.isFinite(current)) {
    return [];
  }
  const urls: string[] = [];
  for (let step = 1; step <= count; step += 1) {
    const next = new URL(parsed.toString());
    next.pathname = `${prefix}${String(current + step)}${suffix}`;
    urls.push(next.toString());
  }
  return urls;
}

function inferVodTrack(url: string): "audio" | "video" {
  const pathKey = pathKeyFromUrl(url);
  if (vodSelection.currentTrackPaths.some((item) => item === pathKey && /audio/i.test(item))) {
    return "audio";
  }
  if (/audio/i.test(url)) {
    return "audio";
  }
  return "video";
}

function parsePlaylistUrls(baseUrl: string, text: string): string[] {
  const results: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      const mapMatch = trimmed.match(/URI="([^"]+)"/);
      if (mapMatch?.[1]) {
        results.push(new URL(mapMatch[1], baseUrl).toString());
      }
      continue;
    }
    results.push(new URL(trimmed, baseUrl).toString());
  }
  return results;
}

function currentReadyState(): number {
  const video = document.querySelector("video");
  return video?.readyState ?? 0;
}

function nextLowerQuality(currentQuality: number | null): number | null {
  if (currentQuality == null) {
    return null;
  }
  const currentIndex = vodSelection.availableQualities.findIndex((item) => item === currentQuality);
  if (currentIndex === -1 || currentIndex === vodSelection.availableQualities.length - 1) {
    return null;
  }
  return vodSelection.availableQualities[currentIndex + 1] ?? null;
}

function nextLiveProtocolPreference(): LiveProtocolPreference {
  const current = policy.live.preferredProtocol;
  return current === "flv"
    ? "fmp4"
    : current === "fmp4"
      ? "flv"
      : state.protocol?.includes("flv")
        ? "fmp4"
        : "flv";
}

function requestPolicyPatch(patch: PolicyPatch): void {
  policy = mergePolicyPatch(policy, patch);
  window.postMessage(
    {
      source: PAGE_MESSAGE_SOURCE,
      kind: "policyPatch",
      patch,
    } satisfies PageBridgeMessage,
    "*",
  );
  window.postMessage(
    {
      source: PAGE_MESSAGE_SOURCE,
      kind: "telemetry",
      event: {
        type: "control",
        ts: Date.now(),
        url: location.href,
        pageKind,
        action: "policy-patch",
        detail: JSON.stringify(Object.keys(patch)),
      } satisfies ControlEvent,
    } satisfies PageBridgeMessage,
    "*",
  );
}

function mergePolicyPatch(current: ExtensionPolicy, patch: PolicyPatch): ExtensionPolicy {
  return {
    ...current,
    ...patch,
    vod: {
      ...current.vod,
      ...(patch.vod ?? {}),
    },
    live: {
      ...current.live,
      ...(patch.live ?? {}),
    },
    diagnostics: {
      ...current.diagnostics,
      ...(patch.diagnostics ?? {}),
    },
  };
}

function attemptPlayerMethod(methods: string[], arg?: unknown): boolean {
  const objects = [
    window.player,
    window.bpxPlayer,
    (window as unknown as Record<string, unknown>).bilibiliPlayer,
    (window as unknown as Record<string, unknown>).__BILI_PLAYER__,
  ].filter(Boolean) as Array<Record<string, unknown>>;

  for (const object of objects) {
    for (const method of methods) {
      const candidate = object[method];
      if (typeof candidate === "function") {
        try {
          (candidate as (...args: unknown[]) => unknown)(arg);
          return true;
        } catch {
          continue;
        }
      }
    }
  }
  return false;
}

function currentPlayerQuality(): number | null {
  const objects = [
    window.player,
    window.bpxPlayer,
    (window as unknown as Record<string, unknown>).bilibiliPlayer,
    (window as unknown as Record<string, unknown>).__BILI_PLAYER__,
  ].filter(Boolean) as Array<Record<string, unknown>>;

  for (const object of objects) {
    for (const method of ["getQuality", "getCurrentQuality"]) {
      const candidate = object[method];
      if (typeof candidate !== "function") {
        continue;
      }
      try {
        const value = Number((candidate as () => unknown)());
        if (Number.isFinite(value) && value > 0) {
          return value;
        }
      } catch {
        continue;
      }
    }
  }
  return state.quality ?? null;
}

async function ensurePlayback(video: HTMLVideoElement): Promise<void> {
  if (!video.paused) {
    await video.play().catch(() => undefined);
    return;
  }
  await video.play().catch(() => undefined);
}

function softSeek(video: HTMLVideoElement): void {
  try {
    if (!Number.isFinite(video.currentTime)) {
      return;
    }
    const target = Math.max(0, video.currentTime - (pageKind === "live" ? 0 : 0.05));
    video.currentTime = target;
  } catch {
    return;
  }
}

function noteSegmentDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  segmentDurations.push(durationMs);
  while (segmentDurations.length > 24) {
    segmentDurations.shift();
  }
}

function beginSeekTracking(video: HTMLVideoElement): void {
  const targetBuffered = isTimeBuffered(video, video.currentTime);
  seekState = {
    active: true,
    startedAt: performance.now(),
    targetTime: video.currentTime,
    targetBuffered,
    resolvedAt: null,
  };
  state.lastSeekTargetBuffered = targetBuffered;
  state.seekInProgress = true;
  if (!targetBuffered) {
    emitControl("seek-uncached", `${video.currentTime.toFixed(2)}s`);
  }
}

function resolveSeekTracking(video: HTMLVideoElement, reason: string): void {
  if (!seekState.active) {
    return;
  }
  const targetBuffered = isTimeBuffered(video, video.currentTime);
  if (!targetBuffered && reason !== "seeked") {
    return;
  }
  const recoveryMs = Math.round(performance.now() - seekState.startedAt);
  seekState = {
    ...seekState,
    active: false,
    targetBuffered,
    resolvedAt: performance.now(),
  };
  state.lastSeekRecoveryMs = recoveryMs;
  state.lastSeekTargetBuffered = targetBuffered;
  state.seekInProgress = false;
  emitControl("seek-recovered", `${recoveryMs}ms:${reason}`);
}

function isTimeBuffered(video: HTMLVideoElement, time: number): boolean {
  const ranges = video.buffered;
  for (let index = 0; index < ranges.length; index += 1) {
    if (time >= ranges.start(index) && time <= ranges.end(index)) {
      return true;
    }
  }
  return false;
}

function summarizeHostHealth(): string {
  const entries = [...hostHealth.entries()];
  if (entries.length === 0) {
    return "";
  }
  return entries
    .sort((a, b) => hostScore(b[1]) - hostScore(a[1]))
    .slice(0, 3)
    .map(([host, health]) => `${host}:${hostScore(health).toFixed(2)}`)
    .join(", ");
}

function hostScore(health: HostHealth): number {
  const total = health.successCount + health.failureCount;
  const successRatio = total === 0 ? 1 : health.successCount / total;
  const avgDuration = health.successCount === 0 ? 5000 : health.totalDurationMs / health.successCount;
  const latencyFactor = Math.max(0.1, Math.min(1, 2500 / Math.max(250, avgDuration)));
  const cooldownPenalty = health.cooldownUntil > Date.now() ? 0.2 : 1;
  return successRatio * latencyFactor * cooldownPenalty;
}

function isTargetQualitySatisfied(): boolean {
  if (pageKind === "vod") {
    return (vodSelection.height ?? 0) >= 4320;
  }
  if (pageKind === "live") {
    return (state.quality ?? 0) >= 10000;
  }
  return false;
}

function classifyLiveBufferTier(bufferedSeconds: number): "low" | "target" | "high" {
  const target = policy.live.stableBufferTargetSeconds;
  if (bufferedSeconds < Math.max(2, target * 0.5)) {
    return "low";
  }
  if (bufferedSeconds > target * 1.5) {
    return "high";
  }
  return "target";
}

function resolveLivePrefetchWindow(totalSegments: number): number {
  if (totalSegments <= 0) {
    return 0;
  }
  if (state.bufferedSeconds < 1.5) {
    return totalSegments;
  }
  const target = Math.max(3, policy.live.stableBufferTargetSeconds);
  const avgSegmentSeconds = Math.max(1, state.avgSegmentDurationMs / 1000 || 2);
  const desired = Math.ceil(target / avgSegmentSeconds);
  const aggressiveFloor = state.bufferedSeconds < target ? desired + 2 : desired;
  return Math.min(totalSegments, Math.max(3, Math.min(8, aggressiveFloor)));
}

function overlayButtonStyle(): string {
  return [
    "border:1px solid rgba(255,255,255,0.14)",
    "background:rgba(255,255,255,0.04)",
    "color:#eef2ff",
    "border-radius:6px",
    "padding:2px 6px",
    "font:12px/1.2 sans-serif",
    "cursor:pointer",
  ].join(";");
}

function parseHost(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function pathKeyFromUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/\d+\.[^.]+$/, "");
  } catch {
    return url;
  }
}

function buildLiveUrl(basePath: string, firstUrlInfo?: CandidateUrl): string | null {
  const host = firstUrlInfo?.host ?? "";
  if (!host || !basePath) {
    return null;
  }
  return `${host}${basePath}${firstUrlInfo?.extra ?? ""}`;
}

function safelyParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function extractRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return input.toString();
}

function cloneHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  if (!next.has("content-type")) {
    next.set("content-type", "application/json");
  }
  return next;
}

function bufferSourceBytes(data: BufferSource): number {
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return data.byteLength;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)}${units[index]}`;
}

function priorityScore(priority: PrefetchPriority): number {
  switch (priority) {
    case "seek":
      return -1;
    case "playback":
      return 0;
    case "playlist":
      return 1;
    case "media":
    default:
      return 2;
  }
}

function shouldBoostSeekPrefetch(): boolean {
  return seekState.active && !seekState.targetBuffered && policy.vod.seekBoostWindow > 0;
}

function takeNextPrefetchTask(): PrefetchTask | undefined {
  if (!shouldBoostSeekPrefetch()) {
    return prefetchQueue.shift();
  }
  const boostedIndex = prefetchQueue.findIndex((task) => task.priority === "seek");
  if (boostedIndex >= 0) {
    const [task] = prefetchQueue.splice(boostedIndex, 1);
    return task;
  }
  const playbackIndex = prefetchQueue.findIndex((task) => task.priority === "playback" || task.kind === "media");
  if (playbackIndex >= 0) {
    const [task] = prefetchQueue.splice(playbackIndex, 1);
    return task;
  }
  return prefetchQueue.shift();
}

function resolveRangeSplitConcurrency(reason: RangeChunkTask["reason"]): number {
  const configured = Math.max(2, policy.vod.maxConcurrentRequests);
  if (reason === "seek") {
    return configured;
  }
  return Math.max(2, configured);
}

function detectPageKind(url: string): "vod" | "live" | "unknown" {
  if (/^https:\/\/live\.bilibili\.com\//.test(url)) {
    return "live";
  }
  if (/^https:\/\/www\.bilibili\.com\/video\//.test(url)) {
    return "vod";
  }
  return "unknown";
}

function buildStatus(partial: Partial<PageStatus>, recentTelemetry: TelemetryEvent[]): PageStatus {
  const recent = recentTelemetry.filter((event) => event.ts >= Date.now() - 60_000);
  const waitingCount1m = recent.filter(
    (event) => event.type === "playback" && event.event === "waiting",
  ).length;
  const stalledCount1m = recent.filter(
    (event) => event.type === "playback" && event.event === "stalled",
  ).length;

  return {
    pageKind: partial.pageKind ?? "unknown",
    mode: partial.mode ?? "stable",
    quality: partial.quality ?? null,
    codec: partial.codec ?? null,
    host: partial.host ?? null,
    protocol: partial.protocol ?? null,
    bufferedSeconds: partial.bufferedSeconds ?? 0,
    avgSegmentDurationMs: partial.avgSegmentDurationMs ?? 0,
    prefetchQueueDepth: partial.prefetchQueueDepth ?? 0,
    cacheBytes: partial.cacheBytes ?? 0,
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

function rankCodecPreference(
  candidates: Array<{ id: number; codecs: string; bandwidth?: number }>,
  preference: CodecPreference,
): Array<{ id: number; codecs: string; bandwidth?: number }> {
  const order =
    preference === "auto"
      ? ["avc", "hev", "hvc", "av01"]
      : preference === "avc"
        ? ["avc", "hev", "hvc", "av01"]
        : preference === "hevc"
          ? ["hev", "hvc", "avc", "av01"]
          : ["av01", "avc", "hev", "hvc"];

  return [...candidates].sort((a, b) => {
    const ai = codecPriority(a.codecs, order);
    const bi = codecPriority(b.codecs, order);
    if (ai !== bi) {
      return ai - bi;
    }
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  });
}

function codecPriority(codecs: string, order: string[]): number {
  const lower = codecs.toLowerCase();
  const idx = order.findIndex((item) => lower.includes(item));
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function sortLiveCandidates<T extends { protocolName: string; formatName: string; codecName: string }>(
  mode: PlaybackMode,
  candidates: T[],
): T[] {
  const stableOrder = ["fmp4", "flv", "ts"];
  const lowLatencyOrder = ["flv", "fmp4", "ts"];
  const chosen = mode === "lowLatency" ? lowLatencyOrder : stableOrder;

  return [...candidates].sort((a, b) => {
    const ap = chosen.findIndex((item) => item === a.formatName);
    const bp = chosen.findIndex((item) => item === b.formatName);
    const normalizedAp = ap === -1 ? Number.MAX_SAFE_INTEGER : ap;
    const normalizedBp = bp === -1 ? Number.MAX_SAFE_INTEGER : bp;
    if (normalizedAp !== normalizedBp) {
      return normalizedAp - normalizedBp;
    }
    return liveCodecScore(b.codecName) - liveCodecScore(a.codecName);
  });
}

function liveCodecScore(codecName: string): number {
  const lower = codecName.toLowerCase();
  if (lower.includes("avc")) {
    return 3;
  }
  if (lower.includes("hevc") || lower.includes("hev")) {
    return 2;
  }
  if (lower.includes("av1")) {
    return 1;
  }
  return 0;
}

function resolvePrefetchDecision(input: {
  preferredWindow: number;
  aggressivePrefetchSeconds: number;
  maxConcurrentRequests: number;
  quality: number | null;
  estimatedBitrate: number | null;
  avgSegmentDurationMs?: number | null;
  phase?: VodPrefetchPhase;
  remainingSeconds?: number | null;
}) {
  const highBitrateMode = (input.quality ?? 0) >= 1440 || (input.estimatedBitrate ?? 0) >= 8_000_000;
  const phase = input.phase ?? "steady";
  const baseWindow = Math.min(24, Math.max(4, input.preferredWindow || 4));
  const configuredTargetSeconds = 48;
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
    : Math.min(phase === "seek" ? 30 : phase === "initial" ? 24 : 18, Math.max(baseWindow, futureSegments + phaseBoost));
  const audioWindow = cacheEntireRemaining ? videoWindow : Math.min(18, Math.max(4, videoWindow));
  const totalConcurrency = Math.min(
    16,
    Math.max(
      8,
      Math.max(input.maxConcurrentRequests, phase === "seek" ? 16 : phase === "initial" ? 14 : Math.min(videoWindow + 2, 12)),
    ),
  );
  const bitrateEstimate = Math.max(
    2_500_000,
    input.estimatedBitrate ?? (highBitrateMode ? 12_000_000 : 5_000_000),
  );
  const cacheLimitBytes = clampNumber(
    Math.round((bitrateEstimate / 8) * Math.max(targetSeconds, 12) * (phase === "seek" ? 2.1 : 1.8)),
    highBitrateMode ? 192 * 1024 * 1024 : 96 * 1024 * 1024,
    highBitrateMode ? 1024 * 1024 * 1024 : 384 * 1024 * 1024,
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

function selectRecoveryAction(input: {
  pageKind: "vod" | "live" | "unknown";
  mode: PlaybackMode;
  bufferedSeconds: number;
  droppedFrames: number;
  backupHostsAvailable: boolean;
  enableProtocolFallback: boolean;
  hostFailures: number;
  repeatedStalls: number;
}): string {
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

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
