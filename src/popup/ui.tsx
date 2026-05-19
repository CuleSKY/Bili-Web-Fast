import React, { useEffect, useState } from "react";
import { DEFAULT_POLICY } from "../shared/constants";
import type { PolicyPatch, RuntimePushMessage, RuntimeRequest } from "../shared/messaging/protocol";
import { createUiPort } from "../shared/messaging/runtime";
import type { ExtensionPolicy, PageStatus, PlaybackMode } from "../shared/types";

const panelStyle: React.CSSProperties = {
  padding: 14,
  width: 380,
};

export function PopupApp(): React.JSX.Element {
  const [policy, setPolicy] = useState<ExtensionPolicy>(DEFAULT_POLICY);
  const [status, setStatus] = useState<PageStatus | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);

  useEffect(() => {
    void hydrate();
  }, []);

  useEffect(() => {
    const connection = createUiPort("popup", (message: RuntimePushMessage) => {
      if (message.kind === "policyUpdated") {
        setPolicy(message.policy);
        return;
      }
      if (message.kind === "statusUpdated" && message.tabId === tabId) {
        setStatus(message.status);
      }
    });
    return () => connection.disconnect();
  }, [tabId]);

  async function hydrate(): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setTabId(typeof tab?.id === "number" ? tab.id : null);
    const nextPolicy = await chrome.runtime.sendMessage({ kind: "getPolicy" } satisfies RuntimeRequest);
    const nextStatus = await chrome.runtime.sendMessage({
      kind: "getStatus",
      tabId: tab?.id,
    } satisfies RuntimeRequest);

    if (nextPolicy.ok && "policy" in nextPolicy) {
      setPolicy(nextPolicy.policy);
    }
    if (nextStatus.ok && "status" in nextStatus) {
      setStatus(nextStatus.status ?? null);
    }
  }

  async function updateMode(mode: PlaybackMode): Promise<void> {
    const patch: PolicyPatch =
      mode === "stable" || mode === "lowLatency"
        ? { mode, live: { defaultMode: mode } }
        : { mode };
    await chrome.runtime.sendMessage({ kind: "patchPolicy", patch } satisfies RuntimeRequest);
  }

  async function patchPolicy(patch: PolicyPatch): Promise<void> {
    await chrome.runtime.sendMessage({ kind: "patchPolicy", patch } satisfies RuntimeRequest);
  }

  async function exportDiagnostics(): Promise<void> {
    const response = await chrome.runtime.sendMessage({
      kind: "exportDiagnostics",
    } satisfies RuntimeRequest);
    if (response.ok && "exported" in response && response.exported) {
      chrome.tabs.create({ url: response.exported });
    }
  }

  return (
    <div style={panelStyle}>
      <h2 style={{ marginTop: 0 }}>Bilibili Web Fast</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["stable", "lowLatency", "off"] as PlaybackMode[]).map((mode) => (
          <button key={mode} onClick={() => void updateMode(mode)} style={buttonStyle(policy.mode === mode)}>
            {mode === "stable" ? "Stable" : mode === "lowLatency" ? "Low Latency" : "Off"}
          </button>
        ))}
      </div>

      <div style={cardStyle}>
        <StatusLine label="Page" value={status?.pageKind ?? "-"} />
        <StatusLine label="Mode" value={status?.mode ?? policy.mode} />
        <StatusLine label="Quality" value={status?.quality ?? "-"} />
        <StatusLine label="Codec" value={status?.codec ?? "-"} />
        <StatusLine label="Host" value={status?.host ?? "-"} />
        <StatusLine label="Protocol" value={status?.protocol ?? "-"} />
        <StatusLine label="Phase" value={status?.downloadPhase ?? "-"} />
        <StatusLine label="Buffer" value={`${status?.bufferedSeconds?.toFixed(2) ?? "0.00"}s`} />
        <StatusLine label="Target Buffer" value={`${status?.targetBufferSeconds?.toFixed(1) ?? "0.0"}s`} />
        <StatusLine label="Segment Avg" value={`${status?.avgSegmentDurationMs ?? 0} ms`} />
        <StatusLine label="Seg Seconds" value={`${status?.avgVodSegmentSeconds?.toFixed(2) ?? "4.00"}s`} />
        <StatusLine label="Prefetch" value={status?.prefetchQueueDepth ?? 0} />
        <StatusLine label="Ctrl Concurrency" value={status?.controllerConcurrency ?? 0} />
        <StatusLine label="Throughput" value={`${status?.recentThroughputMbps?.toFixed(1) ?? "0.0"} Mbps`} />
        <StatusLine label="Segment DL" value={status?.activeSegmentDownloads ?? 0} />
        <StatusLine label="Range Jobs" value={status?.activeRangeJobs ?? 0} />
        <StatusLine label="Cache" value={formatBytes(status?.cacheBytes ?? 0)} />
        <StatusLine label="Waiting(1m)" value={status?.waitingCount1m ?? 0} />
        <StatusLine label="Stalled(1m)" value={status?.stalledCount1m ?? 0} />
        <StatusLine label="Dropped" value={status?.droppedFrames ?? 0} />
        <StatusLine label="Seek Recovery" value={status?.lastSeekRecoveryMs == null ? "-" : `${status.lastSeekRecoveryMs} ms`} />
        <StatusLine label="Target" value={status?.targetQualitySatisfied ? "ready" : "pending"} />
        <StatusLine label="Recovery" value={status?.lastRecoveryAction ?? "-"} />
      </div>

      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <label style={switchStyle}>
          <input
            data-testid="popup-overlay-toggle"
            type="checkbox"
            checked={policy.diagnostics.overlayEnabled}
            onChange={(event) => void patchPolicy({ diagnostics: { overlayEnabled: event.target.checked } })}
          />
          <span>Overlay</span>
        </label>
        <label style={switchStyle}>
          <input
            data-testid="popup-range-split-toggle"
            type="checkbox"
            checked={policy.vod.experimentalRangeSplit}
            onChange={(event) => void patchPolicy({ vod: { experimentalRangeSplit: event.target.checked } })}
          />
          <span>Range Split</span>
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button style={buttonStyle(false)} onClick={() => chrome.runtime.openOptionsPage()}>
          Options
        </button>
        <button style={buttonStyle(false)} onClick={() => void exportDiagnostics()}>
          Export
        </button>
      </div>
    </div>
  );
}

function StatusLine({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
      <span style={{ color: "#93a0c7" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#181b24",
  borderRadius: 8,
  padding: 12,
  border: "1px solid #272c38",
};

function buttonStyle(active: boolean): React.CSSProperties {
  return {
    border: "1px solid #2f6feb",
    background: active ? "#2f6feb" : "transparent",
    color: "#eef2ff",
    padding: "8px 10px",
    borderRadius: 6,
  };
}

const switchStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

function formatBytes(bytes: number): string {
  if (!bytes) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
