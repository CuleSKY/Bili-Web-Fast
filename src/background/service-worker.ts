import { DEFAULT_POLICY } from "../shared/constants";
import type {
  PolicyPatch,
  RuntimePortMessage,
  RuntimePushMessage,
  RuntimeRequest,
  RuntimeResponse,
} from "../shared/messaging/protocol";
import { sanitizeTelemetryLimit } from "../shared/messaging/runtime";
import type { ExtensionPolicy, PageStatus } from "../shared/types";
import type { TelemetryEvent } from "../shared/types";
import { loadPolicy, savePolicy } from "../shared/storage/policy";
import { appendTelemetry, loadTelemetry } from "../shared/storage/telemetry";

const tabStatus = new Map<number, PageStatus>();
const uiPorts = new Set<chrome.runtime.Port>();
let telemetryWriteQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const policy = await loadPolicy();
  await savePolicy({ ...DEFAULT_POLICY, ...policy });
});

chrome.runtime.onMessage.addListener((request: RuntimeRequest, sender, sendResponse) => {
  void handleMessage(request, sender.tab?.id)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!isUiPort(port)) {
    return;
  }
  uiPorts.add(port);
  port.onDisconnect.addListener(() => {
    uiPorts.delete(port);
  });
});

async function handleMessage(
  request: RuntimeRequest,
  tabId?: number,
): Promise<RuntimeResponse> {
  switch (request.kind) {
    case "getPolicy": {
      return { ok: true, policy: await loadPolicy() };
    }
    case "setPolicy": {
      await savePolicy(request.policy);
      await broadcastPolicy(request.policy);
      await broadcastRuntimeUpdate({ kind: "policyUpdated", policy: request.policy });
      return { ok: true, policy: request.policy };
    }
    case "patchPolicy": {
      const current = await loadPolicy();
      const next = mergePolicy(current, request.patch);
      await savePolicy(next);
      await broadcastPolicy(next);
      await broadcastRuntimeUpdate({ kind: "policyUpdated", policy: next });
      return { ok: true, policy: next };
    }
    case "getStatus": {
      return { ok: true, status: tabStatus.get(request.tabId ?? tabId ?? -1) ?? null };
    }
    case "pageCommand": {
      const current = await loadPolicy();
      const next =
        request.command === "setMode"
          ? request.mode === "stable" || request.mode === "lowLatency"
            ? { ...current, mode: request.mode, live: { ...current.live, defaultMode: request.mode } }
            : { ...current, mode: request.mode }
          : current;
      await savePolicy(next);
      await broadcastPolicy(next);
      await broadcastRuntimeUpdate({ kind: "policyUpdated", policy: next });
      return { ok: true, policy: next };
    }
    case "pageStatus": {
      if (tabId != null) {
        tabStatus.set(tabId, request.status);
        await broadcastRuntimeUpdate({ kind: "statusUpdated", tabId, status: request.status });
      }
      return { ok: true };
    }
    case "telemetry": {
      const policy = await loadPolicy();
      await enqueueTelemetryWrite({ ...request.event, tabId }, policy.diagnostics.logLimit);
      return { ok: true };
    }
    case "getTelemetry": {
      const telemetry = await loadTelemetry();
      const limit = request.limit ?? 200;
      return { ok: true, telemetry: telemetry.slice(-limit) };
    }
    case "exportDiagnostics": {
      const currentPolicy = await loadPolicy();
      const telemetry = await loadTelemetry();
      const blob = new Blob(
        [
          JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              policy: currentPolicy,
              telemetry,
              tabStatus: [...tabStatus.entries()],
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      return { ok: true, exported: url };
    }
    default: {
      return { ok: false, error: "unknown request" };
    }
  }
}

async function broadcastPolicy(policy: ExtensionPolicy): Promise<void> {
  const tabs = await chrome.tabs.query({
    url: ["https://www.bilibili.com/*", "https://live.bilibili.com/*"],
  });
  await Promise.all(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === "number")
      .map((tab) =>
        chrome.tabs
          .sendMessage(tab.id, {
            source: "bwf-background",
            kind: "policy",
            policy,
          })
          .catch(() => undefined),
      ),
  );
}

async function broadcastRuntimeUpdate(message: RuntimePushMessage): Promise<void> {
  for (const port of [...uiPorts]) {
    try {
      port.postMessage(message);
    } catch {
      uiPorts.delete(port);
    }
  }
}

async function enqueueTelemetryWrite(event: TelemetryEvent, logLimit: number): Promise<void> {
  telemetryWriteQueue = telemetryWriteQueue.then(() =>
    appendTelemetry(event, sanitizeTelemetryLimit(logLimit)),
  );
  await telemetryWriteQueue;
}

function isUiPort(port: chrome.runtime.Port): port is chrome.runtime.Port & { name: RuntimePortMessage["channel"] } {
  return port.name === "popup" || port.name === "options";
}

function mergePolicy(current: ExtensionPolicy, patch: PolicyPatch): ExtensionPolicy {
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
