import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourcePath = path.join(root, "src", "page", "index.ts");
const outputDir = path.join(root, "src", "generated");
const outputPath = path.join(outputDir, "page-world.js");

const source = await fs.readFile(sourcePath, "utf8");
const sanitizedSource = source
  .replace(/^import type[\s\S]*?from\s+["'][^"']+["'];\r?\n/gm, "")
  .replace(/^export\s+\{\};\r?\n/gm, "");

const transpiled = ts.transpileModule(sanitizedSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
    lib: ["ES2022", "DOM"],
    removeComments: false,
  },
  fileName: "index.ts",
});

const outputText = transpiled.outputText
  .replace(/^\s*Object\.defineProperty\(exports,\s*["']__esModule["'],\s*\{\s*value:\s*true\s*\}\);\r?\n/m, "")
  .replace(/^"use strict";\r?\n/m, `"use strict";\n`);

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  outputPath,
  `// Generated from src/page/index.ts. Do not edit directly.\n${outputText}`,
  "utf8",
);
