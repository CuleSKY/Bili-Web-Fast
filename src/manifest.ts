import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Bilibili Web Fast",
  description: "Improve bilibili web playback stability for VOD and live.",
  version: "0.1.0",
  permissions: ["storage", "tabs"],
  host_permissions: [
    "https://www.bilibili.com/*",
    "https://live.bilibili.com/*",
    "https://api.bilibili.com/*",
    "https://*.bilivideo.com/*",
    "https://*.akamaized.net/*"
  ],
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module"
  },
  content_scripts: [
    {
      matches: ["https://www.bilibili.com/*", "https://live.bilibili.com/*"],
      js: ["src/content/index.ts"],
      run_at: "document_start"
    },
    {
      matches: ["https://www.bilibili.com/*", "https://live.bilibili.com/*"],
      js: ["src/generated/page-world.js"],
      run_at: "document_start",
      world: "MAIN"
    }
  ],
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Bilibili Web Fast"
  },
  options_page: "src/options/index.html",
  web_accessible_resources: []
});
