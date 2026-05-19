import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";

const root = process.cwd();
const sourcePath = path.join(root, "src", "page", "index.ts");
const outputDir = path.join(root, "src", "generated");
const outputPath = path.join(outputDir, "page-world.js");

const result = await build({
  configFile: false,
  publicDir: false,
  logLevel: "silent",
  build: {
    write: false,
    target: "es2022",
    minify: false,
    lib: {
      entry: sourcePath,
      name: "BwfPageWorld",
      formats: ["iife"],
      fileName: () => "page-world.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
const chunk = outputs.find((item) => item.type === "chunk");
const outputText = chunk?.type === "chunk" ? chunk.code : "";

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  outputPath,
  `// Generated from src/page/index.ts. Do not edit directly.\n${outputText}`,
  "utf8",
);
