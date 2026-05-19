import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendTelemetry, loadTelemetry } from "../../shared/storage/telemetry";
import type { TelemetryEvent } from "../../shared/types";

const storageState: Record<string, unknown> = {};

function createTelemetryEvent(ts: number): TelemetryEvent {
  return {
    type: "control",
    action: "test",
    ts,
    url: "https://www.bilibili.com/video/test",
    pageKind: "vod",
  };
}

describe("telemetry storage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    storageState["bwf.telemetry"] = [];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageState[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(storageState, value);
          }),
        },
      },
    });
  });

  it("uses current log limit when trimming telemetry", async () => {
    await appendTelemetry(createTelemetryEvent(1), 2);
    await appendTelemetry(createTelemetryEvent(2), 2);
    await appendTelemetry(createTelemetryEvent(3), 2);

    const telemetry = await loadTelemetry();
    expect(telemetry.map((event) => event.ts)).toEqual([2, 3]);
  });

  it("falls back to default limit for invalid values", async () => {
    for (let index = 0; index < 405; index += 1) {
      await appendTelemetry(createTelemetryEvent(index), 0);
    }

    const telemetry = await loadTelemetry();
    expect(telemetry).toHaveLength(400);
    expect(telemetry.at(0)?.ts).toBe(5);
    expect(telemetry.at(-1)?.ts).toBe(404);
  });
});
