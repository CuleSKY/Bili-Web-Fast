import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeBridge, isRuntimeDetachError, sanitizeTelemetryLimit } from "../../shared/messaging/runtime";
import { DEFAULT_POLICY } from "../../shared/constants";
import type { RuntimeRequest } from "../../shared/messaging/protocol";

describe("runtime bridge helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  });

  it("detects reload detach errors", () => {
    expect(isRuntimeDetachError(new Error("Extension context invalidated."))).toBe(true);
    expect(isRuntimeDetachError(new Error("Could not establish connection. Receiving end does not exist."))).toBe(true);
    expect(isRuntimeDetachError(new Error("boom"))).toBe(false);
  });

  it("hydrates policy when runtime is attached", async () => {
    const sendMessage = vi.fn(async (_request: RuntimeRequest) => ({
      ok: true as const,
      policy: DEFAULT_POLICY,
    }));
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    });

    const bridge = createRuntimeBridge();
    await bridge.hydratePolicy();

    expect(sendMessage).toHaveBeenCalledWith({ kind: "getPolicy" });
    expect(window.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "policy", policy: DEFAULT_POLICY }),
      "*",
    );
  });

  it("detaches cleanly when runtime is invalidated", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("Extension context invalidated.");
    });
    const onDetach = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    });

    const bridge = createRuntimeBridge({ onDetach });
    const response = await bridge.sendMessage({ kind: "getPolicy" });

    expect(response).toBeNull();
    expect(bridge.isDetached()).toBe(true);
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("sanitizes invalid telemetry limits", () => {
    expect(sanitizeTelemetryLimit(undefined)).toBe(DEFAULT_POLICY.diagnostics.logLimit);
    expect(sanitizeTelemetryLimit(0)).toBe(DEFAULT_POLICY.diagnostics.logLimit);
    expect(sanitizeTelemetryLimit(-4)).toBe(DEFAULT_POLICY.diagnostics.logLimit);
    expect(sanitizeTelemetryLimit(32.9)).toBe(32);
  });
});
