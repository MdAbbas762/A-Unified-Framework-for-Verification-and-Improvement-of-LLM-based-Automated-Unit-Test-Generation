// src/index.js
import fs from "fs";
import path from "path";
import { createRequire } from "node:module";
import "dotenv/config";

import { resolveInput } from "./core/input/resolveInput.js";
import {
  prepareLegacyEsmCompatibility,
  registerLegacyEsmRestoreHooks,
} from "./core/input/legacyEsmCompatibility.js";
import { parseSource } from "./core/parser/parseFile.js";
import { extractFunctions } from "./core/parser/functionExtractor.js";
import { analyzeClassExports } from "./core/parser/classExportAnalyzer.js";
import { generateDynamicApiTests } from "./core/parser/dynamicApiTestGenerator.js";
import { getPublicEntryExpansionFiles } from "./core/parser/packagePublicEntryExpander.js";
import {
  detectImportedIdentifierUsage,
  convertUsageToModuleDependencies,
} from "./core/dependency/dependencyDetector.js";
import { buildMockPlan } from "./core/mock/mockPlanBuilder.js";
import { renderJestMocks } from "./core/mock/jestMockRenderer.js";
import {
  renderJestMockModule,
  renderJestTestTemplate,
} from "./core/testgen/jestTestTemplate.js";
import {
  writeGeneratedMock,
  writeGeneratedTest,
} from "./core/testgen/testWriter.js";
import {
  fillGeneratedTestsWithLLM,
  runCoverageGuidedExpansion,
} from "./core/llm/llmFillTests.js";
import {
  preflightGeneratedTestFilesAfterLLM,
  countUniqueTestFiles,
  isUnrecoverableJestResult,
} from "./core/testgen/generatedTestPreflight.js";

import { runJest } from "./core/runner/jestRunner.js";
import {
  formatJestSummary,
  printReport,
} from "./core/report/consoleReport.js";
import { writeFinalReport } from "./core/report/finalReportWriter.js";

import {
  quarantineUnresolvedRepairCandidates,
  runAdaptiveRepair,
} from "./core/repair/repairLoop.js";
import { runAssertionEnhancer } from "./core/assertion/assertionEnhancer.js";

import {
  mineUsageSnippetsForFunctions,
  summarizeUsageSnippetMining,
} from "./core/context/usageSnippetMiner.js";
import {
  extractDocCommentsForFunctions,
  summarizeDocCommentExtraction,
} from "./core/context/docCommentExtractor.js";

import {
  cleanupRuntimeArtifacts,
  createRuntimeArtifactSnapshot,
} from "./core/testgen/runtimeArtifactCleanup.js";

/* ======================================================
   CONFIG
====================================================== */

const ACTIVE_MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";

/*
  Top-level external mocking is useful for risky/missing dependencies, but
  blindly mocking every external dependency can weaken tests. The logic below
  now filters pure installed utilities by default and only mocks:
  - risky external systems
  - missing external modules needed to load package files

  Disable completely with:
  UNITGEN_MOCK_TOP_LEVEL_EXTERNALS=false
*/
const SHOULD_MOCK_TOP_LEVEL_EXTERNAL_IMPORTS =
  process.env.UNITGEN_MOCK_TOP_LEVEL_EXTERNALS !== "false";

const rootRequire = createRequire(import.meta.url);

const BUILTIN_MODULES = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "crypto",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

const RISKY_EXTERNAL_PATTERNS = [
  /^axios$/,
  /^node-fetch$/,
  /^cross-fetch$/,
  /^isomorphic-fetch$/,
  /^got$/,
  /^request$/,
  /^superagent$/,
  /^undici$/,
  /^ws$/,
  /^socket\.io-client$/,
  /^mongodb$/,
  /^mongoose$/,
  /^mysql$/,
  /^mysql2$/,
  /^pg$/,
  /^redis$/,
  /^ioredis$/,
  /^sqlite3$/,
  /^better-sqlite3$/,
  /^aws-sdk$/,
  /^@aws-sdk\//,
  /^firebase$/,
  /^@firebase\//,
  /^stripe$/,
  /^nodemailer$/,
  /^sendgrid$/,
  /^@sendgrid\//,
  /^twilio$/,
  /^puppeteer$/,
  /^playwright$/,
  /^selenium-webdriver$/,
];

const PURE_UTILITY_PATTERNS = [
  /^lodash(?:\.|\/|$)/,
  /^underscore$/,
  /^ramda$/,
  /^fast-diff$/,
  /^deep-equal$/,
  /^is-equal$/,
  /^compute-/,
  /^mathjs$/,
  /^decimal\.js$/,
  /^big\.js$/,
  /^bignumber\.js$/,
  /^semver$/,
  /^uuid$/,
  /^nanoid$/,
  /^date-fns(?:\/|$)/,
  /^moment$/,
  /^dayjs$/,
  /^chalk$/,
  /^kleur$/,
  /^debug$/,
  /^ms$/,
];

/* ======================================================
   UTILITIES
====================================================== */

function printMessages(messages) {
  for (const m of messages) {
    const prefix =
      m.level === "error" ? "❌" : m.level === "warn" ? "⚠️" : "ℹ️";
    console.log(`${prefix} ${m.text}`);
  }
}

function safeTestStem(sourceFile, fnName) {
  const base = path.basename(sourceFile, path.extname(sourceFile));
  return `${base}.${fnName}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function computeImportPath(sourceFileAbs) {
  const fromDir = path.resolve("tests", "generated");
  let rel = path.relative(fromDir, sourceFileAbs);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.split(path.sep).join(path.posix.sep);
}

function cleanGeneratedTests() {
  const genDir = path.resolve("tests", "generated");
  if (!fs.existsSync(genDir)) return;

  for (const f of fs.readdirSync(genDir)) {
    if (f.endsWith(".test.js") || f.endsWith(".mocks.js")) {
      try {
        fs.unlinkSync(path.join(genDir, f));
      } catch {}
    }
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeModuleName(moduleName) {
  return String(moduleName || "").replace(/^node:/, "");
}

function isRelativeOrLocalModule(moduleName) {
  const m = String(moduleName || "");
  return (
    m.startsWith("./") ||
    m.startsWith("../") ||
    m.startsWith("/") ||
    m.startsWith("file:")
  );
}

function isGlobalModule(moduleName) {
  return String(moduleName || "").startsWith("global:");
}

function isBuiltinModule(moduleName) {
  const normalized = normalizeModuleName(moduleName);

  if (BUILTIN_MODULES.has(normalized)) return true;

  const base = normalized.split("/")[0];
  return BUILTIN_MODULES.has(base);
}

function isExternalModule(moduleName) {
  const normalized = normalizeModuleName(moduleName);

  if (!normalized) return false;
  if (isGlobalModule(normalized)) return false;
  if (isRelativeOrLocalModule(normalized)) return false;
  if (isBuiltinModule(normalized)) return false;

  return true;
}

function isRiskyExternalModule(moduleName) {
  const normalized = normalizeModuleName(moduleName);
  return RISKY_EXTERNAL_PATTERNS.some((re) => re.test(normalized));
}

function isPureUtilityModule(moduleName) {
  const normalized = normalizeModuleName(moduleName);
  return PURE_UTILITY_PATTERNS.some((re) => re.test(normalized));
}

function getImportInfoModuleName(info) {
  if (!info) return "";

  if (typeof info === "string") return info;

  return info.normalizedModuleName || info.moduleName || "";
}

function getImportInfoOriginalModuleName(info) {
  if (!info) return "";

  if (typeof info === "string") return info;

  return info.moduleName || info.normalizedModuleName || "";
}

function flattenExportTargets(value, acc = []) {
  if (!value) return acc;

  if (typeof value === "string") {
    acc.push(value);
    return acc;
  }

  if (Array.isArray(value)) {
    for (const item of value) flattenExportTargets(item, acc);
    return acc;
  }

  if (typeof value === "object") {
    for (const v of Object.values(value)) {
      flattenExportTargets(v, acc);
    }
  }

  return acc;
}

function isBadEntryCandidate(absPath) {
  const lower = String(absPath || "").replace(/\\/g, "/").toLowerCase();
  const base = path.basename(lower);

  if (!base.endsWith(".js")) return true;
  if (base.endsWith(".min.js")) return true;
  if (base.includes(".bundle.")) return true;
  if (base.includes("-bundle.")) return true;
  if (base.includes(".umd.")) return true;
  if (base.includes(".esm-browser.")) return true;
  if (lower.includes("/vendor/")) return true;
  if (lower.includes("/coverage/")) return true;

  return false;
}

function normalizeCandidateEntry(projectRoot, relPath) {
  if (!relPath || typeof relPath !== "string") return null;

  let cleaned = relPath.trim();

  if (cleaned.startsWith("node:")) return null;
  if (cleaned.startsWith("http:") || cleaned.startsWith("https:")) return null;

  if (cleaned === ".") {
    cleaned = "index.js";
  } else if (cleaned.startsWith("./")) {
    cleaned = cleaned.slice(2);
  }

  const abs = path.resolve(projectRoot, cleaned);

  if (
    fs.existsSync(abs) &&
    fs.statSync(abs).isFile() &&
    !isBadEntryCandidate(abs)
  ) {
    return abs;
  }

  const withJs = `${abs}.js`;
  if (
    fs.existsSync(withJs) &&
    fs.statSync(withJs).isFile() &&
    !isBadEntryCandidate(withJs)
  ) {
    return withJs;
  }

  const asIndex = path.join(abs, "index.js");
  if (
    fs.existsSync(asIndex) &&
    fs.statSync(asIndex).isFile() &&
    !isBadEntryCandidate(asIndex)
  ) {
    return asIndex;
  }

  return null;
}

function getPackageEntryFiles(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return [];

  const pkg = readJsonSafe(pkgPath);
  if (!pkg) return [];

  const rawCandidates = [];

  if (typeof pkg.main === "string") rawCandidates.push(pkg.main);
  if (typeof pkg.module === "string") rawCandidates.push(pkg.module);
  if (typeof pkg.browser === "string") rawCandidates.push(pkg.browser);

  flattenExportTargets(pkg.exports, rawCandidates);

  rawCandidates.push("index.js");

  const seen = new Set();
  const files = [];

  for (const rel of rawCandidates) {
    const abs = normalizeCandidateEntry(projectRoot, rel);
    if (!abs) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    files.push(abs);
  }

  return files;
}
function shouldSkipSourceFile(
  filePathAbs,
  entryFileSet = new Set(),
  { skipUnsafeSourceFiles = false } = {}
) {
  const lower = String(filePathAbs || "").replace(/\\/g, "/").toLowerCase();
  const base = path.basename(lower);

  /*
    Always skip generated/bundled/vendor-style artifacts.
    These are bad targets for direct file, folder, and package modes.
  */

  if (
    lower.includes("/dist/umd/") ||
    lower.includes("/umd/") ||
    lower.includes("/browser/") ||
    lower.endsWith(".umd.js") ||
    lower.endsWith(".bundle.js") ||
    lower.endsWith(".bundled.js")
  ) {
    return true;
  }

  if (entryFileSet.has(filePathAbs)) return false;

  if (base.endsWith(".min.js")) return true;
  if (base.includes(".bundle.")) return true;
  if (base.includes("-bundle.")) return true;
  if (base.includes(".umd.")) return true;
  if (base.includes(".esm-browser.")) return true;
  if (lower.includes("/vendor/")) return true;
  if (lower.includes("/coverage/")) return true;

  /*
    Package unsafe-source filtering is only enabled for safe full-scan fallback.
    It must not affect direct file input such as tests/sample/input.js.
  */
  if (skipUnsafeSourceFiles) {
    const unsafePackageSourcePatterns = [
      "/test/",
      "/tests/",
      "/__tests__/",
      "/spec/",
      "/__mocks__/",
      "/server/",
      "/demo/",
      "/demos/",
      "/example/",
      "/examples/",
      "/benchmark/",
      "/benchmarks/",
      "/bench/",
      "/tools/",
      "/tap-snapshots/",
      "/fixtures/",
      "/fixture/",
    ];

    if (unsafePackageSourcePatterns.some((pattern) => lower.includes(pattern))) {
      return true;
    }

    const unsafeBaseNames = new Set([
      "test.js",
      "tests.js",
      "spec.js",
      "testem.js",
      "karma.conf.js",
      "webpack.config.js",
      "rollup.config.js",
      "babel.config.js",
      "ember-cli-build.js",
      "gulpfile.js",
      "gruntfile.js",
    ]);

    if (unsafeBaseNames.has(base)) return true;

    if (base.startsWith("-")) return true;

    if (
      base.includes("internal") ||
      base.includes("rethrow") ||
      base.includes("instrument")
    ) {
      return true;
    }
  }

  return false;
}
function shouldSkipUnsafeFullScanTarget(filePathAbs, code = "", exportedFunctions = []) {
  const lower = String(filePathAbs || "").replace(/\\/g, "/").toLowerCase();
  const base = path.basename(lower);

  /*
    This helper runs only in safe full-scan fallback.
    It must NOT run for package-entry mode or dynamic-api mode.
  */

  const unsafeFileNameParts = [
    "promise-hash",
    "enumerator",
    "map-enumerator",
    "then",
    "config",
    "events",
    "instrument",
    "rethrow",
    "internal",
  ];

  if (unsafeFileNameParts.some((part) => base.includes(part))) {
    return true;
  }

  for (const fn of exportedFunctions || []) {
    const fnCode = String(fn?.code || "");

    if (
      /\bthis\._/.test(fnCode) ||
      /\bnew\s+Enumerator\s*\(/.test(fnCode)
    ) {
      return true;
    }
  }

  /*
    Functions that rely on `this` are unsafe as standalone direct calls.
    Example: function all(...) { return this.reject(...) }
  */
  for (const fn of exportedFunctions || []) {
    const fnCode = String(fn?.code || "");

    if (/\bthis\s*\./.test(fnCode)) {
      return true;
    }

    if (fn?.isClassLike) {
      const name = String(fn.name || "").toLowerCase();

      /*
        Keep normal exported classes possible, but skip internal-looking
        constructor engines in safe full scan.
      */
      if (
        name.includes("enumerator") ||
        name.includes("hash") ||
        name.includes("internal")
      ) {
        return true;
      }
    }
  }

  return false;
}

function normalizeWorkspaceIdentity(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/\.(?:js|mjs|cjs)$/i, "")
    .replace(/[-_.](?:master|main)$/i, "")
    .replace(/[-_.](?:monorepo|workspace)$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function getWorkspacePatternsFromPackageJson(pkg = {}) {
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
  if (Array.isArray(pkg.workspaces?.packages)) return pkg.workspaces.packages;
  return [];
}

function expandSimpleWorkspacePattern(packageRoot, pattern) {
  const normalized = String(pattern || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return [];

  // UnitGen only needs the common npm/yarn workspace forms here. Complex
  // globbing is intentionally avoided so package discovery stays bounded.
  if (!normalized.includes("*")) {
    const abs = path.resolve(packageRoot, normalized);
    return fs.existsSync(path.join(abs, "package.json")) ? [abs] : [];
  }

  const starIndex = normalized.indexOf("*");
  const prefix = normalized.slice(0, starIndex).replace(/\/+$/, "");
  const suffix = normalized.slice(starIndex + 1).replace(/^\/+/, "");
  const parent = path.resolve(packageRoot, prefix || ".");
  if (!fs.existsSync(parent)) return [];

  const roots = [];
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = suffix
      ? path.join(parent, entry.name, suffix)
      : path.join(parent, entry.name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      roots.push(candidate);
    }
  }
  return roots;
}

function findMatchingWorkspacePackageRoot(packageRoot) {
  if (!packageRoot || !fs.existsSync(path.join(packageRoot, "package.json"))) {
    return null;
  }

  const rootPkg = readJsonSafe(path.join(packageRoot, "package.json")) || {};
  const patterns = getWorkspacePatternsFromPackageJson(rootPkg);
  if (patterns.length === 0) return null;

  const requestedIdentity = normalizeWorkspaceIdentity(path.basename(packageRoot));
  const rootNameIdentity = normalizeWorkspaceIdentity(rootPkg.name);
  const candidates = [];

  for (const pattern of patterns) {
    for (const root of expandSimpleWorkspacePattern(packageRoot, pattern)) {
      const pkg = readJsonSafe(path.join(root, "package.json")) || {};
      const nameIdentity = normalizeWorkspaceIdentity(pkg.name);
      if (!nameIdentity) continue;

      let score = 0;
      if (nameIdentity === requestedIdentity) score += 100;
      if (nameIdentity === rootNameIdentity && rootNameIdentity !== requestedIdentity) score += 40;
      if (rootPkg.private === true && nameIdentity === requestedIdentity) score += 30;
      if (pkg.private !== true) score += 5;
      if (pkg.main || pkg.module || pkg.exports || pkg.browser) score += 3;

      candidates.push({ root, pkg, nameIdentity, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));
  const best = candidates[0];

  // Do not redirect a workspace root based on weak metadata alone. An exact
  // identity match between an archive/folder name and a publishable workspace
  // is strong enough; otherwise keep the original package scan unchanged.
  if (!best || best.score < 100) return null;
  return best.root;
}

function selectFilesForTesting(input) {
  /*
    UnitGen normally keeps its full-package scan. For workspace orchestration
    roots, however, scanning every sibling workspace changes the program under
    test and can load unrelated package implementations. When the requested
    folder identity exactly matches one publishable workspace, restrict the
    static scan to that workspace. Dynamic API discovery uses the same kind of
    workspace normalization independently.
  */
  const workspaceRoot = isPackageFolderInput(input)
    ? findMatchingWorkspacePackageRoot(input.root)
    : null;

  if (workspaceRoot) {
    const prefix = `${path.resolve(workspaceRoot)}${path.sep}`;
    const workspaceFiles = (input.files || []).filter((filePath) => {
      const abs = path.resolve(filePath);
      return abs === path.resolve(workspaceRoot) || abs.startsWith(prefix);
    });

    if (workspaceFiles.length > 0) {
      return {
        mode: "standard",
        files: workspaceFiles,
        entryFileSet: new Set(),
        projectRoot: workspaceRoot,
        workspaceRoot,
      };
    }
  }

  return {
    mode: "standard",
    files: input.files,
    entryFileSet: new Set(),
    projectRoot: input.root,
    workspaceRoot: null,
  };
}

function isPackageFolderInput(input) {
  return (
    input?.kind === "folder" &&
    input?.root &&
    fs.existsSync(path.join(input.root, "package.json"))
  );
}
function shouldTryDynamicApiFallback(input) {
  /*
    Dynamic API discovery is a package-level fallback for public APIs that
    static extraction cannot identify, such as CommonJS factory/IIFE exports
    and runtime-built export objects. It should not run for plain folders or
    single files because requiring arbitrary paths is higher risk there.
  */
  return isPackageFolderInput(input);
}

function shouldSupplementWithDynamicApiDiscovery(input, generatedTestFiles) {
  if (!shouldTryDynamicApiFallback(input)) return false;
  if (generatedTestFiles <= 0) return false;

  /*
    A high static-test count does not prove that the installed package's public
    API was exercised. Full-package scans often find many internal factories,
    build helpers, or implementation files while missing runtime-built exports.
    Treat the runtime public API as a complementary surface for every package
    scan; dynamic candidates still pass their own preflight and later pipeline
    safety/runtime validation.
  */
  return true;
}

function shouldSupplementAfterSafetyPreflight({
  input,
  generationFlow,
  beforePreflightCount,
  afterPreflightCount,
}) {
  if (!shouldTryDynamicApiFallback(input)) return false;
  if (String(generationFlow || "").includes("dynamic-api")) return false;
  if (afterPreflightCount <= 0) return false;

  if (shouldSupplementWithDynamicApiDiscovery(input, afterPreflightCount)) {
    return true;
  }

  const removalRatio = beforePreflightCount > 0
    ? (beforePreflightCount - afterPreflightCount) / beforePreflightCount
    : 0;

  const maxRemovedRatio = Number(
    process.env.UNITGEN_DYNAMIC_SUPPLEMENT_PREFLIGHT_REMOVAL_RATIO || 0.5
  );

  return removalRatio >= maxRemovedRatio;
}

function countDynamicBehaviorContexts(contexts = []) {
  return (Array.isArray(contexts) ? contexts : []).filter(
    (ctx) => Boolean(ctx?.isDynamicApi)
  ).length;
}

function getDynamicBehaviorContextLimit(contexts = []) {
  const rawConfigured = process.env.UNITGEN_DYNAMIC_BEHAVIOR_CONTEXT_LIMIT;

  // An explicit environment setting remains authoritative for users who need
  // a strict operational budget.
  if (rawConfigured !== undefined && rawConfigured !== "") {
    const configured = Number(rawConfigured);
    if (Number.isFinite(configured) && configured >= 0) {
      return Math.floor(configured);
    }
  }

  const dynamicContexts = (Array.isArray(contexts) ? contexts : []).filter(
    (ctx) => Boolean(ctx?.isDynamicApi)
  );

  const suggested = dynamicContexts.reduce((maxValue, ctx) => {
    const value = Number(ctx?.dynamicBehaviorSuggestedSuccessLimit);
    if (!Number.isFinite(value) || value < 0) return maxValue;
    return Math.max(maxValue, Math.floor(value));
  }, 0);

  /*
   * Ordinary packages keep the historical 120-success budget even though the
   * behavior-candidate pool can contain up to 200 contexts for backfilling.
   * Only a generator-proven large semantic surface raises this allowance.
   */
  return suggested > 120 ? Math.min(420, suggested) : 120;
}

function getDynamicBehaviorAttemptLimit(
  successLimit = getDynamicBehaviorContextLimit(),
  contexts = []
) {
  const configured = Number(
    process.env.UNITGEN_DYNAMIC_BEHAVIOR_CONTEXT_ATTEMPT_LIMIT
  );

  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }

  if (successLimit <= 0) return 0;

  const discoveredBehaviorContexts = countDynamicBehaviorContexts(contexts);
  if (discoveredBehaviorContexts > 0) {
    // Try all semantically selected contexts when useful, while preserving the
    // old 3x backfill ceiling for explicitly smaller success budgets.
    return Math.max(
      successLimit,
      Math.min(discoveredBehaviorContexts, successLimit * 3)
    );
  }

  // Before contexts exist (post-preflight planning), retain the established
  // bounded backfill allowance.
  return Math.max(successLimit, successLimit * 3);
}

function shouldAddPostPreflightDynamicBehaviorContexts(generatedTestFiles) {
  const maxStaticTestsForPostPreflightBehavior = Number(
    process.env.UNITGEN_POST_PREFLIGHT_DYNAMIC_BEHAVIOR_STATIC_TEST_FLOOR ||
      process.env.UNITGEN_DYNAMIC_SUPPLEMENT_STATIC_TEST_FLOOR ||
      25
  );

  return generatedTestFiles < maxStaticTestsForPostPreflightBehavior;
}

function shouldExpandPackageEntryPublicApis({
  selection,
  generatedTestFiles,
  expandedFiles,
}) {
  if (selection.mode !== "package-entry") return false;
  if (generatedTestFiles <= 0) return false;
  if (!Array.isArray(expandedFiles) || expandedFiles.length === 0) return false;

  /*
    Expand only when the package entry has additional public local APIs.
    We do not use a fixed "small entry" number alone. The expander must
    actually find public exported/re-exported local modules first.
  */
  return true;
}

function getPackageRootName(moduleName) {
  const normalized = normalizeModuleName(moduleName);
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length === 0) return normalized;

  if (parts[0].startsWith("@") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0];
}

function canResolveModuleFrom(moduleName, basedir = process.cwd()) {
  const normalized = normalizeModuleName(moduleName);
  if (!normalized) return false;

  const fakeFile = path.join(basedir, "__unitgen_resolve__.js");

  try {
    const localRequire = createRequire(fakeFile);
    localRequire.resolve(normalized);
    return true;
  } catch {}

  try {
    rootRequire.resolve(normalized);
    return true;
  } catch {}

  return false;
}

function shouldMockTopLevelExternalModule(moduleName, { filePathAbs = "" } = {}) {
  const normalized = normalizeModuleName(moduleName);

  if (!isExternalModule(normalized)) return false;

  const basedir = filePathAbs ? path.dirname(filePathAbs) : process.cwd();
  const isResolvable = canResolveModuleFrom(normalized, basedir);

  /*
    Risky modules should be mocked because real network/database/browser/cloud
    calls are unstable and unsafe in generated unit tests.
  */
  if (isRiskyExternalModule(normalized)) return true;

  /*
    Pure utility dependencies should run normally if available. Mocking lodash,
    fast-diff, compute-deg2rad, etc. can weaken or break real behavior.
  */
  if (isPureUtilityModule(normalized) && isResolvable) return false;

  /*
    Missing externals need a safe mock/stub so package loading does not crash.
  */
  if (!isResolvable) return true;

  return false;
}

function applyExternalMockPolicyToFunctionPlan(mockPlan = {}, { filePathAbs = "" } = {}) {
  return Object.fromEntries(
    Object.entries(mockPlan || {}).map(([targetName, entries]) => [
      targetName,
      (Array.isArray(entries) ? entries : []).filter((entry) => {
        if (entry?.type !== "external") return true;

        return shouldMockTopLevelExternalModule(
          entry.normalizedModule || entry.module,
          { filePathAbs }
        );
      }),
    ])
  );
}

function buildCjsStubSource(moduleName) {
  const normalized = normalizeModuleName(moduleName);

  const isDeg2Rad = normalized.includes("deg2rad");
  const isRad2Deg = normalized.includes("rad2deg");
  const isCloneDeep = normalized.includes("clonedeep");
  const isIsEqual = normalized.includes("isequal") || normalized.includes("is-equal");
  const isDiff = normalized.includes("diff");

  if (isDeg2Rad) {
    return `function deg2rad(x) {
  return Number(x || 0) * Math.PI / 180;
}
module.exports = deg2rad;
module.exports.default = deg2rad;
module.exports.deg2rad = deg2rad;
`;
  }

  if (isRad2Deg) {
    return `function rad2deg(x) {
  return Number(x || 0) * 180 / Math.PI;
}
module.exports = rad2deg;
module.exports.default = rad2deg;
module.exports.rad2deg = rad2deg;
`;
  }

  if (isCloneDeep) {
    return `function cloneDeep(value) {
  try {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  } catch {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === "object") return { ...value };
    return value;
  }
}
module.exports = cloneDeep;
module.exports.default = cloneDeep;
module.exports.cloneDeep = cloneDeep;
`;
  }

  if (isIsEqual) {
    return `function isEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return Object.is(a, b);
  }
}
module.exports = isEqual;
module.exports.default = isEqual;
module.exports.isEqual = isEqual;
`;
  }

  if (isDiff) {
    return `function diff(a, b) {
  if (a === b) return [[0, a || ""]];
  return [[-1, a || ""], [1, b || ""]];
}
module.exports = diff;
module.exports.default = diff;
module.exports.diff = diff;
`;

  }

  return `function unitgenStub(...args) {
  return args.length > 0 ? args[0] : {};
}

const api = Object.assign(unitgenStub, {
  get: async () => ({ data: {}, status: 200, headers: {} }),
  post: async () => ({ data: {}, status: 200, headers: {} }),
  put: async () => ({ data: {}, status: 200, headers: {} }),
  patch: async () => ({ data: {}, status: 200, headers: {} }),
  delete: async () => ({ data: {}, status: 200, headers: {} }),
  request: async () => ({ data: {}, status: 200, headers: {} }),
  create: () => api,
  cloneDeep: (value) => {
    try {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  },
  isEqual: (a, b) => {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return Object.is(a, b);
    }
  },
  diff: (a, b) => (a === b ? [[0, a || ""]] : [[-1, a || ""], [1, b || ""]]),
  deg2rad: (x) => Number(x || 0) * Math.PI / 180,
  rad2deg: (x) => Number(x || 0) * 180 / Math.PI
});

module.exports = api;
module.exports.default = api;
module.exports.get = api.get;
module.exports.post = api.post;
module.exports.put = api.put;
module.exports.patch = api.patch;
module.exports.request = api.request;
module.exports.create = api.create;
module.exports.cloneDeep = api.cloneDeep;
module.exports.isEqual = api.isEqual;
module.exports.diff = api.diff;
module.exports.deg2rad = api.deg2rad;
module.exports.rad2deg = api.rad2deg;
`;
}

function ensureMissingExternalModuleStubs(moduleNames = []) {
  const rootNodeModules = path.resolve(process.cwd(), "node_modules");

  for (const rawName of moduleNames) {
    const moduleName = normalizeModuleName(String(rawName || "").trim());

    if (!moduleName) continue;
    if (!isExternalModule(moduleName)) continue;

    const packageRootName = getPackageRootName(moduleName);
    if (!packageRootName) continue;

    const packageDir = packageRootName.startsWith("@")
      ? path.join(rootNodeModules, ...packageRootName.split("/"))
      : path.join(rootNodeModules, packageRootName);

    if (fs.existsSync(packageDir)) continue;

    fs.mkdirSync(packageDir, { recursive: true });

    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: packageRootName,
          version: "0.0.0-unitgen-stub",
          main: "index.cjs",
        },
        null,
        2
      )
    );

    fs.writeFileSync(
      path.join(packageDir, "index.cjs"),
      buildCjsStubSource(moduleName)
    );
  }
}

/*
  Important:
  Do NOT split mock code by blank lines.

  Multi-line Jest mocks often contain blank lines inside the factory:

    jest.mock("x", () => {
      const api = {...};

      return {...};
    });

  Splitting on blank lines breaks the mock into invalid fragments and creates
  generated tests with top-level `return` or unexpected EOF. This helper keeps
  rendered mock strings intact.
*/
function combineMockCode(...parts) {
  const seen = new Set();
  const blocks = [];

  for (const part of parts) {
    const code = String(part || "").trim();
    if (!code) continue;

    if (seen.has(code)) continue;
    seen.add(code);
    blocks.push(code);
  }

  return blocks.join("\n\n");
}

function countRenderedMockBlocks(code = "") {
  const source = String(code || "");
  const matches = source.match(/\bjest\.(?:mock|unstable_mockModule)\s*\(/g);
  return matches ? matches.length : 0;
}

function dedupeObjects(items, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function buildTopLevelExternalMockEntries(importMap = {}, options = {}) {
  const modulePlans = new Map();

  for (const [localName, rawInfo] of Object.entries(importMap || {})) {
    const originalModule = getImportInfoOriginalModuleName(rawInfo);
    const normalizedModule = getImportInfoModuleName(rawInfo);

    if (!shouldMockTopLevelExternalModule(normalizedModule, options)) {
      continue;
    }

    const key = normalizedModule;

    if (!modulePlans.has(key)) {
      modulePlans.set(key, {
        module: originalModule || normalizedModule,
        normalizedModule,
        type: "external",
        imports: [],
        members: [],
        memberChains: [],
        globals: [],
        targets: [],
        usages: [],
        mockReason: isRiskyExternalModule(normalizedModule)
          ? "risky-external"
          : "missing-external",
      });
    }

    const entry = modulePlans.get(key);

    const importInfo =
      typeof rawInfo === "string"
        ? {
            localName,
            importKind: "unknown",
            importedName: "*",
            sourceType: "unknown",
            accessPath: [],
          }
        : {
            localName: rawInfo.localName || localName,
            importKind: rawInfo.importKind || "unknown",
            importedName: rawInfo.importedName || "*",
            sourceType: rawInfo.sourceType || "unknown",
            accessPath: Array.isArray(rawInfo.accessPath)
              ? rawInfo.accessPath
              : [],
          };

    entry.imports.push(importInfo);
    entry.targets.push(importInfo.localName);

    if (
      importInfo.importedName &&
      !["*", "default"].includes(importInfo.importedName)
    ) {
      entry.members.push(importInfo.importedName);
      entry.targets.push(importInfo.importedName);
    }
  }

  return Array.from(modulePlans.values()).map((entry) => ({
    ...entry,
    imports: dedupeObjects(entry.imports, (x) =>
      [
        x.localName,
        x.importKind,
        x.importedName,
        x.sourceType,
        (x.accessPath || []).join("."),
      ].join("|")
    ),
    members: Array.from(new Set(entry.members.filter(Boolean))),
    targets: Array.from(new Set(entry.targets.filter(Boolean))),
  }));
}

function getContextProjectRoot({ options = {}, filePathAbs = "" }) {
  if (options.projectRoot && fs.existsSync(options.projectRoot)) {
    return options.projectRoot;
  }

  if (filePathAbs) {
    return path.dirname(filePathAbs);
  }

  return process.cwd();
}

function normalizeParamList(params = []) {
  return (params || []).map((p, index) => {
    if (typeof p === "string") return p;
    if (p?.name) return p.name;
    return `arg${index + 1}`;
  });
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/* ======================================================
   TARGET KEY HELPERS
====================================================== */

function getTargetKey(target = {}) {
  return (
    target.targetKey ||
    target.displayName ||
    target.name ||
    target.fnName ||
    target.methodName ||
    ""
  );
}

function getTargetAliases(target = {}) {
  const aliases = new Set();

  const add = (value) => {
    const v = String(value || "").trim();
    if (v) aliases.add(v);
  };

  add(target.targetKey);
  add(target.displayName);
  add(target.name);
  add(target.fnName);
  add(target.methodName);

  if (target.ownerClassName && target.methodName) {
    add(`${target.ownerClassName}.${target.methodName}`);
    add(`${target.ownerClassName}.prototype.${target.methodName}`);
  }

  if (Array.isArray(target.dependencyAliases)) {
    for (const alias of target.dependencyAliases) add(alias);
  }

  return Array.from(aliases);
}

function getTargetMapValue(map = {}, target = {}) {
  for (const alias of getTargetAliases(target)) {
    if (Object.prototype.hasOwnProperty.call(map || {}, alias)) {
      return map[alias];
    }
  }

  return undefined;
}

function rekeyMapForTargets(map = {}, targets = [], defaultValue = []) {
  const out = { ...(map || {}) };

  for (const target of targets || []) {
    const key = getTargetKey(target);
    if (!key) continue;

    if (Object.prototype.hasOwnProperty.call(out, key)) continue;

    const value = getTargetMapValue(map, target);

    if (value !== undefined) {
      out[key] = value;
    } else if (Array.isArray(defaultValue)) {
      out[key] = [];
    } else {
      out[key] = defaultValue;
    }
  }

  return out;
}

function normalizeDependencyMapsForTargets({
  usage = {},
  memberUsage = {},
  dependencyUsage = {},
  targets = [],
}) {
  return {
    usageByTarget: rekeyMapForTargets(usage, targets, []),
    memberUsageByTarget: rekeyMapForTargets(memberUsage, targets, []),
    dependencyUsageByTarget: rekeyMapForTargets(dependencyUsage, targets, []),
  };
}

/* ======================================================
   CLASS TARGET HELPERS
====================================================== */

function normalizeClassAnalysisResult(raw) {
  if (!raw) return [];

  if (Array.isArray(raw)) return raw;

  if (Array.isArray(raw.classes)) return raw.classes;
  if (Array.isArray(raw.classExports)) return raw.classExports;
  if (Array.isArray(raw.records)) return raw.records;

  if (typeof raw === "object") {
    return Object.values(raw).filter(
      (x) => x && typeof x === "object" && (x.className || x.name)
    );
  }

  return [];
}

function analyzeClassesSafely({ code }) {
  try {
    const result = analyzeClassExports(code);
    return normalizeClassAnalysisResult(result);
  } catch (e) {
    console.log(`⚠️ Class export analysis skipped: ${e?.message ?? e}`);
    return [];
  }
}

function getClassName(record) {
  return record?.className || record?.name || "";
}

function getClassConstructorParams(record) {
  return normalizeParamList(
    record?.constructorParams ||
      record?.params ||
      record?.constructor?.params ||
      []
  );
}

function getClassConstructorCode(record) {
  return (
    record?.constructorCode ||
    record?.constructor?.code ||
    record?.classCode ||
    record?.code ||
    ""
  );
}

function getClassMethods(record) {
  return safeArray(record?.methods)
    .map((method) => ({
      name: method?.name || method?.methodName || "",
      params: normalizeParamList(method?.params || []),
      isAsync: !!method?.isAsync,
      kind: method?.kind || method?.methodKind || "prototype",
      code: method?.code || "",
      docComment: method?.docComment || method?.comment || null,
    }))
    .filter((method) => {
      if (!method.name) return false;
      if (method.name === "constructor") return false;
      return true;
    });
}

function escapeRegExp(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildKnownAsyncTargetNames({
  functions = [],
  classMethodTargets = [],
} = {}) {
  const names = new Set();

  const add = (value) => {
    const name = String(value || "").trim();
    if (name) names.add(name);
  };

  for (const fn of functions || []) {
    if (!fn?.isAsync) continue;
    add(fn.name);
    add(fn.fnName);
    add(fn.targetKey);
    add(fn.displayName);
  }

  for (const target of classMethodTargets || []) {
    if (!target?.isAsync) continue;
    add(target.methodName);
    add(target.fnName);
    add(target.targetKey);
    add(target.displayName);

    if (target.ownerClassName && target.methodName) {
      add(`${target.ownerClassName}.${target.methodName}`);
      add(`${target.ownerClassName}.prototype.${target.methodName}`);
    }
  }

  return names;
}

function functionReturnsKnownAsyncValue(functionCode = "", asyncTargetNames = new Set()) {
  const code = String(functionCode || "");

  if (/\breturn\s+(?:new\s+)?Promise\b/.test(code)) return true;
  if (/\breturn\s+Promise\./.test(code)) return true;
  if (/\breturn\s+[^;]*\.then\s*\(/.test(code)) return true;

  for (const name of asyncTargetNames || []) {
    const escaped = escapeRegExp(name);
    if (!escaped) continue;

    const directCall = new RegExp(
      `\\breturn\\s+(?:await\\s+)?${escaped}\\s*\\(`,
      "m"
    );
    if (directCall.test(code)) return true;
  }

  return false;
}

function isEffectivelyAsyncFunction(fn = {}, asyncTargetNames = new Set()) {
  const code = String(fn.code || fn.functionCode || "");

  return (
    !!fn.isAsync ||
    code.trim().startsWith("async") ||
    /\bawait\b/.test(code) ||
    functionReturnsKnownAsyncValue(code, asyncTargetNames)
  );
}

function getUsageAliasesForFunction(fn, sourceFile = "") {
  const aliases = new Set();
  const add = (value) => {
    const name = String(value || "").trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) aliases.add(name);
  };

  add(fn?.name);

  if (fn?.isDefault) {
    const code = String(fn?.code || "");
    const declaredName = code.match(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/)?.[1];
    add(declaredName);

    const baseName = path.basename(String(sourceFile || ""), path.extname(String(sourceFile || "")));
    add(baseName);
    add(baseName.replace(/[-_]+([A-Za-z0-9])/g, (_, ch) => ch.toUpperCase()));
  }

  return Array.from(aliases);
}

function mergeUsageSnippets(usageSnippetsByFunction = {}, aliases = []) {
  const seen = new Set();
  const merged = [];
  for (const alias of aliases) {
    for (const snippet of usageSnippetsByFunction?.[alias] || []) {
      const key = `${snippet?.relativePath || ""}::${snippet?.snippet || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(snippet);
    }
  }
  return merged.sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
}
function buildClassMap(classRecords = []) {
  const map = new Map();

  for (const record of classRecords) {
    const className = getClassName(record);
    if (!className) continue;
    map.set(className, record);
  }

  return map;
}

function getClassRecordForFunction(fn, classMap) {
  if (!fn?.name) return null;
  return classMap.get(fn.name) || null;
}

function shouldGenerateClassMethodTarget(method) {
  if (!method?.name) return false;
  if (method.name.startsWith("_")) return false;
  if (method.name === "constructor") return false;

  /*
    Keep method targets practical and safe.
    Getters/setters and computed/private members should be handled later.
  */
  if (method.kind === "getter" || method.kind === "setter") return false;

  return true;
}

function buildClassMethodTargets({
  classRecord,
  sourceFile,
  importPath,
  usageSnippetsByFunction,
  docCommentsByFunction,
}) {
  const className = getClassName(classRecord);
  if (!className) return [];

  const constructorParams = getClassConstructorParams(classRecord);
  const constructorCode = getClassConstructorCode(classRecord);
  const classCode = classRecord?.classCode || classRecord?.code || constructorCode;
  const methods = getClassMethods(classRecord).filter(shouldGenerateClassMethodTarget);

  const targets = [];

  for (const method of methods) {
    const methodName = method.name;
    const methodKind = method.kind || "prototype";
    const displayName =
      methodKind === "static"
        ? `${className}.${methodName}`
        : `${className}.prototype.${methodName}`;

    const dependencyAliases = [
      displayName,
      methodName,
      `${className}.${methodName}`,
      `${className}.prototype.${methodName}`,
    ];

    targets.push({
      name: methodName,
      fnName: methodName,
      targetKey: displayName,
      displayName,
      dependencyAliases,
      isAsync: !!method.isAsync || /\bawait\b/.test(method.code || ""),
      isDefault: false,
      isClassLike: false,
      isClassMethod: true,
      ownerClassName: className,
      methodName,
      methodKind,
      constructorParams,
      constructorCode,
      classCode,
      params: method.params,
      code: method.code || classCode,
      functionCode: method.code || classCode,
      sourceFile,
      importPath,
      usageSnippets:
        usageSnippetsByFunction?.[displayName] ||
        usageSnippetsByFunction?.[methodName] ||
        usageSnippetsByFunction?.[className] ||
        [],
      docComment:
        method.docComment ||
        docCommentsByFunction?.[displayName] ||
        docCommentsByFunction?.[methodName] ||
        docCommentsByFunction?.[className] ||
        classRecord?.docComment ||
        null,
      mockHeader: "",
      mockEntries: [],
      dependencyUsage: [],
      dependencies: [],
      classMethods: methods.map((m) => m.name),
    });
  }

  return targets;
}

function printClassExportSummary(classRecords = []) {
  console.log("🏛️ Class export analysis:");

  if (!classRecords.length) {
    console.log("   - none");
    return;
  }

  for (const record of classRecords) {
    const className = getClassName(record);
    const methods = getClassMethods(record);

    const prototypeMethods = methods.filter((m) => m.kind !== "static");
    const staticMethods = methods.filter((m) => m.kind === "static");

    console.log(
      `   - ${className}: constructor params (${
        getClassConstructorParams(record).join(", ") || "none"
      }), ${prototypeMethods.length} prototype method(s), ${staticMethods.length} static method(s)`
    );

    if (prototypeMethods.length) {
      console.log(
        `     prototype: ${prototypeMethods.map((m) => m.name).join(", ")}`
      );
    }

    if (staticMethods.length) {
      console.log(`     static: ${staticMethods.map((m) => m.name).join(", ")}`);
    }
  }
}

/* ======================================================
   DIAGNOSTICS
====================================================== */

function printImportMapSummary(importMap = {}) {
  const entries = Object.entries(importMap || {});

  console.log("🔎 Import map:");

  if (entries.length === 0) {
    console.log("   - none");
    return;
  }

  for (const [localName, info] of entries) {
    if (typeof info === "string") {
      console.log(`   - ${localName} -> ${info} (legacy)`);
      continue;
    }

    const moduleName = info.moduleName || info.normalizedModuleName || "?";
    const normalized = info.normalizedModuleName || normalizeModuleName(moduleName);
    const importKind = info.importKind || "unknown";
    const importedName = info.importedName || "*";
    const sourceType = info.sourceType || "unknown";
    const accessPath =
      Array.isArray(info.accessPath) && info.accessPath.length
        ? ` [${info.accessPath.join(".")}]`
        : "";

    const normalizedText =
      normalized && normalized !== moduleName ? ` normalized:${normalized}` : "";

    console.log(
      `   - ${localName} -> ${moduleName} (${importKind}:${importedName}, ${sourceType}${normalizedText})${accessPath}`
    );
  }
}

function printDependencyUsageSummary(targets = [], dependencyUsage = {}) {
  console.log("🔗 Dependency usage:");

  let printedAny = false;

  for (const target of targets || []) {
    const key = getTargetKey(target);
    const records = dependencyUsage?.[key] || [];

    if (!records.length) continue;

    printedAny = true;
    console.log(`   ${target.displayName || key}:`);

    for (const record of records) {
      const moduleName = record.normalizedModuleName || record.moduleName;
      const usage = record.usage || record.localName || moduleName;
      const kind = record.usageKind || "usage";
      console.log(`   - ${usage} -> ${moduleName} (${kind})`);
    }
  }

  if (!printedAny) {
    console.log("   - none");
  }
}

function printMockPlanSummary(targets = [], mockPlan = {}) {
  console.log("🧩 Mock plan:");

  let printedAny = false;

  for (const target of targets || []) {
    const key = getTargetKey(target);
    const entries = mockPlan?.[key] || [];

    if (!entries.length) continue;

    printedAny = true;
    console.log(`   ${target.displayName || key}:`);

    for (const entry of entries) {
      const moduleName = entry.normalizedModule || entry.module;
      const type = entry.type || "unknown";
      const members = (entry.members || []).join(", ") || "none";
      const chains = (entry.memberChains || [])
        .map((chain) => chain.join("."))
        .join(", ");
      const targetsText = (entry.targets || []).join(", ") || "none";

      const chainText = chains ? ` chains: ${chains};` : "";

      console.log(
        `   - ${moduleName} (${type}) members: ${members}; targets: ${targetsText};${chainText}`
      );
    }
  }

  if (!printedAny) {
    console.log("   - none");
  }
}

function printRenderedMocksSummary(targets = [], jestMocksByFn = {}) {
  console.log("🧪 Rendered mocks:");

  let printedAny = false;

  for (const target of targets || []) {
    const key = getTargetKey(target);
    const code = jestMocksByFn?.[key] || "";
    const count = countRenderedMockBlocks(code);

    if (!count) continue;

    printedAny = true;
    console.log(`   ${target.displayName || key}: ${count} mock block(s)`);
  }

  if (!printedAny) {
    console.log("   - none");
  }
}

function printTopLevelMockSummary(entries = []) {
  if (!entries.length) return;

  console.log("🧱 Top-level external mocks/stubs:");

  for (const entry of entries) {
    const moduleName = entry.normalizedModule || entry.module;
    const reason = entry.mockReason || "required";
    console.log(`   - ${moduleName} (${reason})`);
  }
}

function printUsageSnippetSummary(result = {}) {
  const summary = summarizeUsageSnippetMining(result);

  console.log("📚 Usage snippets:");

  if (!summary.snippetsFound) {
    console.log(`   - none found (${summary.filesScanned} file(s) scanned)`);
    return;
  }

  console.log(
    `   - ${summary.snippetsFound} snippet(s) found from ${summary.filesScanned} scanned file(s)`
  );

  for (const [fnName, count] of Object.entries(summary.perFunction || {})) {
    if (count > 0) {
      console.log(`   - ${fnName}: ${count}`);
    }
  }
}

function printDocCommentSummary(commentMap = {}) {
  const summary = summarizeDocCommentExtraction(commentMap);

  console.log("📝 Doc comments:");

  if (!summary.functionsWithComments) {
    console.log(`   - none found for ${summary.functionsAnalyzed} function(s)`);
    return;
  }

  console.log(
    `   - ${summary.functionsWithComments}/${summary.functionsAnalyzed} function(s) have comment context`
  );

  for (const [fnName, info] of Object.entries(summary.perFunction || {})) {
    if (!info?.hasComment && !info?.hasJsDoc) continue;

    const parts = [];
    if (info.hasJsDoc) parts.push("JSDoc");
    if (info.paramTags) parts.push(`${info.paramTags} param tag(s)`);
    if (info.hasReturns) parts.push("returns");
    if (info.examples) parts.push(`${info.examples} example(s)`);
    if (info.hasComment && !info.hasJsDoc) parts.push("comment");

    console.log(`   - ${fnName}: ${parts.join(", ") || "comment"}`);
  }
}

/* ======================================================
   GENERATION PIPELINE
====================================================== */

function generateFromFiles(files, entryFileSet = new Set(), options = {}) {
  const {
    stopAfterFirstSuccessfulEntry = false,
    safeFullScan = false,
    skipUnsafeSourceFiles = false,
  } = options;

  let processedFiles = 0;
  let skippedFiles = 0;
  let generatedTestFiles = 0;
  let skippedClassLikeExports = 0;
  const llmContexts = [];
  const generatedTestStems = new Set();

  for (const filePathAbs of files) {
    const display = path.relative(process.cwd(), filePathAbs) || filePathAbs;

    if (shouldSkipSourceFile(filePathAbs, entryFileSet, { skipUnsafeSourceFiles })) {
      console.log(`\n==============================`);
      console.log(`📄 Skipping: ${display}`);
      console.log(`==============================`);
      console.log(`⚠️ Skipped generated/minified/bundled artifact.`);
      skippedFiles++;
      continue;
    }

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

    let ast;
    try {
      ast = parseSource(code);
    } catch (e) {
      console.log(`❌ Invalid JavaScript (skipping): ${e?.message ?? e}`);
      skippedFiles++;
      continue;
    }

    processedFiles++;

    const allFunctions = extractFunctions(ast, code);
    if (!allFunctions.length) {
      console.log(`⚠️ No functions detected.`);
      continue;
    }

    const exportedFunctions = allFunctions.filter(
      (f) =>
        f.isExported &&
        f.code &&
        f.code.length > 10 &&
        !f.code.includes("throw new Error('Not implemented')")
    );
    if (
      safeFullScan &&
      shouldSkipUnsafeFullScanTarget(filePathAbs, code, exportedFunctions)
    ) {
      console.log(`⚠️ Safe full-scan skipped context-bound/internal target file.`);
      skippedFiles++;
      continue;
    }

    const classLikeFunctions = exportedFunctions.filter((f) => f.isClassLike);
    const functions = exportedFunctions.map((fn) => ({
      ...fn,
      targetKey: fn.name,
      displayName: fn.name,
      dependencyAliases: [fn.name],
    }));

    console.log(
      `✅ Found ${allFunctions.length} function(s): ${allFunctions
        .map((f) => f.name)
        .join(", ")}`
    );

    if (classLikeFunctions.length > 0) {
      console.log(
        `ℹ️ Class-like exports will use constructor prototype generation: ${classLikeFunctions
          .map((f) => f.name)
          .join(", ")}`
      );
    }

    if (!functions.length) {
      console.log(`⚠️ No exported functions to test.`);
      continue;
    }

    console.log(
      `✅ Exported function(s): ${functions.map((f) => f.name).join(", ")}`
    );

    const importPath = computeImportPath(filePathAbs);

    const classRecords = analyzeClassesSafely({
      code,
    });

    const classMap = buildClassMap(classRecords);
    printClassExportSummary(classRecords);

    const contextProjectRoot = getContextProjectRoot({
      options,
      filePathAbs,
    });

    const usageTargetNames = Array.from(
      new Set(
        [
          ...functions.flatMap((f) => getUsageAliasesForFunction(f, filePathAbs)),
          ...classRecords.flatMap((record) => [
            getClassName(record),
            ...getClassMethods(record).map((m) => m.name),
            ...getClassMethods(record).map(
              (m) => `${getClassName(record)}.${m.name}`
            ),
            ...getClassMethods(record).map(
              (m) => `${getClassName(record)}.prototype.${m.name}`
            ),
          ]),
        ].filter(Boolean)
      )
    );

    const usageSnippetResult = mineUsageSnippetsForFunctions({
      projectRoot: contextProjectRoot,
      fnNames: usageTargetNames,
    });

    const usageSnippetsByFunction =
      usageSnippetResult?.snippetsByFunction || {};

    const docCommentsByFunction = extractDocCommentsForFunctions({
      code,
      functions,
    });

    printUsageSnippetSummary(usageSnippetResult);
    printDocCommentSummary(docCommentsByFunction);

    const rawClassMethodTargets = [];
    for (const fn of functions) {
      const classRecord = getClassRecordForFunction(fn, classMap);

      if (!fn.isClassLike || !classRecord) continue;

      rawClassMethodTargets.push(
        ...buildClassMethodTargets({
          classRecord,
          sourceFile: filePathAbs,
          importPath,
          usageSnippetsByFunction,
          docCommentsByFunction,
        })
      );
    }

    const asyncTargetNames = buildKnownAsyncTargetNames({
      functions,
      classMethodTargets: rawClassMethodTargets,
    });

    const dependencyScanTargets = [
      ...functions,
      ...rawClassMethodTargets.map((target) => ({
        ...target,
        name: target.methodName || target.fnName,
        code: target.functionCode,
        isExported: true,
      })),
    ];

    const {
      importMap,
      usage,
      memberUsage,
      dependencyUsage,
    } = detectImportedIdentifierUsage(code, dependencyScanTargets);

    const {
      usageByTarget,
      memberUsageByTarget,
      dependencyUsageByTarget,
    } = normalizeDependencyMapsForTargets({
      usage,
      memberUsage,
      dependencyUsage,
      targets: dependencyScanTargets,
    });

    printImportMapSummary(importMap);
    printDependencyUsageSummary(dependencyScanTargets, dependencyUsageByTarget);

    const dependencies = convertUsageToModuleDependencies(
      importMap,
      dependencyUsageByTarget
    );

    const mockPlanningTargets = dependencyScanTargets.map((target) => ({
      ...target,
      name: getTargetKey(target),
      fnName: getTargetKey(target),
    }));

    const rawMockPlan = buildMockPlan({
      functions: mockPlanningTargets,
      importMap,
      usage: usageByTarget,
      memberUsage: memberUsageByTarget,
      dependencies,
      dependencyUsage: dependencyUsageByTarget,
    });
    const mockPlan = applyExternalMockPolicyToFunctionPlan(rawMockPlan, {
      filePathAbs,
    });

    printMockPlanSummary(mockPlanningTargets, mockPlan);

    const topLevelExternalMockEntries = SHOULD_MOCK_TOP_LEVEL_EXTERNAL_IMPORTS
      ? buildTopLevelExternalMockEntries(importMap, { filePathAbs })
      : [];

    printTopLevelMockSummary(topLevelExternalMockEntries);

    if (SHOULD_MOCK_TOP_LEVEL_EXTERNAL_IMPORTS) {
      ensureMissingExternalModuleStubs(
        topLevelExternalMockEntries.map(
          (entry) => entry.normalizedModule || entry.module
        )
      );
    }

    const topLevelExternalMocks =
      SHOULD_MOCK_TOP_LEVEL_EXTERNAL_IMPORTS &&
      topLevelExternalMockEntries.length
        ? renderJestMocks({
            __topLevelExternalMocks: topLevelExternalMockEntries,
          }).__topLevelExternalMocks || ""
        : "";

    const jestMocksByTarget = renderJestMocks(mockPlan);
    printRenderedMocksSummary(mockPlanningTargets, jestMocksByTarget);

    let generatedForThisFile = 0;

    for (const fn of functions) {
      const fnName = fn.name;
      const fnTargetKey = getTargetKey(fn);

      const isAsync = isEffectivelyAsyncFunction(fn, asyncTargetNames);

      const params = normalizeParamList(fn.params || []);
      const classRecord = getClassRecordForFunction(fn, classMap);
      const classMethods = classRecord ? getClassMethods(classRecord) : [];

      const jestMocks = combineMockCode(
        topLevelExternalMocks,
        jestMocksByTarget[fnTargetKey] || ""
      );

      const stem = safeTestStem(filePathAbs, fnName);

      if (generatedTestStems.has(stem)) {
        console.log(
          `⚠️ Duplicate generated test target skipped: ${stem}.test.js from ${display}`
        );
        continue;
      }

      generatedTestStems.add(stem);

      const mockContent = renderJestMockModule({
        fnName,
        params,
        jestMocks,
      });
      const mockModulePath = mockContent ? `./${stem}.mocks.js` : "";

      const testContent = renderJestTestTemplate({
        fnName,
        isAsync,
        isDefault: !!fn.isDefault,
        isClassLike: !!fn.isClassLike,
        importPath,
        params,
        functionCode: fn.code,
        jestMocks,
        mockModulePath,

        ownerClassName: fn.isClassLike ? fnName : "",
        methodKind: fn.isClassLike ? "constructor" : "",
        constructorParams: fn.isClassLike
          ? getClassConstructorParams(classRecord || {})
          : [],
        constructorCode: fn.isClassLike
          ? getClassConstructorCode(classRecord || {})
          : "",
        classCode: classRecord?.classCode || classRecord?.code || fn.code,
        classMethods: classMethods.map((m) => m.name),
      });

      if (mockContent) {
        writeGeneratedMock(stem, mockContent);
      }

      const outFile = writeGeneratedTest(stem, testContent);

      const importStatement = fn.isDefault
        ? `import ${fnName} from "${importPath}";`
        : `import { ${fnName} } from "${importPath}";`;

      const fullMockHeader = combineMockCode(
        `import fs from "fs";
import path from "path";
import os from "os";
${importStatement}`,
        jestMocks
      );

      llmContexts.push({
        fnName,
        targetKey: fnTargetKey,
        displayName: fnName,
        isAsync,
        isDefault: !!fn.isDefault,
        isClassLike: !!fn.isClassLike,
        isClassMethod: false,
        ownerClassName: fn.isClassLike ? fnName : "",
        methodName: "",
        methodKind: fn.isClassLike ? "constructor" : "",
        constructorParams: fn.isClassLike
          ? getClassConstructorParams(classRecord || {})
          : [],
        constructorCode: fn.isClassLike
          ? getClassConstructorCode(classRecord || {})
          : "",
        classCode: classRecord?.classCode || classRecord?.code || fn.code,
        classMethods: classMethods.map((m) => m.name),
        params,
        functionCode: fn.code,
        testFilePath: outFile,
        importPath,
        sourceFile: filePathAbs,
        mockHeader: fullMockHeader,
        mockEntries: mockPlan[fnTargetKey],
        dependencyUsage: dependencyUsageByTarget?.[fnTargetKey] || [],
        dependencies: dependencies?.[fnTargetKey] || [],
        usageSnippets: mergeUsageSnippets(
          usageSnippetsByFunction,
          getUsageAliasesForFunction(fn, filePathAbs)
        ),
        docComment: docCommentsByFunction?.[fnName] || null,
      });

      generatedTestFiles++;
      generatedForThisFile++;
      console.log(`✅ Generated: ${outFile}`);

      if (fn.isClassLike && classRecord) {
        const classMethodTargets = rawClassMethodTargets.filter(
          (target) => target.ownerClassName === fnName
        );

        for (const target of classMethodTargets) {
          const targetKey = getTargetKey(target);

          const methodJestMocks = combineMockCode(
            topLevelExternalMocks,
            jestMocksByTarget[targetKey] || ""
          );

          const methodStem = safeTestStem(filePathAbs, target.displayName);

          if (generatedTestStems.has(methodStem)) {
            console.log(
              `⚠️ Duplicate generated test target skipped: ${methodStem}.test.js from ${display}`
            );
            continue;
          }

          generatedTestStems.add(methodStem);

          const methodMockContent = renderJestMockModule({
            fnName: target.fnName,
            params: target.params,
            jestMocks: methodJestMocks,
            isClassMethod: true,
            constructorParams: target.constructorParams,
          });
          const methodMockModulePath = methodMockContent
            ? `./${methodStem}.mocks.js`
            : "";

          const methodTestContent = renderJestTestTemplate({
            fnName: target.fnName,
            displayName: target.displayName,
            isAsync: target.isAsync,
            isDefault: !!fn.isDefault,
            isClassLike: false,
            isClassMethod: true,
            ownerClassName: target.ownerClassName,
            methodName: target.methodName,
            methodKind: target.methodKind,
            constructorParams: target.constructorParams,
            constructorCode: target.constructorCode,
            classCode: target.classCode,
            classMethods: target.classMethods,
            importPath,
            params: target.params,
            functionCode: target.functionCode,
            jestMocks: methodJestMocks,
            mockModulePath: methodMockModulePath,
          });

          if (methodMockContent) {
            writeGeneratedMock(methodStem, methodMockContent);
          }

          const methodOutFile = writeGeneratedTest(methodStem, methodTestContent);

          const methodMockHeader = combineMockCode(
            `import fs from "fs";
import path from "path";
import { ${target.ownerClassName} } from "${importPath}";`,
            methodJestMocks
          );

          llmContexts.push({
            ...target,
            targetKey,
            isDefault: !!fn.isDefault,
            testFilePath: methodOutFile,
            mockHeader: methodMockHeader,
            mockEntries: mockPlan[targetKey],
            dependencyUsage: dependencyUsageByTarget?.[targetKey] || [],
            dependencies: dependencies?.[targetKey] || [],
            jestMocks: methodJestMocks,
          });

          generatedTestFiles++;
          generatedForThisFile++;
          console.log(`✅ Generated: ${methodOutFile}`);
        }
      }
    }

    if (stopAfterFirstSuccessfulEntry && generatedForThisFile > 0) {
      console.log(
        `ℹ️ Package-entry mode: using first compatible entry file and stopping further entry scanning.`
      );
      break;
    }
  }

  return {
    processedFiles,
    skippedFiles,
    generatedTestFiles,
    skippedClassLikeExports,
    llmContexts,
  };
}

/* ======================================================
   STEP 0 — INPUT
====================================================== */

const userArg = process.argv[2];
const input = resolveInput(userArg);

printMessages(input.messages);
if (!input.ok) process.exit(1);

cleanGeneratedTests();
const runtimeArtifactBaseline = createRuntimeArtifactSnapshot();
process.on("exit", () =>
  cleanupRuntimeArtifacts(process.cwd(), { baselineNames: runtimeArtifactBaseline })
);

const selection = selectFilesForTesting(input);

/*
 * Some historical source checkouts publish a dist bundle but keep source as
 * ESM with legacy extensionless relative specifiers. If the published entry is
 * missing, install a scoped Node resolver only for that structurally-proven
 * source tree. The package source/manifest is never rewritten, and the resolver
 * plus inherited NODE_OPTIONS state are restored on normal/process-exit paths.
 */
const legacyEsmCompatibility = prepareLegacyEsmCompatibility(
  selection.projectRoot || input.root || process.cwd()
);

if (legacyEsmCompatibility.applied) {
  console.log(
    `ℹ️ Scoped legacy ESM resolution compatibility enabled for ${path.relative(process.cwd(), legacyEsmCompatibility.packageRoot) || legacyEsmCompatibility.packageRoot}.`
  );
}

const removeLegacyEsmRestoreHooks = registerLegacyEsmRestoreHooks(legacyEsmCompatibility);

if (selection.workspaceRoot) {
  console.log(
    `ℹ️ Workspace package matched requested package identity: ${selection.workspaceRoot}`
  );
  console.log(`ℹ️ Static scan restricted to ${selection.files.length} workspace source file(s).`);
}

if (selection.mode === "package-entry") {
  console.log("ℹ️ Package project detected: preferring package entry/public API files.");
  console.log(`ℹ️ Selected ${selection.files.length} entry file(s) for testing.`);
}

if (SHOULD_MOCK_TOP_LEVEL_EXTERNAL_IMPORTS) {
  console.log("ℹ️ Top-level external import mocking: enabled with risk/missing-dependency filtering.");
} else {
  console.log("ℹ️ Top-level external import mocking: disabled by environment.");
}

/* ======================================================
   TEST GENERATION
====================================================== */

const isPackageWithoutEntry =
  isPackageFolderInput(input) && selection.mode === "standard";

let generationFlow = isPackageWithoutEntry ? "static-full-scan" : "static";
let {
  processedFiles,
  skippedFiles,
  generatedTestFiles,
  skippedClassLikeExports,
  llmContexts,
} = generateFromFiles(selection.files, selection.entryFileSet, {
  stopAfterFirstSuccessfulEntry: selection.mode === "package-entry",
  projectRoot: selection.projectRoot || input.root || process.cwd(),

  // For package folders with no usable entry, skip only obvious unsafe files:
  // test/, server/, rethrow, internal, config/build files, etc.
  // Do NOT run deep context-bound filtering here, because it skips useful public wrappers.
  safeFullScan: false,
  skipUnsafeSourceFiles: isPackageWithoutEntry,
});
if (selection.mode === "package-entry" && input.root) {
  const expandedPublicFiles = getPublicEntryExpansionFiles({
    projectRoot: input.root,
    entryFiles: selection.files,
  }).filter((filePathAbs) => !selection.entryFileSet.has(filePathAbs));

  if (
    shouldExpandPackageEntryPublicApis({
      selection,
      generatedTestFiles,
      expandedFiles: expandedPublicFiles,
    })
  ) {
    console.log(
      `\nℹ️ Public entry expansion found ${expandedPublicFiles.length} additional public API file(s).\n`
    );

    const expandedEntrySet = new Set([
      ...selection.entryFileSet,
      ...expandedPublicFiles,
    ]);

    const expansionResult = generateFromFiles(expandedPublicFiles, expandedEntrySet, {
      stopAfterFirstSuccessfulEntry: false,
      projectRoot: input.root || process.cwd(),
    });

    processedFiles += expansionResult.processedFiles;
    skippedFiles += expansionResult.skippedFiles;
    generatedTestFiles += expansionResult.generatedTestFiles;
    skippedClassLikeExports += expansionResult.skippedClassLikeExports;
    llmContexts.push(...expansionResult.llmContexts);

    if (expansionResult.generatedTestFiles > 0) {
      generationFlow = "static-entry-expanded";
    }
  }
}

if (
  generatedTestFiles === 0 &&
  shouldTryDynamicApiFallback(input)
) {
  console.log(
    "\n⚠️ Package-entry mode produced no tests. Trying dynamic public API discovery...\n"
  );

  cleanGeneratedTests();

  const dynamicResult = await generateDynamicApiTests({
    projectRoot: input.root,
    writeGeneratedTest,
  });

  processedFiles = dynamicResult.processedFiles;
  skippedFiles = dynamicResult.skippedFiles;
  generatedTestFiles = dynamicResult.generatedTestFiles;
  skippedClassLikeExports = dynamicResult.skippedClassLikeExports;
  llmContexts = dynamicResult.llmContexts;
  if (generatedTestFiles > 0) {
    generationFlow = "dynamic-api";
  }
}

if (generationFlow !== "dynamic-api" && shouldSupplementWithDynamicApiDiscovery(input, generatedTestFiles)) {
  console.log(
    "\nℹ️ Static package generation completed. Supplementing it with runtime public API export checks...\n"
  );

  const dynamicBehaviorContextLimit = getDynamicBehaviorContextLimit();
  const dynamicBehaviorAttemptLimit = getDynamicBehaviorAttemptLimit(
    dynamicBehaviorContextLimit
  );
  console.log(
    `ℹ️ Preparing dynamic behavior candidates for up to ${dynamicBehaviorContextLimit} successful context(s) across at most ${dynamicBehaviorAttemptLimit} attempt(s).`
  );

  const dynamicSupplement = await generateDynamicApiTests({
    projectRoot: input.root,
    writeGeneratedTest,
    includeLlmContexts: dynamicBehaviorAttemptLimit > 0,
    maxLlmContexts: dynamicBehaviorAttemptLimit,
  });

  if (dynamicSupplement.generatedTestFiles > 0) {
    processedFiles += dynamicSupplement.processedFiles;
    skippedFiles += dynamicSupplement.skippedFiles;
    generatedTestFiles += dynamicSupplement.generatedTestFiles;
    skippedClassLikeExports += dynamicSupplement.skippedClassLikeExports;
    llmContexts.push(...(dynamicSupplement.llmContexts || []));
    generationFlow =
      generationFlow === "static-full-scan"
        ? "static-full-scan+dynamic-api"
        : `${generationFlow}+dynamic-api`;
  }
}

if (generatedTestFiles === 0 && selection.mode === "package-entry") {
  console.log(
    "\n⚠️ Package-entry mode produced no tests. Falling back to full project scan...\n"
  );

  cleanGeneratedTests();

  ({
    processedFiles,
    skippedFiles,
    generatedTestFiles,
    skippedClassLikeExports,
    llmContexts,
  } = generateFromFiles(input.files, new Set(), {
    stopAfterFirstSuccessfulEntry: false,
    projectRoot: input.root || process.cwd(),
    safeFullScan: true,
    skipUnsafeSourceFiles: true,
  }));
  generationFlow = "static-full-scan";
}

/* ======================================================
   SUMMARY
====================================================== */

console.log(`\n==============================`);
console.log(`📌 Summary`);
console.log(`==============================`);
console.log(`✅ Files processed: ${processedFiles}`);
console.log(`⚠️ Files skipped:  ${skippedFiles}`);
console.log(
  `ℹ️ Class-like exports handled via constructor/static/prototype generation when detected.`
);
console.log(`🧾 Generated test files: ${generatedTestFiles}`);
console.log(`📁 Output folder:  tests/generated/`);

cleanupRuntimeArtifacts(process.cwd(), { baselineNames: runtimeArtifactBaseline });

/* ======================================================
   LLM → JEST → ADAPTIVE REPAIR
====================================================== */

if (generatedTestFiles === 0) {
  console.log("\n⚠️ No tests generated.\n");
  process.exitCode = 1;
  process.exit();
}

console.log("\n🤖 Improving tests via LLM...\n");

const dynamicBehaviorSuccessLimit = getDynamicBehaviorContextLimit(llmContexts);
const dynamicBehaviorAttemptLimit = getDynamicBehaviorAttemptLimit(
  dynamicBehaviorSuccessLimit,
  llmContexts
);

await fillGeneratedTestsWithLLM({
  contexts: llmContexts,
  model: ACTIVE_MODEL,
  maxDynamicBehaviorSuccesses: dynamicBehaviorSuccessLimit,
  maxDynamicBehaviorAttempts: dynamicBehaviorAttemptLimit,
});

if (generationFlow === "dynamic-api") {
  llmContexts = await preflightGeneratedTestFilesAfterLLM(llmContexts);
  generatedTestFiles = countUniqueTestFiles(llmContexts);

  if (generatedTestFiles === 0) {
    console.log("\n⚠️ All generated tests were removed by post-LLM preflight.\n");
    process.exitCode = 1;
    process.exit();
  }
} else {
  console.log(`\nℹ️ Post-LLM preflight skipped for ${generationFlow} flow.\n`);
}

console.log("\n🧪 Running Jest...\n");

let initialResults = await runJest();
printReport(formatJestSummary(initialResults));

if (isUnrecoverableJestResult(initialResults)) {
  console.log(
    "\nInitial Jest run crashed before producing JSON. Running generated-test safety preflight...\n"
  );

  const beforeSafetyPreflightCount = generatedTestFiles;

  llmContexts = await preflightGeneratedTestFilesAfterLLM(llmContexts);
  generatedTestFiles = countUniqueTestFiles(llmContexts);

  if (generatedTestFiles === 0) {
    console.log(
      "\nSafety preflight removed all generated tests; stopping before repair.\n"
    );
    process.exitCode = 1;
    process.exit();
  }

  if (
    shouldSupplementAfterSafetyPreflight({
      input,
      generationFlow,
      beforePreflightCount: beforeSafetyPreflightCount,
      afterPreflightCount: generatedTestFiles,
    })
  ) {
    console.log(
      "\nℹ️ Safety preflight left a small package API surface. Supplementing with dynamic public API export checks...\n"
    );

    const includeDynamicBehaviorContexts =
      shouldAddPostPreflightDynamicBehaviorContexts(generatedTestFiles);
    const dynamicBehaviorContextLimit = includeDynamicBehaviorContexts
      ? getDynamicBehaviorContextLimit()
      : 0;
    const dynamicBehaviorAttemptLimit = includeDynamicBehaviorContexts
      ? getDynamicBehaviorAttemptLimit(dynamicBehaviorContextLimit)
      : 0;

    if (includeDynamicBehaviorContexts) {
      console.log(
        `ℹ️ Surviving package behavior coverage is small; preparing candidates for up to ${dynamicBehaviorContextLimit} successful dynamic behavior context(s) across at most ${dynamicBehaviorAttemptLimit} attempt(s).`
      );
    }

    const dynamicSupplement = await generateDynamicApiTests({
      projectRoot: input.root,
      writeGeneratedTest,
      includeLlmContexts: includeDynamicBehaviorContexts,
      maxLlmContexts: dynamicBehaviorAttemptLimit,
    });

    if (dynamicSupplement.generatedTestFiles > 0) {
      processedFiles += dynamicSupplement.processedFiles;
      skippedFiles += dynamicSupplement.skippedFiles;
      generatedTestFiles += dynamicSupplement.generatedTestFiles;
      skippedClassLikeExports += dynamicSupplement.skippedClassLikeExports;
      llmContexts.push(...(dynamicSupplement.llmContexts || []));
      generationFlow = `${generationFlow}+dynamic-api`;
    }
  }

  console.log("\nRe-running Jest after generated-test safety preflight...\n");
  initialResults = await runJest();
  printReport(formatJestSummary(initialResults));
}

console.log("\n🔁 Running adaptive repair...\n");

const repairResults = await runAdaptiveRepair({
  jestResults: initialResults,
  contexts: llmContexts,
  model: ACTIVE_MODEL,
});

if (repairResults?.updated) {
  console.log("\n🧪 Re-running Jest after adaptive repair...\n");
  initialResults = await runJest();
  printReport(formatJestSummary(initialResults));
}

/* ======================================================
   ASSERTION ENHANCEMENT
====================================================== */

console.log("\n🧠 Running assertion enhancer...\n");

await runAssertionEnhancer({
  testDir: path.resolve("tests", "generated"),
});

console.log("\n🧪 Re-running Jest after assertion enhancement...\n");

let finalResults = await runJest();
printReport(formatJestSummary(finalResults));

const repairCandidateFinalization = await quarantineUnresolvedRepairCandidates({
  contexts: llmContexts,
  lastResult: finalResults,
});

if (repairCandidateFinalization.changed) {
  console.log("\nRe-running Jest after unresolved repair-candidate quarantine...\n");
  finalResults = repairCandidateFinalization.result;
  printReport(formatJestSummary(finalResults));
}

/* ======================================================
   COVERAGE-GUIDED EXPANSION
====================================================== */

if (isPackageFolderInput(input)) {
  const coverageExpansion = await runCoverageGuidedExpansion({
    packageRoot: input.root,
    model: ACTIVE_MODEL,
  });

  if (coverageExpansion?.updated) {
    generatedTestFiles += Number(coverageExpansion.accepted || 0);
    console.log("\n🧪 Re-running Jest after accepted coverage-guided expansions...\n");
    finalResults = await runJest();
    printReport(formatJestSummary(finalResults));
  }
}

/* ======================================================
   FINAL REPORT
====================================================== */

writeFinalReport({
  input,
  processedFiles,
  skippedFiles,
  generatedTestFiles,
  llmContexts,
  jestResults: finalResults,
});
cleanupRuntimeArtifacts(process.cwd(), { baselineNames: runtimeArtifactBaseline });
legacyEsmCompatibility.restore();
removeLegacyEsmRestoreHooks();

console.log("\n✅ Done.\n");
