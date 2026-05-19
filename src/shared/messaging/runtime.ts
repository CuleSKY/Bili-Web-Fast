import { DEFAULT_POLICY, PAGE_MESSAGE_SOURCE } from "../constants";
import type {
  RuntimePortMessage,
  RuntimePushMessage,
  RuntimeRequest,
  RuntimeResponse,
  PageBridgeMessage,
} from "./protocol";
import type { ExtensionPolicy } from "../types";

const DETACH_ERROR_PATTERNS = [
  /Extension context invalidated/i,
  /Could not establish connection/i,
  /Receiving end does not exist/i,
] as const;

export type RuntimeBridgeState = "attached" | "detached";

export type RuntimeBridgeOptions = {
  onDetach?: (error: unknown) => void;
  onPolicy?: (policy: ExtensionPolicy) => void;
};

export function isRuntimeDetachError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return DETACH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function createRuntimeBridge(options: RuntimeBridgeOptions = {}) {
  let state: RuntimeBridgeState = "attached";
  let detachNotified = false;

  function notifyDetach(error: unknown): void {
    if (detachNotified) {
      return;
    }
    detachNotified = true;
    state = "detached";
    options.onDetach?.(error);
  }

  async function sendMessage(
    request: RuntimeRequest,
  ): Promise<RuntimeResponse | null> {
    if (state === "detached") {
      return null;
    }
    try {
      return await chrome.runtime.sendMessage(request);
    } catch (error) {
      if (isRuntimeDetachError(error)) {
        notifyDetach(error);
        return null;
      }
      throw error;
    }
  }

  function postPolicy(policy: ExtensionPolicy): void {
    window.postMessage(
      {
        source: PAGE_MESSAGE_SOURCE,
        kind: "policy",
        policy,
      } satisfies PageBridgeMessage,
      "*",
    );
    options.onPolicy?.(policy);
  }

  function bindRuntimeMessages(): void {
    if (state === "detached") {
      return;
    }
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (state === "detached") {
          return;
        }
        window.postMessage({ ...message, source: PAGE_MESSAGE_SOURCE }, "*");
      });
    } catch (error) {
      if (isRuntimeDetachError(error)) {
        notifyDetach(error);
        return;
      }
      throw error;
    }
  }

  async function hydratePolicy(): Promise<void> {
    const response = await sendMessage({ kind: "getPolicy" });
    if (response?.ok && "policy" in response) {
      postPolicy(response.policy);
    }
  }

  return {
    getState: (): RuntimeBridgeState => state,
    isDetached: (): boolean => state === "detached",
    bindRuntimeMessages,
    hydratePolicy,
    postPolicy,
    sendMessage,
  };
}

export function createUiPort(
  channel: RuntimePortMessage["channel"],
  onMessage: (message: RuntimePushMessage) => void,
) {
  const port = chrome.runtime.connect({ name: channel });
  const listener = (message: RuntimePushMessage) => onMessage(message);
  port.onMessage.addListener(listener);
  return {
    disconnect: () => {
      port.onMessage.removeListener(listener);
      port.disconnect();
    },
  };
}

export function sanitizeTelemetryLimit(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value == null) {
    return DEFAULT_POLICY.diagnostics.logLimit;
  }
  const rounded = Math.trunc(value);
  if (rounded <= 0) {
    return DEFAULT_POLICY.diagnostics.logLimit;
  }
  return rounded;
}
