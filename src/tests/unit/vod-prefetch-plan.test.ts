import { describe, expect, it } from "vitest";
import { buildVodPrefetchPlan } from "../../shared/policy/vod-prefetch-plan";

describe("buildVodPrefetchPlan", () => {
  it("includes both video and audio tracks from the current segment forward", () => {
    const plan = buildVodPrefetchPlan({
      currentTrack: "video",
      currentSequence: 100,
      videoBaseUrl: "https://cdn.example.com/seg/video100.m4s",
      audioBaseUrl: "https://cdn.example.com/seg/audio100.m4s",
      videoWindow: 4,
      audioWindow: 3,
      includeCurrent: true,
    });

    expect(plan).toEqual([
      "https://cdn.example.com/seg/video100.m4s",
      "https://cdn.example.com/seg/video101.m4s",
      "https://cdn.example.com/seg/video102.m4s",
      "https://cdn.example.com/seg/video103.m4s",
      "https://cdn.example.com/seg/audio100.m4s",
      "https://cdn.example.com/seg/audio101.m4s",
      "https://cdn.example.com/seg/audio102.m4s",
    ]);
  });

  it("does not duplicate the current segment when both templates resolve to the same URL", () => {
    const plan = buildVodPrefetchPlan({
      currentTrack: "video",
      currentSequence: 100,
      videoBaseUrl: "https://cdn.example.com/seg/video100.m4s",
      audioBaseUrl: "https://cdn.example.com/seg/video100.m4s",
      videoWindow: 2,
      audioWindow: 2,
      includeCurrent: true,
    });

    expect(plan).toEqual([
      "https://cdn.example.com/seg/video100.m4s",
      "https://cdn.example.com/seg/video101.m4s",
    ]);
  });
});
