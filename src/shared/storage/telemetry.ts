import { STORAGE_KEYS } from "../constants";
import { sanitizeTelemetryLimit } from "../messaging/runtime";
import type { TelemetryEvent } from "../types";

export async function loadTelemetry(): Promise<TelemetryEvent[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.telemetry);
  return (data[STORAGE_KEYS.telemetry] as TelemetryEvent[] | undefined) ?? [];
}

export async function appendTelemetry(event: TelemetryEvent, logLimit: number): Promise<void> {
  const current = await loadTelemetry();
  current.push(event);
  const trimmed = current.slice(-sanitizeTelemetryLimit(logLimit));
  await chrome.storage.local.set({ [STORAGE_KEYS.telemetry]: trimmed });
}
