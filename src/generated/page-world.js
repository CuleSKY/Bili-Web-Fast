// Generated from src/page/index.ts. Do not edit directly.
"use strict";
const PAGE_MESSAGE_SOURCE = "bwf-page";
const DEFAULT_POLICY = {
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
const RECOVERY_LIMITS = {
    sameActionCooldownMs: 10_000,
    qualityDropCooldownMs: 30_000,
    rebuildCooldownMs: 60_000,
};
const pageKind = detectPageKind(location.href);
let policy = DEFAULT_POLICY;
const telemetry = [];
let overlay = null;
let overlayBody = null;
let overlayExpanded = true;
const recoveryTimestamps = new Map();
const hostFallbacks = new Map();
const hostFailures = new Map();
const hostHealth = new Map();
const hostFailureSamples = [];
const segmentDurations = [];
const mediaCache = new Map();
const inflightPrefetches = new Map();
const prefetchQueue = [];
const liveSeenSegments = new Set();
const nativeFetch = window.fetch.bind(window);
const inflightRangeRequests = new Map();
const activeMediaFetches = new Set();
const downloadSamples = [];
let prefetchActive = 0;
let cacheBytes = 0;
let prefetchHitCount = 0;
let rangeChunkRetryCount = 0;
let lastMediaUrl = null;
let activeRangeChunkJobs = 0;
let lastBufferedRangeEnd = 0;
let downloadController = {
    downloadPhase: "initial",
    targetBufferSeconds: 48,
    controllerTargetConcurrency: 14,
    controllerAppliedConcurrency: 14,
    recentThroughputBps: 0,
    recentErrorRate: 0,
    recentRetryRate: 0,
    recentBytesPerRequest: 0,
    avgVodSegmentSeconds: 4,
    activeSegmentDownloads: 0,
    lastControllerTickMs: 0,
    lowGainStreak: 0,
    previousThroughputBps: 0,
};
let vodSelection = {
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
let liveSelection = {
    quality: null,
    protocol: null,
    protocolCandidates: [],
};
let seekState = {
    active: false,
    startedAt: 0,
    targetTime: 0,
    targetBuffered: true,
    resolvedAt: null,
};
const state = buildStatus({
    pageKind,
    mode: DEFAULT_POLICY.mode,
    downloadPhase: "initial",
    targetBufferSeconds: pageKind === "live" ? DEFAULT_POLICY.live.stableBufferTargetSeconds : 48,
    avgSegmentDurationMs: 0,
    avgVodSegmentSeconds: 4,
    prefetchQueueDepth: 0,
    cacheBytes: 0,
    controllerConcurrency: 14,
    recentThroughputMbps: 0,
    activeSegmentDownloads: 0,
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
}, telemetry);
document.documentElement.dataset.bwfPage = "booting";
try {
    installBridge();
    installFetchHook();
    installXhrHook();
    installMediaHooks();
    installMseHooks();
    installDebugSurface();
    installDownloadController();
    publishStatus();
    document.documentElement.dataset.bwfPage = "ready";
}
catch (error) {
    document.documentElement.dataset.bwfPage = "error";
    document.documentElement.dataset.bwfPageError =
        error instanceof Error ? `${error.name}:${error.message}` : String(error);
    throw error;
}
function installBridge() {
    window.addEventListener("message", (event) => {
        if (event.source !== window) {
            return;
        }
        const data = event.data;
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
function installFetchHook() {
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
        if (resourceKind === "media") {
            activeMediaFetches.add(requestUrl);
        }
        let response;
        let finalUrl;
        let usedSplitResponse = false;
        try {
            const splitResponse = resourceKind === "media" ? await maybeServeMediaWithRangeSplit(requestUrl, input, init) : null;
            usedSplitResponse = Boolean(splitResponse);
            const resolved = splitResponse
                ? { response: splitResponse, finalUrl: requestUrl }
                : await performFetchWithFallback(nativeFetch, input, init, requestUrl, resourceKind);
            response = resolved.response;
            finalUrl = resolved.finalUrl;
        }
        finally {
            if (resourceKind === "media") {
                activeMediaFetches.delete(requestUrl);
            }
        }
        const responseForPage = await maybeRewriteFetchResponse(requestUrl, response);
        const durationMs = Math.round(performance.now() - started);
        const clone = responseForPage.clone();
        noteActiveMediaHost(finalUrl, resourceKind);
        noteHostSuccess(finalUrl, durationMs);
        if (resourceKind === "media" && !usedSplitResponse) {
            const sampleBytes = Number(responseForPage.headers.get("content-length") ?? "0");
            recordDownloadSample({
                ts: Date.now(),
                ok: responseForPage.ok,
                bytes: responseForPage.ok && Number.isFinite(sampleBytes) ? sampleBytes : 0,
                retry: false,
                durationMs,
            });
        }
        if (resourceKind === "media" && responseForPage.ok) {
            void storeFetchedMediaResponse(finalUrl, responseForPage.clone());
        }
        void handleFetchResponse(finalUrl, resourceKind, clone, durationMs);
        if (resourceKind === "media" && responseForPage.ok) {
            noteSegmentDuration(durationMs);
            scheduleVodPrefetch(finalUrl);
        }
        else if (resourceKind === "playlist" && responseForPage.ok) {
            void scheduleLivePlaylistPrefetch(finalUrl, responseForPage.clone());
        }
        return responseForPage;
    };
}
function installXhrHook() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function open(method, url, async, username, password) {
        const originalUrl = String(url);
        this.__bwfUrl = originalUrl;
        return originalOpen.call(this, method, originalUrl, async ?? true, username, password);
    };
    XMLHttpRequest.prototype.send = function send(body) {
        this.__bwfStart = performance.now();
        this.addEventListener("loadend", () => {
            const duration = Math.round(performance.now() - (this.__bwfStart ?? performance.now()));
            const url = this.__bwfUrl ?? "";
            emitNetworkEvent(classifyResource(url), url, duration, this.status >= 200 && this.status < 400, undefined, `xhr:${this.status}`);
            if (this.status >= 400) {
                noteHostFailure(url);
            }
        });
        return originalSend.call(this, body);
    };
}
function installMediaHooks() {
    const attached = new WeakSet();
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
function installMseHooks() {
    const mediaSourceProto = window.MediaSource?.prototype;
    const sourceBufferProto = window.SourceBuffer?.prototype;
    if (!mediaSourceProto || !sourceBufferProto) {
        return;
    }
    const originalAddSourceBuffer = mediaSourceProto.addSourceBuffer;
    mediaSourceProto.addSourceBuffer = function addSourceBuffer(mimeType) {
        const buffer = originalAddSourceBuffer.call(this, mimeType);
        patchSourceBuffer(buffer, mimeType);
        return buffer;
    };
}
function patchSourceBuffer(buffer, mimeType) {
    const originalAppendBuffer = buffer.appendBuffer.bind(buffer);
    if (buffer.__bwfPatched) {
        return;
    }
    buffer.__bwfPatched = true;
    buffer.appendBuffer = ((data) => {
        const started = performance.now();
        const bytes = bufferSourceBytes(data);
        const finalize = (ok, detail) => {
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
        }
        catch (error) {
            cleanup();
            finalize(false, `appendBuffer:throw:${error instanceof Error ? error.name : "unknown"}`);
            throw error;
        }
    });
}
async function handleFetchResponse(url, resourceKind, response, durationMs) {
    const bytesHeader = response.headers.get("content-length");
    const bytes = bytesHeader ? Number(bytesHeader) : undefined;
    emitNetworkEvent(resourceKind, url, durationMs, response.ok, bytes);
    if (resourceKind === "playurl" && response.ok) {
        const json = await response.json().catch(() => null);
        if (json) {
            handleVodPlayurl(json);
        }
    }
    else if (resourceKind === "livePlayInfo" && response.ok) {
        const json = await response.json().catch(() => null);
        if (json) {
            handleLivePlayInfo(json);
        }
    }
    else if (resourceKind === "media" && response.ok) {
        await storeFetchedMediaResponse(url, response);
    }
}
function handleVodPlayurl(payload) {
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
    const filteredVideos = preferredQuality != null
        ? videos.filter((item) => item.id === preferredQuality)
        : videos;
    const candidates = filteredVideos.length > 0 ? filteredVideos : videos;
    const ranked = rankCodecPreference(candidates.map((item) => ({
        id: item.id,
        codecs: item.codecs ?? "",
        bandwidth: item.bandwidth,
        width: item.width,
        height: item.height,
    })), resolveVodCodecPreference());
    const top = ranked[0];
    const chosenVideo = candidates.find((item) => item.id === top?.id && item.codecs === top?.codecs) ?? candidates[0];
    const chosenAudio = audios[0] ?? null;
    if (!chosenVideo) {
        return;
    }
    const availableCodecsByQuality = new Map();
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
        availableQualities: [...new Set(videos.map((item) => Number(item.id)).filter((item) => Number.isFinite(item)))].sort((a, b) => b - a),
        availableCodecsByQuality,
        currentTrackPaths: [chosenVideo.baseUrl ?? chosenVideo.base_url, chosenAudio?.baseUrl ?? chosenAudio?.base_url]
            .filter((item) => Boolean(item))
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
function handleLivePlayInfo(payload) {
    const playurl = payload?.data?.playurl_info?.playurl;
    const streams = playurl?.stream;
    if (!Array.isArray(streams)) {
        return;
    }
    const candidates = [];
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
    const original = candidates.find((item) => item.stream.protocol_name === best.protocolName &&
        item.format.format_name === best.formatName &&
        item.codec.codec_name === best.codecName);
    if (!original) {
        return;
    }
    const urlInfos = original.codec.url_info ?? [];
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
function updateBuffered(video) {
    const buffered = video.buffered;
    if (buffered.length > 0) {
        state.bufferedSeconds = Math.max(0, buffered.end(buffered.length - 1) - video.currentTime);
        if (pageKind === "vod") {
            const bufferedEnd = buffered.end(buffered.length - 1);
            if (bufferedEnd + 1 < lastBufferedRangeEnd) {
                lastBufferedRangeEnd = bufferedEnd;
            }
            const delta = bufferedEnd - lastBufferedRangeEnd;
            if (delta > 0.25 && delta < 20) {
                downloadController.avgVodSegmentSeconds = clampNumber(downloadController.avgVodSegmentSeconds * 0.75 + delta * 0.25, 1, 8);
                lastBufferedRangeEnd = bufferedEnd;
            }
            else if (delta >= 20) {
                lastBufferedRangeEnd = bufferedEnd;
            }
        }
    }
    else {
        state.bufferedSeconds = 0;
    }
    publishStatus();
}
function updateDroppedFrames(video) {
    const quality = video.getVideoPlaybackQuality?.();
    state.droppedFrames = quality?.droppedVideoFrames ?? state.droppedFrames;
}
function maybeRecover(reason, video) {
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
    const event = {
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
async function executeRecovery(action, video) {
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
function pushPlayback(event, detail) {
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
function emitTelemetry(event) {
    telemetry.push(event);
    while (telemetry.length > policy.diagnostics.logLimit) {
        telemetry.shift();
    }
    window.postMessage({ source: PAGE_MESSAGE_SOURCE, kind: "telemetry", event }, "*");
}
function emitControl(action, detail) {
    const event = {
        type: "control",
        ts: Date.now(),
        url: location.href,
        pageKind,
        action,
        detail,
    };
    emitTelemetry(event);
}
function emitNetworkEvent(resourceKind, resourceUrl, durationMs, ok, bytes, detail) {
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
function publishStatus() {
    updateDerivedMetrics();
    const next = buildStatus(state, telemetry);
    Object.assign(state, next);
    updateOverlay();
    window.postMessage({ source: PAGE_MESSAGE_SOURCE, kind: "status", status: next }, "*");
}
function updateDerivedMetrics() {
    refreshDownloadController();
    state.avgSegmentDurationMs =
        segmentDurations.length > 0
            ? Math.round(segmentDurations.reduce((sum, value) => sum + value, 0) / segmentDurations.length)
            : 0;
    state.prefetchQueueDepth = prefetchQueue.length + inflightPrefetches.size;
    state.cacheBytes = cacheBytes;
    state.downloadPhase = downloadController.downloadPhase;
    state.targetBufferSeconds = downloadController.targetBufferSeconds;
    state.avgVodSegmentSeconds = downloadController.avgVodSegmentSeconds;
    state.controllerConcurrency = downloadController.controllerAppliedConcurrency;
    state.recentThroughputMbps = downloadController.recentThroughputBps / 1_000_000;
    state.activeSegmentDownloads = downloadController.activeSegmentDownloads;
    state.activeRangeJobs = inflightRangeRequests.size + activeRangeChunkJobs;
    state.prefetchHitCount = prefetchHitCount;
    state.rangeChunkRetryCount = rangeChunkRetryCount;
    state.rangeSplitActive = inflightRangeRequests.size + activeRangeChunkJobs > 0;
    state.seekInProgress = seekState.active;
    state.lastSeekTargetBuffered = seekState.targetBuffered;
    state.activeMediaHost = parseHost(lastMediaUrl) ?? state.host;
    state.hostHealthSummary = summarizeHostHealth();
    state.targetQualitySatisfied = isTargetQualitySatisfied();
    state.liveBufferTier = classifyLiveBufferTier(state.bufferedSeconds);
}
function updateOverlay() {
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
            `phase=${state.downloadPhase} buffer=${state.bufferedSeconds.toFixed(2)}s target=${state.targetBufferSeconds.toFixed(1)}s ready=${currentReadyState()}`,
            `seg=${state.avgSegmentDurationMs}ms vodSeg=${state.avgVodSegmentSeconds.toFixed(2)}s prefetch=${state.prefetchQueueDepth} cache=${formatBytes(state.cacheBytes)}`,
            `concurrency=${state.controllerConcurrency} throughput=${state.recentThroughputMbps.toFixed(1)}Mbps segmentDl=${state.activeSegmentDownloads}`,
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
function installDebugSurface() {
    window.__BWF_DEBUG__ = {
        getStatus: () => ({ ...state }),
        getPolicy: () => structuredClone(policy),
        getMetrics: () => ({
            cacheBytes,
            cacheEntries: mediaCache.size,
            prefetchQueueDepth: prefetchQueue.length + inflightPrefetches.size,
            hostFallbacks: 0,
            activeRangeJobs: inflightRangeRequests.size + activeRangeChunkJobs,
            mode: state.mode,
        }),
        setMode: (mode) => {
            emitControl("debug-set-mode", mode);
            window.postMessage({ source: PAGE_MESSAGE_SOURCE, kind: "runtimeCommand", command: "setMode", mode }, "*");
        },
        toggleOverlay: () => {
            overlayExpanded = !overlayExpanded;
            emitControl("debug-toggle-overlay", overlayExpanded ? "expanded" : "collapsed");
            updateOverlay();
        },
    };
}
function installDownloadController() {
    window.setInterval(() => {
        refreshDownloadController();
        if (pageKind === "live" || prefetchQueue.length > 0 || prefetchActive > 0 || inflightRangeRequests.size > 0) {
            publishStatus();
        }
    }, 500);
}
function refreshDownloadController(force = false) {
    const now = Date.now();
    if (!force && now - downloadController.lastControllerTickMs < 500) {
        return;
    }
    const phase = resolveDownloadPhase();
    const targetBufferSeconds = resolveTargetBufferSeconds(phase);
    trimDownloadSamples(now);
    const successful = downloadSamples.filter((sample) => sample.ok);
    const failed = downloadSamples.filter((sample) => !sample.ok);
    const retried = downloadSamples.filter((sample) => sample.retry);
    const throughputBytes = successful.reduce((sum, sample) => sum + sample.bytes, 0);
    const recentThroughputBps = throughputBytes / 2;
    const totalSamples = downloadSamples.length;
    const recentErrorRate = totalSamples > 0 ? failed.length / totalSamples : 0;
    const recentRetryRate = totalSamples > 0 ? retried.length / totalSamples : 0;
    const recentBytesPerRequest = successful.length > 0
        ? successful.reduce((sum, sample) => sum + sample.bytes, 0) / successful.length
        : 0;
    const activeSegmentDownloads = prefetchActive + inflightRangeRequests.size;
    const queueDepth = prefetchQueue.length + activeSegmentDownloads;
    const base = resolveControllerBaseline(phase);
    const decision = resolveControllerDecision({
        minConcurrency: base.minConcurrency,
        maxConcurrency: Math.min(policy.vod.maxConcurrentRequests, base.maxConcurrency),
        currentConcurrency: downloadController.controllerAppliedConcurrency,
        previousThroughputBps: downloadController.previousThroughputBps,
        recentThroughputBps,
        recentErrorRate,
        queueDepth,
        lowGainStreak: downloadController.lowGainStreak,
        bufferedSeconds: state.bufferedSeconds,
        targetBufferSeconds,
        seekUrgent: phase === "seek" && seekState.active && !seekState.targetBuffered,
        liveUrgent: phase === "liveUrgent",
        cacheSatisfied: cacheBytes >= resolveCacheTargetBytes(phase, targetBufferSeconds),
    });
    downloadController = {
        downloadPhase: phase,
        targetBufferSeconds,
        controllerTargetConcurrency: decision.nextConcurrency,
        controllerAppliedConcurrency: decision.nextConcurrency,
        recentThroughputBps,
        recentErrorRate,
        recentRetryRate,
        recentBytesPerRequest,
        avgVodSegmentSeconds: resolveAvgVodSegmentSeconds(),
        activeSegmentDownloads,
        lastControllerTickMs: now,
        lowGainStreak: decision.nextLowGainStreak,
        previousThroughputBps: recentThroughputBps,
    };
}
function recordDownloadSample(sample) {
    downloadSamples.push(sample);
    trimDownloadSamples(sample.ts);
}
function trimDownloadSamples(now) {
    while (downloadSamples.length > 0 && now - downloadSamples[0].ts > 2_000) {
        downloadSamples.shift();
    }
}
function resolveDownloadPhase() {
    if (pageKind === "live") {
        return state.bufferedSeconds < 1.5 ? "liveUrgent" : "steady";
    }
    if (seekState.active && !seekState.targetBuffered) {
        return "seek";
    }
    const video = document.querySelector("video");
    const currentTime = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    if (segmentDurations.length < 2 || currentTime < 3 || state.bufferedSeconds < 4) {
        return "initial";
    }
    return "steady";
}
function resolveTargetBufferSeconds(phase) {
    if (phase === "liveUrgent") {
        return 1.5;
    }
    if (pageKind === "live") {
        return policy.live.stableBufferTargetSeconds;
    }
    const remainingSeconds = getVodPrefetchContext().remainingSeconds;
    if (remainingSeconds != null && remainingSeconds > 0) {
        return Math.min(48, remainingSeconds);
    }
    return 48;
}
function resolveControllerBaseline(phase) {
    if (phase === "seek") {
        return { minConcurrency: 12, maxConcurrency: 24, startConcurrency: 18 };
    }
    if (phase === "initial") {
        return { minConcurrency: 10, maxConcurrency: 20, startConcurrency: 14 };
    }
    if (phase === "liveUrgent") {
        return { minConcurrency: 8, maxConcurrency: 16, startConcurrency: 16 };
    }
    return { minConcurrency: 8, maxConcurrency: 16, startConcurrency: 10 };
}
function resolveControllerDecision(input) {
    if (input.seekUrgent || input.liveUrgent) {
        return {
            nextConcurrency: input.maxConcurrency,
            nextLowGainStreak: 0,
        };
    }
    if (input.queueDepth <= 0) {
        if (input.bufferedSeconds > input.targetBufferSeconds + 8 && input.cacheSatisfied) {
            return {
                nextConcurrency: input.minConcurrency,
                nextLowGainStreak: 0,
            };
        }
        return {
            nextConcurrency: clampNumber(input.currentConcurrency, input.minConcurrency, input.maxConcurrency),
            nextLowGainStreak: 0,
        };
    }
    const throughputGain = input.previousThroughputBps > 0
        ? (input.recentThroughputBps - input.previousThroughputBps) / input.previousThroughputBps
        : input.recentThroughputBps > 0
            ? 1
            : 0;
    if (input.recentErrorRate >= 0.05) {
        return {
            nextConcurrency: clampNumber(input.currentConcurrency - 2, input.minConcurrency, input.maxConcurrency),
            nextLowGainStreak: 0,
        };
    }
    if (throughputGain >= 0.08 && input.recentErrorRate < 0.03) {
        return {
            nextConcurrency: clampNumber(input.currentConcurrency + 2, input.minConcurrency, input.maxConcurrency),
            nextLowGainStreak: 0,
        };
    }
    const nextLowGainStreak = Math.abs(throughputGain) < 0.03 ? input.lowGainStreak + 1 : 0;
    if (nextLowGainStreak >= 3) {
        return {
            nextConcurrency: clampNumber(input.currentConcurrency - 2, input.minConcurrency, input.maxConcurrency),
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
        nextConcurrency: clampNumber(input.currentConcurrency, input.minConcurrency, input.maxConcurrency),
        nextLowGainStreak,
    };
}
function resolveAvgVodSegmentSeconds() {
    return clampNumber(downloadController.avgVodSegmentSeconds || 4, 1, 8);
}
function resolveCacheTargetBytes(phase, windowSeconds) {
    const bitrateEstimate = Math.max(2_500_000, vodSelection.bitrate ?? 5_000_000);
    const highBitrateMode = (state.quality ?? 0) >= 1440 || bitrateEstimate >= 8_000_000;
    const multiplier = phase === "seek" ? 2.1 : phase === "initial" ? 1.9 : 1.6;
    return clampNumber(Math.round((bitrateEstimate / 8) * windowSeconds * multiplier), highBitrateMode ? 256 * 1024 * 1024 : 128 * 1024 * 1024, 1024 * 1024 * 1024);
}
function classifyResource(url) {
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
async function maybeRewriteFetchResponse(url, response) {
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
function rewriteVodPayload(payload) {
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
        const sameQuality = videos.filter((item) => item.id === policy.vod.preferredQuality);
        if (sameQuality.length > 0) {
            candidates = sameQuality;
        }
    }
    const ranked = rankCodecPreference(candidates.map((item) => ({
        id: item.id,
        codecs: item.codecs ?? "",
        bandwidth: item.bandwidth,
        width: item.width,
        height: item.height,
    })), resolveVodCodecPreference());
    const selected = candidates.find((item) => item.id === ranked[0]?.id && item.codecs === ranked[0]?.codecs) ??
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
function rewriteLivePayload(payload) {
    const playurl = payload?.data?.playurl_info?.playurl;
    if (!playurl?.stream) {
        return payload;
    }
    const candidates = [];
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
    const chosen = candidates.find((item) => item.stream.protocol_name === selected.protocolName &&
        item.format.format_name === selected.formatName &&
        item.codec.codec_name === selected.codecName);
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
function rankLiveCandidates(candidates) {
    const filtered = candidates.filter((item) => {
        if (policy.live.preferredQuality != null && item.codec.current_qn !== policy.live.preferredQuality) {
            return false;
        }
        return true;
    });
    const pool = filtered.length > 0 ? filtered : candidates;
    const sorted = sortLiveCandidates(state.mode === "off" ? "stable" : state.mode, pool.map((item) => ({
        protocolName: item.stream.protocol_name ?? "",
        formatName: item.format.format_name ?? "",
        codecName: item.codec.codec_name ?? "",
    })));
    return preferLiveProtocol(sorted, policy.live.preferredProtocol);
}
function preferLiveProtocol(candidates, preferredProtocol) {
    if (preferredProtocol === "auto") {
        return candidates;
    }
    return [...candidates].sort((a, b) => {
        const ap = Number(a.formatName !== preferredProtocol);
        const bp = Number(b.formatName !== preferredProtocol);
        return ap - bp;
    });
}
function resolveVodCodecPreference() {
    if (pageKind === "vod") {
        return policy.vod.codecPreference;
    }
    return "auto";
}
function scheduleVodPrefetch(currentUrl) {
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
async function scheduleLivePlaylistPrefetch(playlistUrl, response) {
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
function getVodPrefetchContext() {
    const video = document.querySelector("video");
    const currentTime = video && Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : null;
    const durationSeconds = video && Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : vodSelection.durationSeconds;
    const remainingSeconds = durationSeconds != null
        ? Math.max(0, durationSeconds - (currentTime ?? 0))
        : null;
    const resolvedPhase = resolveDownloadPhase();
    const phase = resolvedPhase === "seek" || resolvedPhase === "initial" ? resolvedPhase : "steady";
    return {
        phase,
        currentTime,
        durationSeconds,
        remainingSeconds,
    };
}
function resolveVodDurationSeconds(payload) {
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
function estimateVodSegmentDurationMs(_context) {
    return Math.round(resolveAvgVodSegmentSeconds() * 1000);
}
function buildVodPrefetchTasks(currentUrl, decision, context) {
    const tasks = [];
    const priority = context.phase === "seek" ? "seek" : "media";
    const boostCount = context.phase === "seek" ? Math.max(4, policy.vod.seekBoostWindow) : 0;
    const currentTrack = inferVodTrack(currentUrl);
    const currentWindow = currentTrack === "audio" ? decision.audioWindow : decision.videoWindow;
    queueTask(tasks, currentUrl, priority);
    appendTrackPrefetchTasks(tasks, currentUrl, Math.max(0, currentWindow - 1), priority, boostCount);
    const currentSequence = extractUrlSequence(currentUrl);
    if (currentSequence != null) {
        const counterpartBaseUrl = currentTrack === "audio" ? vodSelection.videoBaseUrl : vodSelection.audioBaseUrl;
        const counterpartWindow = currentTrack === "audio" ? decision.videoWindow : decision.audioWindow;
        if (counterpartBaseUrl) {
            const counterpartCurrent = replaceUrlSequence(counterpartBaseUrl, currentSequence);
            if (counterpartCurrent) {
                queueTask(tasks, counterpartCurrent, priority);
            }
            appendTrackPrefetchTasks(tasks, counterpartCurrent ?? counterpartBaseUrl, Math.max(0, counterpartWindow - 1), priority, boostCount);
        }
    }
    return tasks;
}
function appendTrackPrefetchTasks(tasks, baseUrl, windowCount, priority, boostCount) {
    const futureUrls = inferNextSequenceUrls(baseUrl, windowCount);
    for (const [index, url] of futureUrls.entries()) {
        const taskPriority = index < boostCount ? "seek" : priority;
        queueTask(tasks, url, taskPriority);
    }
}
function queueTask(tasks, url, priority) {
    if (tasks.some((task) => task.url === url)) {
        return;
    }
    tasks.push({ url, kind: "media", priority });
}
function extractUrlSequence(url) {
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
function replaceUrlSequence(templateUrl, sequence) {
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
function queuePrefetch(task) {
    const normalized = task.url;
    if (mediaCache.has(normalized) || inflightPrefetches.has(normalized) || activeMediaFetches.has(normalized)) {
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
function drainPrefetchQueue() {
    const concurrency = Math.max(1, downloadController.controllerAppliedConcurrency);
    while (prefetchActive < concurrency && prefetchQueue.length > 0) {
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
async function runPrefetch(task) {
    const rangeEntry = task.kind === "media" && pageKind === "vod" ? await downloadPrefetchByRange(task) : null;
    if (rangeEntry) {
        storeCacheEntry(rangeEntry);
        return rangeEntry;
    }
    const started = performance.now();
    const response = await nativeFetch(task.url, { cache: "no-store", credentials: "include" });
    const durationMs = Math.round(performance.now() - started);
    if (!response.ok) {
        noteHostFailure(task.url);
        emitNetworkEvent("prefetch", task.url, durationMs, false, undefined, task.priority);
        recordDownloadSample({ ts: Date.now(), ok: false, bytes: 0, retry: false, durationMs });
        return null;
    }
    noteHostSuccess(task.url, durationMs);
    const body = await response.arrayBuffer();
    recordDownloadSample({ ts: Date.now(), ok: true, bytes: body.byteLength, retry: false, durationMs });
    const entry = {
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
async function downloadPrefetchByRange(task) {
    const probe = await probeRangeSupport(task.url);
    if (!probe) {
        return null;
    }
    const tasks = [];
    for (let start = 0; start < probe.contentLength; start += 2 * 1024 * 1024) {
        const end = Math.min(probe.contentLength - 1, start + 2 * 1024 * 1024 - 1);
        tasks.push({
            url: task.url,
            start,
            end,
            bytesTotal: probe.contentLength,
            reason: task.priority === "seek" ? "seek" : "playback",
        });
    }
    const buffers = await runRangeChunkTasks(tasks, undefined, resolveRangeSplitConcurrency(tasks[0]?.reason ?? "playback"));
    if (buffers.some((buffer) => buffer == null)) {
        return null;
    }
    const body = concatArrayBuffers(buffers);
    const durationMs = 0;
    emitNetworkEvent("prefetch", task.url, durationMs, true, body.byteLength, `range:${tasks.length}`);
    return {
        url: task.url,
        body,
        status: 200,
        statusText: "OK",
        headers: [...probe.headers.entries()],
        bytes: body.byteLength,
        createdAt: Date.now(),
        source: "range",
    };
}
async function probeRangeSupport(url, init) {
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
    return { contentLength, headers: cloneHeaders(head.headers) };
}
function takeCachedResponse(url) {
    const entry = mediaCache.get(url);
    if (!entry) {
        return null;
    }
    mediaCache.delete(url);
    cacheBytes = Math.max(0, cacheBytes - entry.bytes);
    updateDerivedMetrics();
    return responseFromCache(entry);
}
async function takeInflightPrefetch(url) {
    const entry = inflightPrefetches.get(url);
    if (!entry) {
        return null;
    }
    return entry;
}
function responseFromCache(entry) {
    return new Response(entry.body.slice(0), {
        status: entry.status,
        statusText: entry.statusText,
        headers: new Headers(entry.headers),
    });
}
async function storeFetchedMediaResponse(url, response) {
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
async function maybeServeMediaWithRangeSplit(url, input, init) {
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
function shouldUseRangeSplit(url, init) {
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
async function runRangeSplitRequest(url, _input, init) {
    const probe = await probeRangeSupport(url, init);
    if (!probe) {
        return null;
    }
    const tasks = [];
    for (let start = 0; start < probe.contentLength; start += 2 * 1024 * 1024) {
        const end = Math.min(probe.contentLength - 1, start + 2 * 1024 * 1024 - 1);
        tasks.push({
            url,
            start,
            end,
            bytesTotal: probe.contentLength,
            reason: seekState.active && !seekState.targetBuffered ? "seek" : "playback",
        });
    }
    const concurrency = resolveRangeSplitConcurrency(tasks[0]?.reason ?? "playback");
    const buffers = await runRangeChunkTasks(tasks, init, concurrency);
    if (buffers.some((buffer) => buffer == null)) {
        return null;
    }
    const merged = concatArrayBuffers(buffers);
    emitNetworkEvent("media", url, 0, true, merged.byteLength, `range-split:${tasks.length}`);
    return new Response(merged, {
        status: 200,
        statusText: "OK",
        headers: probe.headers,
    });
}
async function fetchRangeChunk(task, init) {
    const headers = cloneRequestHeaders(init?.headers);
    headers.set("range", `bytes=${task.start}-${task.end}`);
    const started = performance.now();
    activeRangeChunkJobs += 1;
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
            recordDownloadSample({ ts: Date.now(), ok: false, bytes: 0, retry: false, durationMs });
            return retryRangeChunk(task, init);
        }
        noteHostSuccess(task.url, durationMs);
        const body = await response.arrayBuffer();
        recordDownloadSample({ ts: Date.now(), ok: true, bytes: body.byteLength, retry: false, durationMs });
        return body;
    }
    catch {
        noteHostFailure(task.url);
        noteHostCooldown(task.url);
        recordDownloadSample({ ts: Date.now(), ok: false, bytes: 0, retry: false, durationMs: Math.round(performance.now() - started) });
        return retryRangeChunk(task, init);
    }
    finally {
        activeRangeChunkJobs = Math.max(0, activeRangeChunkJobs - 1);
    }
}
async function retryRangeChunk(task, init) {
    rangeChunkRetryCount += 1;
    const headers = cloneRequestHeaders(init?.headers);
    headers.set("range", `bytes=${task.start}-${task.end}`);
    const started = performance.now();
    activeRangeChunkJobs += 1;
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
        recordDownloadSample({ ts: Date.now(), ok: false, bytes: 0, retry: true, durationMs });
        activeRangeChunkJobs = Math.max(0, activeRangeChunkJobs - 1);
        return null;
    }
    noteHostSuccess(task.url, durationMs);
    const body = await response.arrayBuffer();
    recordDownloadSample({ ts: Date.now(), ok: true, bytes: body.byteLength, retry: true, durationMs });
    activeRangeChunkJobs = Math.max(0, activeRangeChunkJobs - 1);
    return body;
}
async function runRangeChunkTasks(tasks, init, concurrency) {
    const results = new Array(tasks.length).fill(null);
    let nextIndex = 0;
    async function worker() {
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
function concatArrayBuffers(buffers) {
    const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const buffer of buffers) {
        merged.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return merged.buffer;
}
function cloneRequestHeaders(headers) {
    const next = new Headers();
    if (!headers) {
        return next;
    }
    new Headers(headers).forEach((value, key) => next.set(key, value));
    return next;
}
function hasRangeHeader(headers) {
    if (!headers) {
        return false;
    }
    return new Headers(headers).has("range");
}
function storeCacheEntry(entry) {
    if (mediaCache.has(entry.url)) {
        const previous = mediaCache.get(entry.url);
        if (previous) {
            cacheBytes = Math.max(0, cacheBytes - previous.bytes);
        }
    }
    mediaCache.set(entry.url, entry);
    cacheBytes += entry.bytes;
    evictCache(resolveCacheTargetBytes(downloadController.downloadPhase, downloadController.targetBufferSeconds));
    updateDerivedMetrics();
}
function evictCache(limitBytes) {
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
async function performFetchWithFallback(nativeFetch, input, init, _originalUrl, resourceKind) {
    const firstUrl = extractRequestUrl(input);
    try {
        const response = await nativeFetch(input, init);
        if (response.ok || (resourceKind !== "media" && resourceKind !== "playlist")) {
            return { response, finalUrl: firstUrl };
        }
        noteHostFailure(firstUrl);
        return { response, finalUrl: firstUrl };
    }
    catch (error) {
        if (resourceKind !== "media" && resourceKind !== "playlist") {
            throw error;
        }
        noteHostFailure(firstUrl);
        throw error;
    }
}
function rewriteRequestInfo(input, nextUrl) {
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
function noteHostFailure(url) {
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
function noteHostSuccess(url, durationMs) {
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
function noteHostCooldown(url) {
    const host = parseHost(url);
    if (!host) {
        return;
    }
    const health = hostHealth.get(host) ?? emptyHostHealth();
    health.cooldownUntil = Date.now() + (pageKind === "live" ? policy.live.hostCooldownMs : policy.vod.hostCooldownMs);
    hostHealth.set(host, health);
}
function totalHostFailures() {
    trimHostFailureSamples(Date.now());
    return [...hostFailures.values()].reduce((sum, value) => sum + value, 0);
}
function recentHostFailures(windowMs = 90_000) {
    const now = Date.now();
    trimHostFailureSamples(now, windowMs);
    return hostFailureSamples.length;
}
function trimHostFailureSamples(now, windowMs = 90_000) {
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
        }
        else {
            hostFailures.set(host, nextCount);
        }
    }
}
function noteActiveMediaHost(url, resourceKind) {
    if (resourceKind !== "media" && resourceKind !== "playlist") {
        return;
    }
    lastMediaUrl = url;
    if (resourceKind === "media" || pageKind === "live") {
        state.host = parseHost(url);
    }
}
function emptyHostHealth() {
    return {
        successCount: 0,
        failureCount: 0,
        totalDurationMs: 0,
        cooldownUntil: 0,
        lastFailureAt: 0,
        lastSuccessAt: 0,
    };
}
function inferNextSequenceUrls(url, count) {
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
    const urls = [];
    for (let step = 1; step <= count; step += 1) {
        const next = new URL(parsed.toString());
        next.pathname = `${prefix}${String(current + step)}${suffix}`;
        urls.push(next.toString());
    }
    return urls;
}
function inferVodTrack(url) {
    const pathKey = pathKeyFromUrl(url);
    if (vodSelection.currentTrackPaths.some((item) => item === pathKey && /audio/i.test(item))) {
        return "audio";
    }
    if (/audio/i.test(url)) {
        return "audio";
    }
    return "video";
}
function parsePlaylistUrls(baseUrl, text) {
    const results = [];
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
function currentReadyState() {
    const video = document.querySelector("video");
    return video?.readyState ?? 0;
}
function nextLowerQuality(currentQuality) {
    if (currentQuality == null) {
        return null;
    }
    const currentIndex = vodSelection.availableQualities.findIndex((item) => item === currentQuality);
    if (currentIndex === -1 || currentIndex === vodSelection.availableQualities.length - 1) {
        return null;
    }
    return vodSelection.availableQualities[currentIndex + 1] ?? null;
}
function nextLiveProtocolPreference() {
    const current = policy.live.preferredProtocol;
    return current === "flv"
        ? "fmp4"
        : current === "fmp4"
            ? "flv"
            : state.protocol?.includes("flv")
                ? "fmp4"
                : "flv";
}
function requestPolicyPatch(patch) {
    policy = mergePolicyPatch(policy, patch);
    window.postMessage({
        source: PAGE_MESSAGE_SOURCE,
        kind: "policyPatch",
        patch,
    }, "*");
    window.postMessage({
        source: PAGE_MESSAGE_SOURCE,
        kind: "telemetry",
        event: {
            type: "control",
            ts: Date.now(),
            url: location.href,
            pageKind,
            action: "policy-patch",
            detail: JSON.stringify(Object.keys(patch)),
        },
    }, "*");
}
function mergePolicyPatch(current, patch) {
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
function attemptPlayerMethod(methods, arg) {
    const objects = [
        window.player,
        window.bpxPlayer,
        window.bilibiliPlayer,
        window.__BILI_PLAYER__,
    ].filter(Boolean);
    for (const object of objects) {
        for (const method of methods) {
            const candidate = object[method];
            if (typeof candidate === "function") {
                try {
                    candidate(arg);
                    return true;
                }
                catch {
                    continue;
                }
            }
        }
    }
    return false;
}
function currentPlayerQuality() {
    const objects = [
        window.player,
        window.bpxPlayer,
        window.bilibiliPlayer,
        window.__BILI_PLAYER__,
    ].filter(Boolean);
    for (const object of objects) {
        for (const method of ["getQuality", "getCurrentQuality"]) {
            const candidate = object[method];
            if (typeof candidate !== "function") {
                continue;
            }
            try {
                const value = Number(candidate());
                if (Number.isFinite(value) && value > 0) {
                    return value;
                }
            }
            catch {
                continue;
            }
        }
    }
    return state.quality ?? null;
}
async function ensurePlayback(video) {
    if (!video.paused) {
        await video.play().catch(() => undefined);
        return;
    }
    await video.play().catch(() => undefined);
}
function softSeek(video) {
    try {
        if (!Number.isFinite(video.currentTime)) {
            return;
        }
        const target = Math.max(0, video.currentTime - (pageKind === "live" ? 0 : 0.05));
        video.currentTime = target;
    }
    catch {
        return;
    }
}
function noteSegmentDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return;
    }
    segmentDurations.push(durationMs);
    while (segmentDurations.length > 24) {
        segmentDurations.shift();
    }
}
function beginSeekTracking(video) {
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
function resolveSeekTracking(video, reason) {
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
function isTimeBuffered(video, time) {
    const ranges = video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
        if (time >= ranges.start(index) && time <= ranges.end(index)) {
            return true;
        }
    }
    return false;
}
function summarizeHostHealth() {
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
function hostScore(health) {
    const total = health.successCount + health.failureCount;
    const successRatio = total === 0 ? 1 : health.successCount / total;
    const avgDuration = health.successCount === 0 ? 5000 : health.totalDurationMs / health.successCount;
    const latencyFactor = Math.max(0.1, Math.min(1, 2500 / Math.max(250, avgDuration)));
    const cooldownPenalty = health.cooldownUntil > Date.now() ? 0.2 : 1;
    return successRatio * latencyFactor * cooldownPenalty;
}
function isTargetQualitySatisfied() {
    if (pageKind === "vod") {
        return (vodSelection.height ?? 0) >= 4320;
    }
    if (pageKind === "live") {
        return (state.quality ?? 0) >= 10000;
    }
    return false;
}
function classifyLiveBufferTier(bufferedSeconds) {
    const target = policy.live.stableBufferTargetSeconds;
    if (bufferedSeconds < Math.max(2, target * 0.5)) {
        return "low";
    }
    if (bufferedSeconds > target * 1.5) {
        return "high";
    }
    return "target";
}
function resolveLivePrefetchWindow(totalSegments) {
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
function overlayButtonStyle() {
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
function parseHost(url) {
    if (!url) {
        return null;
    }
    try {
        return new URL(url).host;
    }
    catch {
        return null;
    }
}
function pathKeyFromUrl(url) {
    try {
        return new URL(url).pathname.replace(/\/\d+\.[^.]+$/, "");
    }
    catch {
        return url;
    }
}
function buildLiveUrl(basePath, firstUrlInfo) {
    const host = firstUrlInfo?.host ?? "";
    if (!host || !basePath) {
        return null;
    }
    return `${host}${basePath}${firstUrlInfo?.extra ?? ""}`;
}
function safelyParseUrl(url) {
    try {
        return new URL(url);
    }
    catch {
        return null;
    }
}
function extractRequestUrl(input) {
    if (typeof input === "string") {
        return input;
    }
    if (input instanceof Request) {
        return input.url;
    }
    return input.toString();
}
function cloneHeaders(headers) {
    const next = new Headers(headers);
    if (!next.has("content-type")) {
        next.set("content-type", "application/json");
    }
    return next;
}
function bufferSourceBytes(data) {
    if (data instanceof ArrayBuffer) {
        return data.byteLength;
    }
    return data.byteLength;
}
function formatBytes(bytes) {
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
function priorityScore(priority) {
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
function shouldBoostSeekPrefetch() {
    return seekState.active && !seekState.targetBuffered && policy.vod.seekBoostWindow > 0;
}
function takeNextPrefetchTask() {
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
function resolveRangeSplitConcurrency(reason) {
    const configured = Math.max(4, downloadController.controllerAppliedConcurrency);
    if (reason === "seek") {
        return clampNumber(Math.round(configured / 2) + 2, 8, 12);
    }
    return clampNumber(Math.round(configured / 2), 4, 8);
}
function detectPageKind(url) {
    if (/^https:\/\/live\.bilibili\.com\//.test(url)) {
        return "live";
    }
    if (/^https:\/\/www\.bilibili\.com\/video\//.test(url)) {
        return "vod";
    }
    return "unknown";
}
function buildStatus(partial, recentTelemetry) {
    const recent = recentTelemetry.filter((event) => event.ts >= Date.now() - 60_000);
    const waitingCount1m = recent.filter((event) => event.type === "playback" && event.event === "waiting").length;
    const stalledCount1m = recent.filter((event) => event.type === "playback" && event.event === "stalled").length;
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
        networkBoundLikely: (partial.bufferedSeconds ?? 0) < 1.5 && (waitingCount1m > 0 || stalledCount1m > 0),
        decodeBoundLikely: (partial.bufferedSeconds ?? 0) > 3 && (partial.droppedFrames ?? 0) > 10,
    };
}
function rankCodecPreference(candidates, preference) {
    const order = preference === "auto"
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
function codecPriority(codecs, order) {
    const lower = codecs.toLowerCase();
    const idx = order.findIndex((item) => lower.includes(item));
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}
function sortLiveCandidates(mode, candidates) {
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
function liveCodecScore(codecName) {
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
function resolvePrefetchDecision(input) {
    const highBitrateMode = (input.quality ?? 0) >= 1440 || (input.estimatedBitrate ?? 0) >= 8_000_000;
    const phase = input.phase ?? "steady";
    const baseWindow = 12;
    const configuredTargetSeconds = 48;
    const remainingSeconds = Number.isFinite(input.remainingSeconds ?? NaN)
        ? Math.max(0, input.remainingSeconds ?? 0)
        : null;
    const targetSeconds = remainingSeconds != null && remainingSeconds > 0
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
    const totalConcurrency = Math.min(16, Math.max(8, Math.max(input.maxConcurrentRequests, phase === "seek" ? 16 : phase === "initial" ? 14 : Math.min(videoWindow + 2, 12))));
    const bitrateEstimate = Math.max(2_500_000, input.estimatedBitrate ?? (highBitrateMode ? 12_000_000 : 5_000_000));
    const multiplier = phase === "seek" ? 2.1 : phase === "initial" ? 1.9 : 1.6;
    const cacheLimitBytes = clampNumber(Math.round((bitrateEstimate / 8) * Math.max(targetSeconds, 12) * multiplier), highBitrateMode ? 256 * 1024 * 1024 : 128 * 1024 * 1024, 1024 * 1024 * 1024);
    return {
        videoWindow,
        audioWindow,
        totalConcurrency,
        cacheLimitBytes,
        targetSeconds,
        highBitrateMode,
    };
}
function selectRecoveryAction(input) {
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
function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, value));
}
