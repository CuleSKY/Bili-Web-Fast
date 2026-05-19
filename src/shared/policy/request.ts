export type ResourceKind = "playurl" | "livePlayInfo" | "media" | "playlist" | "other";

export interface RequestSemantics {
  url: string;
  method: string;
  hasRange: boolean;
  ordinaryGet: boolean;
}

export function classifyResource(url: string): ResourceKind {
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

export function getRequestSemantics(input: RequestInfo | URL, init?: RequestInit): RequestSemantics {
  const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const url = extractRequestUrl(input);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const initHeaders = init?.headers ? new Headers(init.headers) : null;
  const requestHeaders = request ? new Headers(request.headers) : null;
  const hasRange = Boolean(initHeaders?.has("range") || requestHeaders?.has("range"));

  return {
    url,
    method,
    hasRange,
    ordinaryGet: method === "GET" && !hasRange,
  };
}

export function shouldUseFullBodyCache(semantics: RequestSemantics, resourceKind: ResourceKind): boolean {
  return semantics.ordinaryGet && (resourceKind === "media" || resourceKind === "playlist");
}

export function shouldDriveStreamingPipeline(
  semantics: RequestSemantics,
  resourceKind: ResourceKind,
): boolean {
  return semantics.ordinaryGet && (resourceKind === "media" || resourceKind === "playlist");
}

export function shouldUseRangeSplitForRequest(input: {
  pageKind: "vod" | "live" | "unknown";
  mode: "off" | "stable" | "lowLatency";
  experimentalRangeSplit: boolean;
  url: string;
  semantics: RequestSemantics;
}): boolean {
  if (input.pageKind !== "vod" || input.mode === "off" || !input.experimentalRangeSplit) {
    return false;
  }
  if (!/\.m4s(\?|$)|\.mp4(\?|$)|\.cmfv(\?|$)/.test(input.url)) {
    return false;
  }
  return input.semantics.ordinaryGet;
}

function extractRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return input.toString();
}
