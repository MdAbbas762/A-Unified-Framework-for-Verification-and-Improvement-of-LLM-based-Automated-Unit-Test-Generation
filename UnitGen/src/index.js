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
import { renderJestTestTemplate } from "./core/testgen/jestTestTemplate.js";
import { writeGeneratedTest } from "./core/testgen/testWriter.js";

// STEP 8 + Report imports
import { runJest } from "./core/runner/jestRunner.js";
import { formatJestSummary, printReport } from "./core/report/consoleReport.js";
import { writeFinalReport } from "./core/report/finalReportWriter.js";


function printMessages(messages) {
  for (const m of messages) {
    const prefix =
      m.level === "error" ? "❌" : m.level === "warn" ? "⚠️" : "ℹ️";
    console.log(`${prefix} ${m.text}`);
  }
}

function safeTestStem(sourceFile, fnName) {
  const base = path.basename(sourceFile, path.extname(sourceFile));
  // keep filenames filesystem-friendly
  const stem = `${base}.${fnName}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return stem;
}

/**
 * Compute relative import path from tests/generated/<file>.test.js
 * to the source file.
 */
function computeImportPath(sourceFileAbs) {
  const fromDir = path.resolve("tests", "generated");
  let rel = path.relative(fromDir, sourceFileAbs);
  // Jest expects ./ or ../ style paths
  if (!rel.startsWith(".")) rel = `./${rel}`;
  // Normalize to POSIX for JS imports
  return rel.split(path.sep).join(path.posix.sep);
}

/**
 * Clean previously generated test files so each run is deterministic.
 * This prevents old .test.js files from previous runs from being executed by Jest.
 */
function cleanGeneratedTests() {
  const genDir = path.resolve("tests", "generated");
  if (!fs.existsSync(genDir)) return;

  for (const f of fs.readdirSync(genDir)) {
    // Remove only generated test files (keep json, etc.)
    if (f.endsWith(".test.js")) {
      try {
        fs.unlinkSync(path.join(genDir, f));
      } catch (_) {
        // ignore
      }
    }
  }
}

// -------------------------
// Step 0 — Input selection
// -------------------------
const userArg = process.argv[2];
const input = resolveInput(userArg);

printMessages(input.messages);
if (!input.ok) process.exit(1);

// IMPORTANT: clean generated tests once before generating new ones
cleanGeneratedTests();

// Summary counters for Step 0 validation
let processedFiles = 0;
let skippedFiles = 0;
let generatedTestFiles = 0;

// Process each discovered file through existing pipeline steps
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

  // IMPORTANT: only generate tests for exported functions
  const functions = allFunctions.filter((f) => f.exported);

  console.log(
    `✅ Found ${allFunctions.length} function(s): ${allFunctions
      .map((f) => f.name)
      .join(", ")}`
  );

  if (!functions.length) {
    console.log(
      `⚠️ None of the detected functions are exported. Unit tests can only import exported functions.\n` +
        `   👉 Export the function(s) or test a module that exports them (skipping this file).`
    );
    continue;
  }

  console.log(
    `✅ Exported function(s) to test: ${functions.map((f) => f.name).join(", ")}`
  );

  // Step 2 — Dependency detection
  const { importMap, usage, memberUsage } = detectImportedIdentifierUsage(
    code,
    functions
  );
  const dependencies = convertUsageToModuleDependencies(importMap, usage);

  // Step 3/4 — Mock plan + Jest mock rendering
  const mockPlan = buildMockPlan({
    functions,
    importMap,
    usage,
    memberUsage,
    dependencies,
  });
  const jestMocksByFn = renderJestMocks(mockPlan);

  // Step 7 — Generate + write tests (template-based for now)
  const importPath = computeImportPath(filePathAbs);

  for (const fn of functions) {
    const fnName = fn.name;

    // Basic async detection (prototype)
    const isAsync = fn.code.startsWith("async ") || fn.kind === "AsyncFunction";
    const params = (fn.params || []).map((p) =>
      typeof p === "string" ? p : (p?.name ?? "arg")
    );

    const jestMocks = jestMocksByFn[fnName] || "";
    const testContent = renderJestTestTemplate({
      fnName,
      isAsync,
      importPath,
      params,
      jestMocks,

    });

    const stem = safeTestStem(filePathAbs, fnName);
    const outFile = writeGeneratedTest(stem, testContent);
    generatedTestFiles++;
    console.log(`✅ Generated: ${outFile}`);
  }
}

console.log(`\n==============================`);
console.log(`📌 Summary`);
console.log(`==============================`);
console.log(`✅ Files processed: ${processedFiles}`);
console.log(`⚠️ Files skipped:  ${skippedFiles}`);
console.log(`🧾 Tests created:  ${generatedTestFiles}`);
console.log(`📁 Tests output:   tests/generated/`);

// -------------------------
// Step 8 — Execute Jest + Report
// -------------------------
if (generatedTestFiles === 0) {
  console.log("\n⚠️ No tests were generated, so Jest execution is skipped.\n");
  process.exitCode = 1;
} else {
  console.log("\n🧪 Running Jest on generated tests...\n");

  const result = await runJest({ configPath: "jest.config.js" });

  if (!result.json) {
    console.log("⚠️ Jest did not produce JSON output.");
    console.log("---- stderr ----");
    console.log(result.stderr || "(no stderr)");
    console.log("---- stdout ----");
    console.log(result.stdout || "(no stdout)");
    process.exitCode = result.exitCode || 1;
  } else {
    const summary = formatJestSummary(result.json);
    printReport(summary);
    const reportPath = writeFinalReport(result.json, "output/final-report.json");
    console.log(`\n🧾 Final report saved: ${reportPath}\n`);
    process.exitCode = result.exitCode;
  }
}