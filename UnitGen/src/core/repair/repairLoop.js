import fs from "fs";
import path from "path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

import { runJest, runJestForFile } from "../runner/jestRunner.js";
import { validateTransactionalTestEdit } from "../validation/transactionalTestEdit.js";
import { extractFailures } from "./failureExtractor.js";

import { attemptAstRepair } from "./strategies/astRepairEngine.js";
import { attemptSemanticRepair } from "./strategies/semanticRepairEngine.js";
import { attemptLLMRepair } from "./strategies/llmRepairEngine.js";
import { generateEvidenceRepairCandidates } from "./strategies/evidenceRepairEngine.js";

import { isRunnableTest } from "../validation/validateSyntax.js";

import { emitEvent } from "../report/eventEmitter.js";

const traverse = traverseModule.default;

const UNITGEN_REPAIR_CANDIDATE_MARKER = "__UNITGEN_REPAIR_CANDIDATE__";

/* ======================================================
   SAFE FILE WRITE
====================================================== */
function saveRepairedFile(filePath, code) {
  const buffer = Buffer.from(code, "utf8");
  fs.writeFileSync(filePath, buffer, {
    encoding: null,
    flag: "w",
  });
}

/* ======================================================
   FAILURE HISTORY
====================================================== */
const failureHistory = new Map();

/* ======================================================
   REPAIR CANDIDATE HELPERS
====================================================== */
function hasRepairCandidateMarker(code = "") {
  return String(code || "").includes(UNITGEN_REPAIR_CANDIDATE_MARKER);
}

function countRepairCandidateMarkers(code = "") {
  return (
    String(code || "").match(
      new RegExp(UNITGEN_REPAIR_CANDIDATE_MARKER, "g")
    ) || []
  ).length;
}
function clearResolvedRepairCandidateMetadata(code = "") {
  return String(code || "")
    .replace(/\[repair-candidate\]\s*/g, "")
    .replace(/^\s*\/\/ __UNITGEN_REPAIR_CANDIDATE__\s*\r?\n/gm, "")
    .replace(/^\s*\/\/ failureType:.*\r?\n/gm, "")
    .replace(/^\s*\/\/ runtimeReason:.*\r?\n/gm, "");
}

function fileHasRepairCandidates(filePath) {
  try {
    return hasRepairCandidateMarker(fs.readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
}

function countRepairCandidatesInFiles(filePaths = []) {
  let count = 0;

  for (const filePath of filePaths || []) {
    try {
      count += countRepairCandidateMarkers(fs.readFileSync(filePath, "utf8"));
    } catch {
      // ignore unreadable files
    }
  }

  return count;
}

function getCandidateFilePathsFromContexts(contexts = []) {
  const paths = [];

  for (const ctx of contexts || []) {
    if (ctx?.testFilePath) paths.push(ctx.testFilePath);
  }

  return [...new Set(paths.map((p) => path.resolve(p)))];
}

/**
 * Removes only generated repair-candidate test blocks.
 *
 * This intentionally avoids touching normal generated tests.
 * It searches for a test()/it() block containing:
 *   // __UNITGEN_REPAIR_CANDIDATE__
 *
 * If a candidate cannot be safely identified, the original code is returned.
 */
export function removeRepairCandidateBlocks(code = "") {
  const source = String(code || "");

  if (!hasRepairCandidateMarker(source)) {
    return {
      code: source,
      removed: 0,
    };
  }

  const lines = source.split("\n");
  const removeRanges = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(UNITGEN_REPAIR_CANDIDATE_MARKER)) continue;

    let start = i;
    while (start >= 0 && !/^\s*(test|it)\s*\(/.test(lines[start])) {
      start--;
    }

    if (start < 0) continue;

    let end = i;
    let foundEnd = false;

    for (let j = i; j < lines.length; j++) {
      if (
        /^\s*\}\s*\)\s*;?\s*$/.test(lines[j]) ||
        /^\s*\}\s*\);\s*$/.test(lines[j])
      ) {
        end = j;
        foundEnd = true;
        break;
      }
    }

    if (!foundEnd) continue;

    removeRanges.push([start, end]);
  }

  if (removeRanges.length === 0) {
    return {
      code: source,
      removed: 0,
    };
  }

  const merged = [];

  for (const range of removeRanges.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];

    if (!last || range[0] > last[1]) {
      merged.push([...range]);
    } else {
      last[1] = Math.max(last[1], range[1]);
    }
  }

  const removeLineIndexes = new Set();

  for (const [start, end] of merged) {
    for (let i = start; i <= end; i++) {
      removeLineIndexes.add(i);
    }

    if (end + 1 < lines.length && lines[end + 1].trim() === "") {
      removeLineIndexes.add(end + 1);
    }
  }

  const cleaned = lines
    .filter((_, index) => !removeLineIndexes.has(index))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");

  return {
    code: cleaned,
    removed: merged.length,
  };
}

export async function quarantineUnresolvedRepairCandidates({
  contexts = [],
  configPath,
  lastResult,
}) {
  const candidateFiles = getCandidateFilePathsFromContexts(contexts);
  let totalRemoved = 0;
  const changedFiles = [];

  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) continue;

    const originalCode = fs.readFileSync(filePath, "utf8");
    if (!hasRepairCandidateMarker(originalCode)) continue;

    const { code: cleanedCode, removed } =
      removeRepairCandidateBlocks(originalCode);

    if (removed <= 0 || cleanedCode === originalCode) continue;

    /*
     * Important:
     * Quarantine only deletes marked repair-candidate test blocks.
     * It does not generate new code. So syntax/runnability validation is enough here.
     * The undeclared-reference check is intentionally NOT used here because it is too strict
     * for some valid generated test files and can block cleanup.
     */
    if (!isRunnableTest(cleanedCode)) {
      console.log(
        `⚠️ Could not safely quarantine repair candidates in ${path.basename(filePath)}.`
      );
      continue;
    }

    saveRepairedFile(filePath, cleanedCode);
    totalRemoved += removed;
    changedFiles.push(filePath);

    emitEvent("repair_candidate_quarantined", {
      testFile: path.basename(filePath),
      failureType: "Unresolved repair candidate",
      repairStrategy: "Repair Candidate Quarantine",
      after: `${removed} unresolved repair candidate(s) removed before final export`,
      status: "quarantined",
    });

    console.log(
      `🧯 Quarantined ${removed} unresolved repair candidate(s) from ${path.basename(filePath)}.`
    );
  }

  if (changedFiles.length === 0) {
    return {
      changed: false,
      removed: 0,
      result: lastResult,
      failures: [],
    };
  }

  const result = await runJest({ configPath });

  if (!isValidTestRun(result)) {
    console.log("⚠️ Quarantine cleanup produced invalid Jest run.");
    return {
      changed: true,
      removed: totalRemoved,
      result,
      failures: [],
    };
  }

  const failures = extractFailures(getJestJson(result));

  return {
    changed: true,
    removed: totalRemoved,
    result,
    failures,
  };
}

/* ======================================================
   JEST RESULT NORMALIZATION
====================================================== */
function getJestJson(result) {
  if (!result) return null;

  if (result.json && typeof result.json === "object") {
    return result.json;
  }

  if (
    typeof result === "object" &&
    (
      "numTotalTests" in result ||
      "testResults" in result ||
      "numFailedTests" in result ||
      "numFailedTestSuites" in result ||
      "numRuntimeErrorTestSuites" in result
    )
  ) {
    return result;
  }

  return null;
}

/* ======================================================
   GLOBALS FOR TEST VALIDATION
====================================================== */
const ALLOWED_GLOBALS = new Set([
  "describe",
  "test",
  "it",
  "expect",
  "jest",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "Array",
  "Object",
  "JSON",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Function",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "Promise",
  "Set",
  "Map",
  "console",
  "undefined",
  "null",
  "NaN",
  "Infinity",
]);

function hasUndeclaredTestReferences(code) {
  const declared = new Set();
  const referenced = new Set();

  let ast;
  try {
    ast = parse(String(code || ""), {
      sourceType: "module",
      plugins: ["topLevelAwait", "dynamicImport"],
    });
  } catch {
    return true;
  }

  traverse(ast, {
    ImportSpecifier(path) {
      if (path.node.local?.name) declared.add(path.node.local.name);
    },
    ImportDefaultSpecifier(path) {
      if (path.node.local?.name) declared.add(path.node.local.name);
    },
    ImportNamespaceSpecifier(path) {
      if (path.node.local?.name) declared.add(path.node.local.name);
    },
    VariableDeclarator(path) {
      const id = path.node.id;
      if (id?.type === "Identifier") declared.add(id.name);
    },
    FunctionDeclaration(path) {
      if (path.node.id?.name) declared.add(path.node.id.name);
      for (const param of path.node.params || []) {
        if (param.type === "Identifier") declared.add(param.name);
      }
    },
    FunctionExpression(path) {
      if (path.node.id?.name) declared.add(path.node.id.name);
      for (const param of path.node.params || []) {
        if (param.type === "Identifier") declared.add(param.name);
      }
    },
    ArrowFunctionExpression(path) {
      for (const param of path.node.params || []) {
        if (param.type === "Identifier") declared.add(param.name);
      }
    },
    CatchClause(path) {
      if (path.node.param?.type === "Identifier") {
        declared.add(path.node.param.name);
      }
    },
    ReferencedIdentifier(path) {
      referenced.add(path.node.name);
    },
  });

  for (const name of referenced) {
    if (declared.has(name)) continue;
    if (ALLOWED_GLOBALS.has(name)) continue;
    return true;
  }

  return false;
}

/* ======================================================
   GET PASSING TEST TITLES
====================================================== */
function getPassingTestTitles(result) {
  const json = getJestJson(result);
  if (!json?.testResults) return [];

  return json.testResults
    .flatMap((suite) => suite.assertionResults || [])
    .filter((t) => t.status === "passed")
    .map((t) => t.fullName || t.title)
    .filter(Boolean);
}

/* ======================================================
   SUMMARY METRICS
====================================================== */
function getRunMetrics(result) {
  const json = getJestJson(result) || {};

  return {
    passedTests: Number(json.numPassedTests || 0),
    failedTests: Number(json.numFailedTests || 0),
    totalTests: Number(json.numTotalTests || 0),
    failedSuites:
      Number(json.numFailedTestSuites || 0) +
      Number(json.numRuntimeErrorTestSuites || 0),
    passedSuites: Number(json.numPassedTestSuites || 0),
    totalSuites: Number(json.numTotalTestSuites || 0),
  };
}

/* ======================================================
   VALID JEST RUN CHECK
====================================================== */
function isValidTestRun(result) {
  const json = getJestJson(result);
  if (!json) return false;
  return Number(json.numTotalTests || 0) > 0;
}

function hasBrokenSuiteRun(result) {
  const metrics = getRunMetrics(result);
  return metrics.totalTests === 0 && metrics.failedSuites > 0;
}

/* ======================================================
   ASSERTION EXTRACTOR
====================================================== */
function extractAssertionLine(msg = "") {
  const lines = String(msg || "").split("\n");
  for (const l of lines) {
    if (l.includes("expect(")) return l.trim();
  }
  return "";
}

function compactEventMessage(message = "", maxLength = 350) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/* ======================================================
   IMPROVEMENT CHECK
====================================================== */
function isImproved(prevFailures, nextFailures, prevResult, nextResult) {
  if (!isValidTestRun(nextResult)) return false;

  const prevMetrics = getRunMetrics(prevResult);
  const nextMetrics = getRunMetrics(nextResult);

  if (nextMetrics.failedTests > prevMetrics.failedTests) return false;
  if (nextMetrics.failedSuites > prevMetrics.failedSuites) return false;

  if (nextFailures.length < prevFailures.length) return true;
  if (nextMetrics.failedTests < prevMetrics.failedTests) return true;
  if (nextMetrics.failedSuites < prevMetrics.failedSuites) return true;
  if (nextMetrics.passedTests > prevMetrics.passedTests) return true;

  return false;
}

/* ======================================================
   FILE PRIORITIZATION
====================================================== */
function prioritizeFiles(failures) {
  const map = new Map();

  for (const f of failures) {
    const repairCandidateBoost = fileHasRepairCandidates(f.filePath) ? -1 : 0;
    const priority = String(f.filePath || "").includes(".test.") ? 0 : 5;
    map.set(
      f.filePath,
      (map.get(f.filePath) || 0) + 1 + priority + repairCandidateBoost
    );
  }

  return [...map.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([filePath]) => filePath);
}

/* ======================================================
   HANDLE JEST CRASH
====================================================== */
function recoverFromJestCrash(result) {
  const json = getJestJson(result) || {};
  const recovered = [];

  for (const suite of json.testResults || []) {
    const suiteName = String(suite.name || "");
    const suiteMessage = String(suite.message || "");

    const looksBroken =
      suite.status === "failed" ||
      suiteMessage.length > 0 ||
      (suite.assertionResults || []).length === 0;

    if (!looksBroken) continue;
    if (!suiteName.endsWith(".test.js")) continue;

    recovered.push({
      filePath: path.resolve(suiteName),
      testName: "SUITE_CRASH",
      errorMessage: suiteMessage || "Suite failed to load.",
      errorType: "SUITE_LOAD_ERROR",
      failureType: "SUITE_LOAD",
      expected: null,
      received: null,
      stack: suiteMessage || "",
      fingerprint: `${suiteName}::CRASH`,
    });
  }

  return recovered;
}

/* ======================================================
   REGRESSION CHECK
====================================================== */
function hasRegression(previousResult, nextResult) {
  const previouslyPassing = getPassingTestTitles(previousResult);
  const stillPassing = getPassingTestTitles(nextResult);

  return previouslyPassing.some((title) => !stillPassing.includes(title));
}

/* ======================================================
   RECORD FAILURE HISTORY
====================================================== */
function recordFailureHistory(
  filePath,
  newFailures,
  attempt,
  strategy = "runtime validation"
) {
  const relevant = (newFailures || []).filter((f) => {
    try {
      return path.resolve(f.filePath) === path.resolve(filePath);
    } catch {
      return String(f.filePath || "") === String(filePath || "");
    }
  });

  if (relevant.length === 0) return;

  if (!failureHistory.has(filePath)) {
    failureHistory.set(filePath, []);
  }

  for (const f of relevant) {
    failureHistory.get(filePath).push({
      attempt,
      strategy,
      testName: f.testName,
      message: f.errorMessage,
      fingerprint: f.fingerprint,
    });
  }

  // Keep prompts bounded while retaining the most recent rejected evidence.
  const history = failureHistory.get(filePath);
  if (history.length > 12) {
    failureHistory.set(filePath, history.slice(-12));
  }
}

/* ======================================================
   TRY LOCAL REPAIR
====================================================== */
async function tryLocalRepair({
  filePath,
  failures,
  lastResult,
  configPath,
  attempt,
}) {
  const originalCode = fs.readFileSync(filePath, "utf8");
  const fileFailures = failures.filter(
    (f) => path.resolve(f.filePath) === path.resolve(filePath)
  );

  for (const failure of fileFailures) {
    emitEvent("failure_classified", {
      testFile: path.basename(filePath),
      failureType: failure.failureType || failure.errorType || "Test failure",
      before: compactEventMessage(failure.errorMessage || ""),
      repairStrategy: "Deterministic Repair",
      status: "classified",
    });
  }

  const candidates = [];
  const seenCodes = new Set();

  const pushCandidate = (candidate) => {
    if (!candidate?.code || candidate.code === originalCode) return;
    if (seenCodes.has(candidate.code)) return;
    seenCodes.add(candidate.code);
    candidates.push(candidate);
  };

  // 1) Highest-confidence exact runtime evidence first.
  for (const candidate of generateEvidenceRepairCandidates(
    originalCode,
    fileFailures
  )) {
    pushCandidate(candidate);
  }

  // 2) Preserve and reuse the existing AST engine.
  for (const failure of fileFailures) {
    const enhancedFailure = {
      ...failure,
      assertion: extractAssertionLine(failure.errorMessage),
    };

    const astResult = attemptAstRepair(originalCode, enhancedFailure);

    if (astResult && astResult !== originalCode) {
      pushCandidate({
        code: astResult,
        strategy: "ast",
        reason: `AST transformation for ${failure.failureType || failure.errorType}`,
        testName: failure.testName,
      });
    }
  }

  // 3) Preserve and reuse the existing semantic engine.
  for (const failure of fileFailures) {
    const semanticResult = attemptSemanticRepair(originalCode, failure);

    if (semanticResult && semanticResult !== originalCode) {
      pushCandidate({
        code: semanticResult,
        strategy: "semantic",
        reason: `Semantic transformation for ${failure.failureType || failure.errorType}`,
        testName: failure.testName,
      });
    }
  }

  if (candidates.length === 0) {
    console.log("➡️ No justified deterministic repair candidate.");
    return {
      accepted: false,
      attempted: false,
      failures,
      lastResult,
    };
  }

  console.log(
    `🧪 ${candidates.length} deterministic repair candidate(s) proposed for ${path.basename(filePath)}.`
  );

  let attempted = false;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    let repairedCode = candidate.code;

    if (
      hasRepairCandidateMarker(originalCode) &&
      hasRepairCandidateMarker(repairedCode)
    ) {
      repairedCode = clearResolvedRepairCandidateMetadata(repairedCode);
    }

    const strategyLabel =
      candidate.strategy === "runtime-exact-oracle" ||
      candidate.strategy === "runtime-type-oracle"
        ? "Runtime Evidence Repair"
        : candidate.strategy === "ast"
          ? "AST Repair"
          : candidate.strategy === "semantic"
            ? "Semantic Repair"
            : `Deterministic Repair (${candidate.strategy || "generic"})`;

    console.log(
      `🧪 Candidate ${index + 1}/${candidates.length}: ${strategyLabel}${candidate.reason ? ` — ${candidate.reason}` : ""}`
    );

    attempted = true;

    const transaction = await validateTransactionalTestEdit({
      filePath,
      originalCode,
      candidateCode: repairedCode,
      baselineFullResult: lastResult,
      runJestForFile,
      runJest,
      configPath,
      mode: "repair",
      validateCandidate: (code) =>
        isRunnableTest(code) && !hasUndeclaredTestReferences(code),
    });

    if (!transaction.accepted) {
      console.log(
        `❌ ${strategyLabel} candidate rejected (${transaction.reason || "validation failed"}).`
      );

      emitEvent("repair_rejected", {
        testFile: path.basename(filePath),
        failureType: candidate.testName || "Local repair",
        repairStrategy: strategyLabel,
        after: `Candidate rejected: ${transaction.reason || "validation failed"}`,
        status: "rejected",
      });

      const rejectedResult =
        transaction.fullResult || transaction.isolatedResult || null;
      if (rejectedResult && getJestJson(rejectedResult)) {
        recordFailureHistory(
          filePath,
          extractFailures(getJestJson(rejectedResult)),
          attempt,
          strategyLabel
        );
      }

      continue;
    }

    const result = transaction.result;
    const newFailures = extractFailures(getJestJson(result));

    console.log(
      `✅ ${strategyLabel} accepted — isolated failure reduction confirmed and full-suite non-regression passed.`
    );

    emitEvent("repair_accepted", {
      testFile: path.basename(filePath),
      failureType: candidate.testName || "Local repair",
      repairStrategy: strategyLabel,
      after: "A real failing test/suite was reduced under isolated execution and the full suite preserved previous passes",
      status: "accepted",
    });

    if (
      hasRepairCandidateMarker(originalCode) &&
      !hasRepairCandidateMarker(repairedCode)
    ) {
      emitEvent("repair_candidate_repaired", {
        testFile: path.basename(filePath),
        failureType: "Repair candidate",
        repairStrategy: strategyLabel,
        after: "Repair candidate marker removed after validated fail-to-pass improvement",
        status: "repaired",
      });
    }

    recordFailureHistory(filePath, newFailures, attempt);

    return {
      accepted: true,
      attempted: true,
      failures: newFailures,
      lastResult: result,
    };
  }

  return {
    accepted: false,
    attempted,
    failures,
    lastResult,
  };
}

/* ======================================================
   TRY LLM REPAIR
====================================================== */
async function tryLLMRepair({
  filePath,
  failures,
  lastResult,
  contexts,
  model,
  configPath,
  attempt,
}) {
  const originalCode = fs.readFileSync(filePath, "utf8");
  const fileFailures = failures.filter(
    (f) => path.resolve(f.filePath) === path.resolve(filePath)
  );

  console.log(`🤖 LLM repair candidate generation: ${path.basename(filePath)}`);

  let repairedCode = await attemptLLMRepair({
    originalCode,
    failures: fileFailures,
    contexts,
    model,
    attempt,
    history: failureHistory.get(filePath) || [],
  });

  if (!repairedCode || repairedCode === originalCode) {
    return {
      accepted: false,
      attempted: false,
      failures,
      lastResult,
    };
  }

  if (
    hasRepairCandidateMarker(originalCode) &&
    hasRepairCandidateMarker(repairedCode)
  ) {
    repairedCode = clearResolvedRepairCandidateMetadata(repairedCode);
  }

  if (
    originalCode.includes("jest.unstable_mockModule") &&
    !repairedCode.includes("jest.unstable_mockModule")
  ) {
    console.log("⚠️ LLM candidate removed required mocks; rejecting before execution.");
    return {
      accepted: false,
      attempted: true,
      failures,
      lastResult,
    };
  }

  console.log("🧪 LLM repair candidate proposed. Validating isolated file first...");

  const transaction = await validateTransactionalTestEdit({
    filePath,
    originalCode,
    candidateCode: repairedCode,
    baselineFullResult: lastResult,
    runJestForFile,
    runJest,
    configPath,
    mode: "repair",
    validateCandidate: (code) =>
      isRunnableTest(code) && !hasUndeclaredTestReferences(code),
  });

  if (!transaction.accepted) {
    console.log(
      `❌ LLM repair candidate rejected (${transaction.reason || "validation failed"}).`
    );

    emitEvent("repair_rejected", {
      testFile: path.basename(filePath),
      failureType: "LLM repair",
      repairStrategy: "LLM Repair",
      after: `Candidate rejected: ${transaction.reason || "validation failed"}`,
      status: "rejected",
    });

    const rejectedResult =
      transaction.fullResult || transaction.isolatedResult || null;
    if (rejectedResult && getJestJson(rejectedResult)) {
      recordFailureHistory(
        filePath,
        extractFailures(getJestJson(rejectedResult)),
        attempt,
        "LLM Repair"
      );
    }

    return {
      accepted: false,
      attempted: true,
      failures,
      lastResult,
    };
  }

  const result = transaction.result;
  const newFailures = extractFailures(getJestJson(result));

  console.log(
    "✅ LLM repair accepted — isolated fail-to-pass improvement and full-suite non-regression both confirmed."
  );

  emitEvent("repair_accepted", {
    testFile: path.basename(filePath),
    failureType: "LLM repair",
    repairStrategy: "LLM Repair",
    after: "A real failing test/suite was reduced and all previously passing tests remained passing",
    status: "accepted",
  });

  if (
    hasRepairCandidateMarker(originalCode) &&
    !hasRepairCandidateMarker(repairedCode)
  ) {
    emitEvent("repair_candidate_repaired", {
      testFile: path.basename(filePath),
      failureType: "Repair candidate",
      repairStrategy: "LLM Repair",
      after: "Repair candidate marker removed after validated fail-to-pass improvement",
      status: "repaired",
    });
  }

  recordFailureHistory(filePath, newFailures, attempt);

  return {
    accepted: true,
    attempted: true,
    failures: newFailures,
    lastResult: result,
  };
}

/* ======================================================
   MAIN LOOP
====================================================== */
export async function runAdaptiveRepair({
  jestResults = null,
  contexts,
  maxAttempts = 3,
  model,
  configPath,
}) {
  const candidateFiles = getCandidateFilePathsFromContexts(contexts);
  const initialRepairCandidates = countRepairCandidatesInFiles(candidateFiles);

  let lastResult = jestResults || (await runJest({ configPath }));
  let failures = [];

  if (isValidTestRun(lastResult)) {
    failures = extractFailures(getJestJson(lastResult));
  } else if (hasBrokenSuiteRun(lastResult)) {
    console.log("⚠️ Initial Jest produced suite-load failures. Attempting crash recovery...");
    failures = recoverFromJestCrash(lastResult);
  } else {
    console.log("⚠️ Initial Jest failed in an unrecoverable way.");
    return {
      success: false,
      finalResult: lastResult,
      updated: false,
      unrecoverable: true,
      repairCandidateStats: {
        injected: initialRepairCandidates,
        unresolved: initialRepairCandidates,
        quarantined: 0,
        repairedOrPassing: 0,
      },
    };
  }

  if (initialRepairCandidates > 0) {
    console.log(`🔧 Repair candidates detected: ${initialRepairCandidates}`);
  }

  if (failures.length === 0) {
    if (hasBrokenSuiteRun(lastResult)) {
      console.log("⚠️ Repair loop could not recover actionable failures from suite-load errors.");
      return {
        success: false,
        finalResult: lastResult,
        updated: false,
        unrecoverable: true,
        repairCandidateStats: {
          injected: initialRepairCandidates,
          unresolved: initialRepairCandidates,
          quarantined: 0,
          repairedOrPassing: 0,
        },
      };
    }

    console.log("✅ All tests already passing.");
    return {
      success: true,
      finalResult: lastResult,
      updated: false,
      repairCandidateStats: {
        injected: initialRepairCandidates,
        unresolved: 0,
        quarantined: 0,
        repairedOrPassing: initialRepairCandidates,
      },
    };
  }

  let anyAccepted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n===== REPAIR ATTEMPT ${attempt}/${maxAttempts} =====\n`);

    const filesRepairedThisAttempt = new Set();
    let files = prioritizeFiles(failures);

    for (const filePath of files) {
      if (failures.length === 0) break;

      console.log(`🔧 Repairing file: ${path.basename(filePath)}`);

      const localResult = await tryLocalRepair({
        filePath,
        failures,
        lastResult,
        configPath,
        attempt,
      });

      failures = localResult.failures;
      lastResult = localResult.lastResult;

      if (localResult.accepted) {
        anyAccepted = true;
        filesRepairedThisAttempt.add(filePath);
      }
    }

    if (failures.length === 0) {
      const remainingRepairCandidates = countRepairCandidatesInFiles(candidateFiles);

      console.log("🎉 All tests repaired.");
      return {
        success: true,
        finalResult: lastResult,
        updated: anyAccepted,
        repairCandidateStats: {
          injected: initialRepairCandidates,
          unresolved: 0,
          quarantined: 0,
          repairedOrPassing: initialRepairCandidates - remainingRepairCandidates,
          remainingMarkers: remainingRepairCandidates,
        },
      };
    }

    files = prioritizeFiles(failures);

    for (const filePath of files) {
      if (failures.length === 0) break;

      if (filesRepairedThisAttempt.has(filePath)) {
        console.log(
          `⏭️ Skipping LLM for ${path.basename(
            filePath
          )} (already improved this attempt).`
        );
        continue;
      }

      const llmResult = await tryLLMRepair({
        filePath,
        failures,
        lastResult,
        contexts,
        model,
        configPath,
        attempt,
      });

      failures = llmResult.failures;
      lastResult = llmResult.lastResult;

      if (llmResult.accepted) {
        anyAccepted = true;
      }
    }

    if (failures.length === 0) {
      const remainingRepairCandidates = countRepairCandidatesInFiles(candidateFiles);

      console.log("🎉 All tests repaired.");
      return {
        success: true,
        finalResult: lastResult,
        updated: anyAccepted,
        repairCandidateStats: {
          injected: initialRepairCandidates,
          unresolved: 0,
          quarantined: 0,
          repairedOrPassing: initialRepairCandidates - remainingRepairCandidates,
          remainingMarkers: remainingRepairCandidates,
        },
      };
    }
  }

  console.log("\n❌ Repair attempts finished.\n");

  /*
   * Quarantine is intentionally disabled.
   *
   * We want unresolved failed repair-candidate tests to remain in the test files
   * so the final Jest report shows them normally as failed tests.
   *
   * This is needed because assertionEnhancer will be improved next to work
   * on failed/unstable repair-candidate assertions instead of only stable suites.
   */

  const remainingRepairCandidates = countRepairCandidatesInFiles(candidateFiles);

  return {
    success: failures.length === 0,
    finalResult: lastResult,
    updated: anyAccepted,
    repairCandidateStats: {
      injected: initialRepairCandidates,
      unresolved: remainingRepairCandidates,
      quarantined: 0,
      repairedOrPassing: Math.max(
        0,
        initialRepairCandidates - remainingRepairCandidates
      ),
      remainingMarkers: remainingRepairCandidates,
    },
  };
}
