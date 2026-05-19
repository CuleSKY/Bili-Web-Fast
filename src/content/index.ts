import { DEFAULT_POLICY, PAGE_MESSAGE_SOURCE } from "../shared/constants";
import type { PageBridgeMessage, RuntimeRequest } from "../shared/messaging/protocol";
import { createRuntimeBridge } from "../shared/messaging/runtime";

document.documentElement.dataset.bwfContent = "ready";
document.documentElement.dataset.bwfPageInjected = "manifest-main-world";
document.documentElement.dataset.bwfBridge = "attached";

const runtimeBridge = createRuntimeBridge({
  onDetach(error) {
    document.documentElement.dataset.bwfBridge = "detached";
    document.documentElement.dataset.bwfBridgeError =
      error instanceof Error ? `${error.name}:${error.message}` : String(error);
    window.postMessage(
      {
        source: PAGE_MESSAGE_SOURCE,
        kind: "policy",
        policy: DEFAULT_POLICY,
      } satisfies PageBridgeMessage,
      "*",
    );
  },
});

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data as PageBridgeMessage | undefined;
  if (!data || data.source !== PAGE_MESSAGE_SOURCE) {
    return;
  }

  if (data.kind === "telemetry") {
    void runtimeBridge.sendMessage({ kind: "telemetry", event: data.event } satisfies RuntimeRequest);
  }
  if (data.kind === "status") {
    void runtimeBridge.sendMessage({ kind: "pageStatus", status: data.status } satisfies RuntimeRequest);
  }
  if (data.kind === "runtimeCommand" && data.command === "setMode") {
    void runtimeBridge.sendMessage({
      kind: "pageCommand",
      command: "setMode",
      mode: data.mode,
    } satisfies RuntimeRequest);
  }
  if (data.kind === "policyPatch") {
    void runtimeBridge.sendMessage({
      kind: "patchPolicy",
      patch: data.patch,
    } satisfies RuntimeRequest);
  }
});

runtimeBridge.bindRuntimeMessages();
void runtimeBridge.hydratePolicy();
