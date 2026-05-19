import { describe, expect, it } from "vitest";
import {
  classifyResource,
  getRequestSemantics,
  shouldDriveStreamingPipeline,
  shouldUseFullBodyCache,
  shouldUseRangeSplitForRequest,
} from "../../shared/policy/request";

describe("request policy", () => {
  const mediaUrl = "https://cdn.example.com/video100.m4s";

  it("allows ordinary GET media requests to use the full-body cache", () => {
    const semantics = getRequestSemantics(new Request(mediaUrl));

    expect(classifyResource(mediaUrl)).toBe("media");
    expect(semantics.ordinaryGet).toBe(true);
    expect(shouldDriveStreamingPipeline(semantics, "media")).toBe(true);
    expect(shouldUseFullBodyCache(semantics, "media")).toBe(true);
  });

  it("blocks HEAD requests from full-body cache and Range Split", () => {
    const semantics = getRequestSemantics(new Request(mediaUrl, { method: "HEAD" }));

    expect(shouldDriveStreamingPipeline(semantics, "media")).toBe(false);
    expect(shouldUseFullBodyCache(semantics, "media")).toBe(false);
    expect(shouldUseRangeSplitForRequest({
      pageKind: "vod",
      mode: "stable",
      experimentalRangeSplit: true,
      url: mediaUrl,
      semantics,
    })).toBe(false);
  });

  it("blocks Range requests even when the Range header comes from fetch(Request)", () => {
    const semantics = getRequestSemantics(new Request(mediaUrl, {
      headers: {
        range: "bytes=0-99",
      },
    }));

    expect(semantics.hasRange).toBe(true);
    expect(shouldDriveStreamingPipeline(semantics, "media")).toBe(false);
    expect(shouldUseFullBodyCache(semantics, "media")).toBe(false);
    expect(shouldUseRangeSplitForRequest({
      pageKind: "vod",
      mode: "stable",
      experimentalRangeSplit: true,
      url: mediaUrl,
      semantics,
    })).toBe(false);
  });
});
