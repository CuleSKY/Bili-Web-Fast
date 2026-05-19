import React, { useEffect, useState } from "react";
import { DEFAULT_POLICY } from "../shared/constants";
import type { PolicyPatch, RuntimePushMessage, RuntimeRequest } from "../shared/messaging/protocol";
import { createUiPort } from "../shared/messaging/runtime";
import type { CodecPreference, ExtensionPolicy, LiveProtocolPreference } from "../shared/types";

export function OptionsApp(): React.JSX.Element {
  const [policy, setPolicy] = useState<ExtensionPolicy>(DEFAULT_POLICY);

  useEffect(() => {
    void chrome.runtime.sendMessage({ kind: "getPolicy" } satisfies RuntimeRequest).then((response) => {
      if (response.ok && "policy" in response) {
        setPolicy(response.policy);
      }
    });
    const connection = createUiPort("options", (message: RuntimePushMessage) => {
      if (message.kind === "policyUpdated") {
        setPolicy(message.policy);
      }
    });
    return () => connection.disconnect();
  }, []);

  async function patch(patchValue: PolicyPatch): Promise<void> {
    const response = await chrome.runtime.sendMessage({ kind: "patchPolicy", patch: patchValue } satisfies RuntimeRequest);
    if (response.ok && "policy" in response) {
      setPolicy(response.policy);
    }
  }

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: 24 }}>
      <h1>Bilibili Web Fast Settings</h1>

      <Section title="VOD Policy">
        <Checkbox
          label="Lock quality"
          testId="vod-lock-quality"
          checked={policy.vod.lockQuality}
          onChange={(checked) => void patch({ vod: { lockQuality: checked } })}
        />
        <NumberField
          label="Preferred quality code"
          testId="vod-preferred-quality"
          value={policy.vod.preferredQuality ?? ""}
          onChange={(value) =>
            void patch({
              vod: { preferredQuality: value === "" ? null : Number(value) },
            })
          }
        />
        <SelectField<CodecPreference>
          label="Codec policy"
          testId="vod-codec-policy"
          value={policy.vod.codecPreference}
          options={[
            { label: "Auto", value: "auto" },
            { label: "AVC", value: "avc" },
            { label: "HEVC", value: "hevc" },
            { label: "AV1", value: "av1" },
          ]}
          onChange={(value) => void patch({ vod: { codecPreference: value } })}
        />
        <NumberField
          label="Prefetch window"
          testId="vod-prefetch-window"
          value={policy.vod.prefetchWindow}
          onChange={(value) => void patch({ vod: { prefetchWindow: Number(value) } })}
        />
        <NumberField
          label="Aggressive prefetch seconds"
          testId="vod-aggressive-prefetch-seconds"
          value={policy.vod.aggressivePrefetchSeconds}
          onChange={(value) => void patch({ vod: { aggressivePrefetchSeconds: Number(value) } })}
        />
        <NumberField
          label="Max concurrency ceiling"
          testId="vod-max-concurrency"
          value={policy.vod.maxConcurrentRequests}
          onChange={(value) =>
            void patch({ vod: { maxConcurrentRequests: Number(value) } })
          }
        />
        <NumberField
          label="Range chunk size (KB)"
          testId="vod-range-chunk-size"
          value={policy.vod.rangeChunkSizeKb}
          onChange={(value) => void patch({ vod: { rangeChunkSizeKb: Number(value) } })}
        />
        <NumberField
          label="Seek boost window"
          testId="vod-seek-boost-window"
          value={policy.vod.seekBoostWindow}
          onChange={(value) => void patch({ vod: { seekBoostWindow: Number(value) } })}
        />
        <NumberField
          label="Host cooldown (ms)"
          testId="vod-host-cooldown"
          value={policy.vod.hostCooldownMs}
          onChange={(value) => void patch({ vod: { hostCooldownMs: Number(value) } })}
        />
        <Checkbox
          label="Enable experimental Range split"
          testId="vod-range-split"
          checked={policy.vod.experimentalRangeSplit}
          onChange={(checked) =>
            void patch({ vod: { experimentalRangeSplit: checked } })
          }
        />
      </Section>

      <Section title="Live Policy">
        <SelectField
          label="Default mode"
          testId="live-default-mode"
          value={policy.live.defaultMode}
          options={[
            { label: "Stable", value: "stable" },
            { label: "Low latency", value: "lowLatency" },
          ]}
          onChange={(value) => void patch({ live: { defaultMode: value } })}
        />
        <SelectField<LiveProtocolPreference>
          label="Protocol preference"
          testId="live-protocol-preference"
          value={policy.live.preferredProtocol}
          options={[
            { label: "Auto", value: "auto" },
            { label: "FLV", value: "flv" },
            { label: "fMP4", value: "fmp4" },
            { label: "TS", value: "ts" },
          ]}
          onChange={(value) => void patch({ live: { preferredProtocol: value } })}
        />
        <NumberField
          label="Preferred live quality code"
          testId="live-preferred-quality"
          value={policy.live.preferredQuality ?? ""}
          onChange={(value) =>
            void patch({
              live: { preferredQuality: value === "" ? null : Number(value) },
            })
          }
        />
        <Checkbox
          label="Allow protocol fallback"
          testId="live-protocol-fallback"
          checked={policy.live.enableProtocolFallback}
          onChange={(checked) =>
            void patch({ live: { enableProtocolFallback: checked } })
          }
        />
        <NumberField
          label="Stable buffer target (s)"
          testId="live-buffer-target"
          value={policy.live.stableBufferTargetSeconds}
          onChange={(value) =>
            void patch({ live: { stableBufferTargetSeconds: Number(value) } })
          }
        />
        <NumberField
          label="Host cooldown (ms)"
          testId="live-host-cooldown"
          value={policy.live.hostCooldownMs}
          onChange={(value) => void patch({ live: { hostCooldownMs: Number(value) } })}
        />
      </Section>

      <Section title="Diagnostics">
        <Checkbox
          label="Show overlay"
          testId="diagnostics-overlay"
          checked={policy.diagnostics.overlayEnabled}
          onChange={(checked) =>
            void patch({ diagnostics: { overlayEnabled: checked } })
          }
        />
        <Checkbox
          label="Record detailed logs"
          testId="diagnostics-detailed-logs"
          checked={policy.diagnostics.detailedLogs}
          onChange={(checked) =>
            void patch({ diagnostics: { detailedLogs: checked } })
          }
        />
        <NumberField
          label="Log limit"
          testId="diagnostics-log-limit"
          value={policy.diagnostics.logLimit}
          onChange={(value) =>
            void patch({ diagnostics: { logLimit: Number(value) } })
          }
        />
      </Section>
    </div>
  );
}

function Section({ title, children }: React.PropsWithChildren<{ title: string }>): React.JSX.Element {
  return (
    <section
      style={{
        marginBottom: 18,
        borderRadius: 8,
        border: "1px solid #272c38",
        background: "#181b24",
        padding: 18,
      }}
    >
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <div style={{ display: "grid", gap: 12 }}>{children}</div>
    </section>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}): React.JSX.Element {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <input data-testid={testId} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  testId?: string;
}): React.JSX.Element {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span>{label}</span>
      <input data-testid={testId} type="number" value={value} onChange={(event) => onChange(event.target.value)} style={inputStyle} />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: Array<{ label: string; value: T }>;
  onChange: (value: T) => void;
  testId?: string;
}): React.JSX.Element {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span>{label}</span>
      <select data-testid={testId} value={value} onChange={(event) => onChange(event.target.value as T)} style={inputStyle}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #31394a",
  background: "#111318",
  color: "#eef2ff",
};
