import { DEFAULT_POLICY, STORAGE_KEYS } from "../constants";
import type { ExtensionPolicy } from "../types";

export async function loadPolicy(): Promise<ExtensionPolicy> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.policy);
  const stored = (data[STORAGE_KEYS.policy] as Partial<ExtensionPolicy> | undefined) ?? {};
  return {
    ...DEFAULT_POLICY,
    ...stored,
    vod: {
      ...DEFAULT_POLICY.vod,
      ...(stored.vod ?? {}),
    },
    live: {
      ...DEFAULT_POLICY.live,
      ...(stored.live ?? {}),
    },
    diagnostics: {
      ...DEFAULT_POLICY.diagnostics,
      ...(stored.diagnostics ?? {}),
    },
  };
}

export async function savePolicy(policy: ExtensionPolicy): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.policy]: policy });
}
