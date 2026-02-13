import fs from "fs";
import path from "path";

import { resolveInput } from "./core/input/resolveInput.js";
import { parseSource } from "./core/parser/parseFile.js";
import { extractFunctions } from "./core/parser/functionExtractor.js";
import {
  detectImportedIdentifierUsage,
  convertUsageToModuleDependencies,
} from "./core/dependency/dependencyDetector.js";
import { buildMockPlan } from "./core/mock/mockPlanBuilder.js";
import { renderJestMocks } from "./core/mock/jestMockRenderer.js";


function printMessages(messages) {
  for (const m of messages) {
    const prefix =
      m.level === "error" ? "❌" : m.level === "warn" ? "⚠️" : "ℹ️";
    console.log(`${prefix} ${m.text}`);
  }
}

// -------------------------
// Step 0 — Input selection
// -------------------------
const userArg = process.argv[2];
const input = resolveInput(userArg);

printMessages(input.messages);
if (!input.ok) process.exit(1);

// Summary counters
let processedFiles = 0;
let skippedFiles = 0;

// Process each discovered file through pipeline steps
for (const filePathAbs of input.files) {
  const display = path.relative(process.cwd(), filePathAbs) || filePathAbs;
  console.log(`\n==============================`);
  console.log(`📄 Processing: ${display}`);
  console.log(`==============================`);

  let code = "";
  try {
    code = fs.readFileSync(filePathAbs, "utf8");
  } catch (e) {
    console.log(`❌ Failed to read file: ${e?.message ?? e}`);
    skippedFiles++;
    continue;
  }

  // Validate: is valid JavaScript for our parser?
  try {
    parseSource(code);
  } catch (e) {
    console.log(
      `❌ Not valid / parsable JavaScript (skipping): ${e?.message ?? e}`
    );
    skippedFiles++;
    continue;
  }

  processedFiles++;

  // Step 1 — Function extraction
  const allFunctions = extractFunctions(code);
  if (!allFunctions.length) {
    console.log(`⚠️ No functions detected in this file.`);
    continue;
  }

  // Only process exported functions
  const functions = allFunctions.filter((f) => f.exported);

  console.log(
    `✅ Found ${allFunctions.length} function(s): ${allFunctions
      .map((f) => f.name)
      .join(", ")}`
  );

  if (!functions.length) {
    console.log(
      `⚠️ None of the detected functions are exported. Mock planning requires exported functions.\n` +
      `   👉 Export the function(s) or use a module that exports them (skipping this file).`
    );
    continue;
  }

  console.log(
    `✅ Exported function(s) for mock analysis: ${functions
      .map((f) => f.name)
      .join(", ")}`
  );

  // Step 2 — Dependency detection
  const { importMap, usage, memberUsage } =
    detectImportedIdentifierUsage(code, functions);

  const dependencies =
    convertUsageToModuleDependencies(importMap, usage);

  // Step 3/4 — Mock plan + Jest mock rendering
  const mockPlan = buildMockPlan({
    functions,
    importMap,
    usage,
    memberUsage,
    dependencies,
  });

  const jestMocksByFn = renderJestMocks(mockPlan);

  console.log(`\n🧩 Generated Mock Plan:`);
  console.log(JSON.stringify(mockPlan, null, 2));

  console.log(`\n🧪 Rendered Jest Mocks:`);
  console.log(JSON.stringify(jestMocksByFn, null, 2));
}

console.log(`\n==============================`);
console.log(`📌 Summary`);
console.log(`==============================`);
console.log(`✅ Files processed: ${processedFiles}`);
console.log(`⚠️ Files skipped:  ${skippedFiles}`);
console.log(`\n🎯 Mock generation pipeline executed successfully.\n`);
