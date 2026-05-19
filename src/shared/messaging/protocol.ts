import type { ExtensionPolicy, PageStatus, TelemetryEvent } from "../types";

export type PolicyPatch = {
  mode?: ExtensionPolicy["mode"];
  vod?: Partial<ExtensionPolicy["vod"]>;
  live?: Partial<ExtensionPolicy["live"]>;
  diagnostics?: Partial<ExtensionPolicy["diagnostics"]>;
};

export type RuntimeRequest =
  | { kind: "getPolicy" }
  | { kind: "setPolicy"; policy: ExtensionPolicy }
  | { kind: "patchPolicy"; patch: PolicyPatch }
  | { kind: "getStatus"; tabId?: number }
  | { kind: "getTelemetry"; limit?: number }
  | { kind: "exportDiagnostics" }
  | { kind: "pageCommand"; command: "setMode"; mode: ExtensionPolicy["mode"] }
  | { kind: "pageStatus"; status: PageStatus }
  | { kind: "telemetry"; event: TelemetryEvent };

export type RuntimeResponse =
  | { ok: true; policy: ExtensionPolicy }
  | { ok: true; status?: PageStatus | null }
  | { ok: true; telemetry?: TelemetryEvent[] }
  | { ok: true; exported?: string }
  | { ok: false; error: string };

export type RuntimePushMessage =
  | { kind: "policyUpdated"; policy: ExtensionPolicy }
  | { kind: "statusUpdated"; tabId: number; status: PageStatus | null };

export type RuntimePortMessage = {
  channel: "popup" | "options";
};

export type PageBridgeMessage =
  | { source: string; kind: "policy"; policy: ExtensionPolicy }
  | { source: string; kind: "policyPatch"; patch: PolicyPatch }
  | { source: string; kind: "telemetry"; event: TelemetryEvent }
  | { source: string; kind: "status"; status: PageStatus }
  | { source: string; kind: "runtimeCommand"; command: "setMode"; mode: ExtensionPolicy["mode"] };
