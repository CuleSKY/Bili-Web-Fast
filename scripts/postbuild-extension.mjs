import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist-extension");
const assetsDir = path.join(distDir, "assets");
const manifestPath = path.join(distDir, "manifest.json");
const legacyContentAlias = "index.ts-CCxI3uRc.js";

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const assetNames = await fs.readdir(assetsDir);

const contentChunk = pickSingle(
  assetNames.filter((name) => name !== legacyContentAlias),
  /^index\.ts-(?!loader-)[^.]+\.js$/,
  "content script chunk",
);
const backgroundChunk = pickSingle(
  assetNames,
  /^service-worker\.ts-[^.]+\.js$/,
  "background service worker chunk",
);
const contentLoader = pickSingle(
  assetNames,
  /^index\.ts-loader-[^.]+\.js$/,
  "content loader chunk",
);

const serviceWorkerLoaderPath = path.join(distDir, "service-worker-loader.js");
await fs.writeFile(serviceWorkerLoaderPath, `import './assets/${backgroundChunk}';\n`, "utf8");

const legacyAliasPath = path.join(assetsDir, legacyContentAlias);
await fs.writeFile(legacyAliasPath, `import "./${contentChunk}";\n`, "utf8");

const resources = manifest.web_accessible_resources ?? [];
for (const entry of resources) {
  if (!Array.isArray(entry.resources)) {
    continue;
  }
  if (!entry.resources.includes(`assets/${contentChunk}`)) {
    entry.resources.push(`assets/${contentChunk}`);
  }
  if (!entry.resources.includes(`assets/${legacyContentAlias}`)) {
    entry.resources.push(`assets/${legacyContentAlias}`);
  }
}

if (Array.isArray(manifest.content_scripts)) {
  const isolatedWorldScript = manifest.content_scripts.find((entry) => entry.world !== "MAIN");
  if (isolatedWorldScript && Array.isArray(isolatedWorldScript.js)) {
    isolatedWorldScript.js = [`assets/${contentLoader}`];
  }
}

manifest.background = {
  ...(manifest.background ?? {}),
  service_worker: "service-worker-loader.js",
};

await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

function pickSingle(names, pattern, label) {
  const matches = names.filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}: ${matches.join(", ")}`);
  }
  return matches[0];
}
