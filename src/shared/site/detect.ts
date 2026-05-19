import type { PageKind } from "../types";

export function detectPageKind(url: string): PageKind {
  if (/^https:\/\/live\.bilibili\.com\//.test(url)) {
    return "live";
  }
  if (/^https:\/\/www\.bilibili\.com\/video\//.test(url)) {
    return "vod";
  }
  return "unknown";
}
