// src/core/assertion/runtimeValueObserver.js

import fs from "fs";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";

import { runJestForFile as defaultRunJestForFile } from "../runner/jestRunner.js";

const traverse = traverseModule.default;
const generate = generatorModule.default;

const RUNTIME_VALUE_MARKER = "__UNITGEN_RUNTIME_VALUE__:";

/* ======================================================
   BASIC PARSE / GENERATE HELPERS
====================================================== */

function parseModule(code) {
  return parse(String(code || ""), {
    sourceType: "module",
    plugins: [
      "topLevelAwait",
      "dynamicImport",
      "importMeta",
      "classProperties",
      "objectRestSpread",
      "optionalChaining",
      "nullishCoalescingOperator",
    ],
  });
}

function parseStatement(code) {
  const ast = parseModule(String(code || ""));
  return ast.program.body?.[0] || null;
}

function codeOf(node) {
  try {
    return node ? generate(node).code : "";
  } catch {
    return "";
  }
}

function normalizeText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeLoose(text = "") {
  return normalizeText(text).replace(/\s+/g, "").toLowerCase();
}

/* ======================================================
   EXPECT ASSERTION PARSING
====================================================== */

function getMemberPropertyName(member) {
  if (!member || member.type !== "MemberExpression") return "";

  if (member.property?.type === "Identifier") {
    return member.property.name;
  }

  if (member.property?.type === "StringLiteral") {
    return member.property.value;
  }

  return "";
}

function parseExpectMatcherChain(callNode) {
  if (!callNode || callNode.type !== "CallExpression") return null;
  if (!callNode.callee || callNode.callee.type !== "MemberExpression") {
    return null;
  }

  const finalMember = callNode.callee;
  const matcher = getMemberPropertyName(finalMember);

  if (!matcher) return null;

  let cursor = finalMember.object;
  const modifiers = [];

  while (cursor?.type === "MemberExpression") {
    const modifier = getMemberPropertyName(cursor);

    if (modifier) {
      modifiers.unshift(modifier);
    }

    cursor = cursor.object;
  }

  if (
    !cursor ||
    cursor.type !== "CallExpression" ||
    cursor.callee?.type !== "Identifier" ||
    cursor.callee.name !== "expect"
  ) {
    return null;
  }

  return {
    matcher,
    modifiers,
    expectCall: cursor,
    receivedNode: cursor.arguments?.[0] || null,
    isNegated: modifiers.includes("not"),
    isAsyncChain:
      modifiers.includes("resolves") ||
      modifiers.includes("rejects") ||
      matcher === "resolves" ||
      matcher === "rejects",
  };
}

/* ======================================================
   TEST CONTEXT HELPERS
====================================================== */

function isTestCallExpression(node) {
  if (!node || node.type !== "CallExpression") return false;

  if (
    node.callee?.type === "Identifier" &&
    ["test", "it"].includes(node.callee.name)
  ) {
    return true;
  }

  if (
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    ["test", "it"].includes(node.callee.object.name)
  ) {
    return true;
  }

  return false;
}

function getTestNameFromCall(node) {
  if (!isTestCallExpression(node)) return "";

  const firstArg = node.arguments?.[0];

  if (firstArg?.type === "StringLiteral") {
    return firstArg.value;
  }

  if (firstArg?.type === "TemplateLiteral") {
    return firstArg.quasis.map((q) => q.value.cooked || "").join("${...}");
  }

  return "";
}

function findEnclosingTestCall(path) {
  const testPath = path.findParent((parentPath) =>
    isTestCallExpression(parentPath.node)
  );

  return testPath?.node || null;
}

function testNameMatches(a = "", b = "") {
  const x = String(a || "");
  const y = String(b || "");

  if (!x || !y) return false;

  return x === y || x.includes(y) || y.includes(x);
}

/* ======================================================
   TARGET MATCHING
====================================================== */

function getAssertionSource(path) {
  const parent = path.parentPath?.node;

  if (parent?.type === "AwaitExpression") {
    return codeOf(parent);
  }

  return codeOf(path.node);
}

function targetMatchesAssertion({ path, parsed, target = {} }) {
  const source = getAssertionSource(path);
  const targetSource = target.source || "";

  if (targetSource) {
    if (normalizeText(source) === normalizeText(targetSource)) return true;

    const looseSource = normalizeLoose(source);
    const looseTarget = normalizeLoose(targetSource);

    if (
      looseSource &&
      looseTarget &&
      (looseSource.includes(looseTarget) || looseTarget.includes(looseSource))
    ) {
      return true;
    }
  }

  if (target.matcher && parsed.matcher !== target.matcher) {
    return false;
  }

  const testNode = findEnclosingTestCall(path);
  const currentTestName = getTestNameFromCall(testNode);

  if (target.testName && currentTestName) {
    return testNameMatches(target.testName, currentTestName);
  }

  if (Array.isArray(target.candidateTestNames) && currentTestName) {
    return target.candidateTestNames.some((name) =>
      testNameMatches(name, currentTestName)
    );
  }

  return Boolean(target.matcher && parsed.matcher === target.matcher);
}

function findTargetAssertionPath(ast, target = {}) {
  let found = null;

  traverse(ast, {
    CallExpression(path) {
      if (found) {
        path.stop();
        return;
      }

      const parsed = parseExpectMatcherChain(path.node);
      if (!parsed) return;

      if (!parsed.receivedNode) return;

      if (targetMatchesAssertion({ path, parsed, target })) {
        found = {
          path,
          parsed,
          source: getAssertionSource(path),
          testName: getTestNameFromCall(findEnclosingTestCall(path)),
        };

        path.stop();
      }
    },
  });

  return found;
}

/* ======================================================
   OBSERVABLE EXPRESSION SELECTION
====================================================== */

function isUnsafeObservableExpressionSource(source = "") {
  const s = String(source || "");

  return (
    /\bawait\b/.test(s) ||
    /\.rejects\b/.test(s) ||
    /\.resolves\b/.test(s) ||
    /\bexpect\s*\(/.test(s)
  );
}

function isSimpleObservableNode(node) {
  return (
    node &&
    (
      node.type === "Identifier" ||
      node.type === "MemberExpression"
    )
  );
}

function unwrapObservableNode(node) {
  if (!node) return null;

  // result
  if (node.type === "Identifier") return node;

  // result.x / result.length
  if (node.type === "MemberExpression") {
    return node.object || node;
  }

  // typeof result
  if (node.type === "UnaryExpression" && node.operator === "typeof") {
    return unwrapObservableNode(node.argument);
  }

  // result === undefined || result !== undefined
  if (node.type === "LogicalExpression") {
    const left = unwrapObservableNode(node.left);
    if (left) return left;

    return unwrapObservableNode(node.right);
  }

  // result === undefined / result !== undefined / result == null
  if (node.type === "BinaryExpression") {
    const left = unwrapObservableNode(node.left);
    if (left) return left;

    return unwrapObservableNode(node.right);
  }

  // !result
  if (node.type === "UnaryExpression" && node.operator === "!") {
    return unwrapObservableNode(node.argument);
  }

  // Boolean(result)
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "Boolean"
  ) {
    return unwrapObservableNode(node.arguments?.[0]);
  }

  // Array.isArray(result)
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Array" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "isArray"
  ) {
    return unwrapObservableNode(node.arguments?.[0]);
  }

  // Number.isFinite(result)
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Number" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "isFinite"
  ) {
    return unwrapObservableNode(node.arguments?.[0]);
  }

  // Object.keys(result).length / Object.values(result).length
  if (
    node.type === "MemberExpression" &&
    node.property?.type === "Identifier" &&
    node.property.name === "length"
  ) {
    return unwrapObservableNode(node.object);
  }

  // Object.keys(result)
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Object" &&
    ["keys", "values", "entries"].includes(node.callee.property?.name)
  ) {
    return unwrapObservableNode(node.arguments?.[0]);
  }

  return null;
}

function getObservableExpressionSource({ parsed, target = {} }) {
  if (
    target.receivedSource &&
    !isUnsafeObservableExpressionSource(target.receivedSource)
  ) {
    try {
      const ast = parseModule(`const __x = ${target.receivedSource};`);
      const init = ast.program.body?.[0]?.declarations?.[0]?.init;
      const unwrapped = unwrapObservableNode(init);

      if (unwrapped && isSimpleObservableNode(unwrapped)) {
        return codeOf(unwrapped);
      }
    } catch {
      // fallback below
    }

    return target.receivedSource;
  }

  const receivedNode = parsed.receivedNode;
  const unwrappedNode = unwrapObservableNode(receivedNode) || receivedNode;
  const receivedSource = codeOf(unwrappedNode);

  if (!receivedSource || isUnsafeObservableExpressionSource(receivedSource)) {
    return "";
  }

  return receivedSource;
}

/* ======================================================
   CAPTURE STATEMENT
====================================================== */

function buildCaptureStatement(observableExpressionSource) {
  const captureCode = `
    console.log(
      "${RUNTIME_VALUE_MARKER}" +
      JSON.stringify(
        ((value) => {
          const seen = new WeakSet();

          function safePreview(input, depth = 0) {
            if (depth > 2) return "[MaxDepth]";

            if (input === null) return null;

            const type = typeof input;

            if (
              type === "string" ||
              type === "number" ||
              type === "boolean"
            ) {
              return input;
            }

            if (type === "undefined") return "[undefined]";
            if (type === "function") return "[Function]";
            if (type === "symbol") return "[Symbol]";
            if (type === "bigint") return String(input);

            if (type !== "object") return String(input);

            if (seen.has(input)) return "[Circular]";
            seen.add(input);

            if (Array.isArray(input)) {
              return input.slice(0, 5).map((item) => safePreview(item, depth + 1));
            }

            const output = {};
            const keys = Object.keys(input).slice(0, 8);

            for (const key of keys) {
              try {
                output[key] = safePreview(input[key], depth + 1);
              } catch {
                output[key] = "[Unreadable]";
              }
            }

            return output;
          }

          const valueType = value === null ? "null" : typeof value;
          const isArray = Array.isArray(value);

          const summary = {
            type: valueType,
            isArray,
            isNull: value === null,
            isUndefined: typeof value === "undefined",
          };

          if (
            valueType === "string" ||
            valueType === "number" ||
            valueType === "boolean"
          ) {
            summary.value = value;
          }

          if (valueType === "bigint") {
            summary.value = String(value);
          }

          if (isArray) {
            summary.length = value.length;
            summary.preview = safePreview(value);
          } else if (value && valueType === "object") {
            summary.keys = Object.keys(value);
            summary.preview = safePreview(value);
          }

          return summary;
        })(${observableExpressionSource})
      )
    );
  `;

  return parseStatement(captureCode);
}

/* ======================================================
   JEST OUTPUT EXTRACTION
====================================================== */

function pushChunk(chunks, value) {
  if (value === undefined || value === null) return;

  if (typeof value === "string") {
    chunks.push(value);
    return;
  }

  if (typeof value === "object") {
    try {
      chunks.push(JSON.stringify(value));
    } catch {
      chunks.push(String(value));
    }
    return;
  }

  chunks.push(String(value));
}

function collectStringsFromJestResult(result) {
  const chunks = [];

  if (!result) return chunks;

  if (typeof result === "string") {
    chunks.push(result);
    return chunks;
  }

  // UnitGen runner fields
  pushChunk(chunks, result.runnerStdout);
  pushChunk(chunks, result.runnerStderr);
  pushChunk(chunks, result.runnerOutput);
  pushChunk(chunks, result.runnerMessage);

  if (result.runnerError) {
    pushChunk(chunks, result.runnerError);
    pushChunk(chunks, result.runnerError.stdout);
    pushChunk(chunks, result.runnerError.stderr);
    pushChunk(chunks, result.runnerError.message);
  }

  // Generic fields
  pushChunk(chunks, result.stdout);
  pushChunk(chunks, result.stderr);
  pushChunk(chunks, result.output);
  pushChunk(chunks, result.message);
  pushChunk(chunks, result.error);

  const json = result.json && typeof result.json === "object" ? result.json : result;

  pushChunk(chunks, json?.runnerStdout);
  pushChunk(chunks, json?.runnerStderr);

  if (Array.isArray(json?.testResults)) {
    for (const suite of json.testResults) {
      pushChunk(chunks, suite.message);
      pushChunk(chunks, suite.failureMessage);

      for (const item of suite.console || []) {
        pushChunk(chunks, item?.message);
      }

      for (const assertion of suite.assertionResults || []) {
        if (Array.isArray(assertion.failureMessages)) {
          pushChunk(chunks, assertion.failureMessages.join("\n"));
        }
      }
    }
  }

  return chunks;
}

function extractObservedValuesFromResult(result) {
  const chunks = collectStringsFromJestResult(result);
  const observed = [];

  for (const chunk of chunks) {
    const text = String(chunk || "");
    const lines = text.split(/\n/);

    for (const line of lines) {
      const index = line.indexOf(RUNTIME_VALUE_MARKER);
      if (index === -1) continue;

      const jsonText = line.slice(index + RUNTIME_VALUE_MARKER.length).trim();

      if (!jsonText) continue;

      try {
        observed.push(JSON.parse(jsonText));
      } catch {
        // ignore malformed capture lines
      }
    }
  }

  return observed;
}

/* ======================================================
   OBSERVATION SAFETY
====================================================== */

function resultHasSuiteLoadCrash(result) {
  const json = result?.json && typeof result.json === "object" ? result.json : result;

  if (!json || typeof json !== "object") return false;

  const totalTests = Number(json.numTotalTests || 0);
  const runtimeSuites = Number(json.numRuntimeErrorTestSuites || 0);
  const failedSuites = Number(json.numFailedTestSuites || 0);

  return totalTests === 0 && (runtimeSuites > 0 || failedSuites > 0);
}

function isClearlyUnsafeTarget(target = {}) {
  const failureText = String(
    target.failureMessage ||
    target.errorMessage ||
    target.failureContext ||
    ""
  ).toLowerCase();

  return (
    failureText.includes("syntaxerror") ||
    failureText.includes("unexpected token") ||
    failureText.includes("referenceerror") ||
    failureText.includes("is not defined") ||
    failureText.includes("cannot find module") ||
    failureText.includes("module not found") ||
    failureText.includes("is not a function")
  );
}

/* ======================================================
   MAIN OBSERVER
====================================================== */

export async function observeRuntimeValue({
  filePath,
  testFilePath,
  target,
  runJestForFile = defaultRunJestForFile,
}) {
  const actualFilePath = filePath || testFilePath;

  if (!actualFilePath) {
    return {
      ok: false,
      reason: "MISSING_FILE_PATH",
      observedValue: null,
    };
  }

  if (!target) {
    return {
      ok: false,
      reason: "MISSING_TARGET",
      observedValue: null,
    };
  }

  if (typeof runJestForFile !== "function") {
    return {
      ok: false,
      reason: "MISSING_RUNNER",
      observedValue: null,
    };
  }

  if (isClearlyUnsafeTarget(target)) {
    return {
      ok: false,
      reason: "UNSAFE_TARGET",
      observedValue: null,
    };
  }

  const originalCode = fs.readFileSync(actualFilePath, "utf8");

  let ast;

  try {
    ast = parseModule(originalCode);
  } catch {
    return {
      ok: false,
      reason: "PARSE_FAILED",
      observedValue: null,
    };
  }

  const found = findTargetAssertionPath(ast, target);

  if (!found) {
    return {
      ok: false,
      reason: "TARGET_ASSERTION_NOT_FOUND",
      observedValue: null,
    };
  }

  const observableExpressionSource = getObservableExpressionSource({
    parsed: found.parsed,
    target,
  });

  if (!observableExpressionSource) {
    return {
      ok: false,
      reason: "NO_SAFE_OBSERVABLE_EXPRESSION",
      observedValue: null,
    };
  }

  const captureStatement = buildCaptureStatement(observableExpressionSource);
  if (!captureStatement) {
    return {
      ok: false,
      reason: "CAPTURE_STATEMENT_BUILD_FAILED",
      observedValue: null,
    };
  }

  const statementParent = found.path.getStatementParent?.();

  if (!statementParent || !statementParent.isExpressionStatement?.()) {
    return {
      ok: false,
      reason: "ASSERTION_STATEMENT_NOT_REPLACEABLE",
      observedValue: null,
    };
  }

  try {
    statementParent.insertBefore(captureStatement);

    const instrumentedCode = generate(ast).code;

    fs.writeFileSync(actualFilePath, instrumentedCode, "utf8");

    const result = await runJestForFile(actualFilePath);

    if (resultHasSuiteLoadCrash(result)) {
      return {
        ok: false,
        reason: "SUITE_LOAD_CRASH",
        observedValue: null,
        jestResult: result,
      };
    }

    const observedValues = extractObservedValuesFromResult(result);
    const observedValue = observedValues[0] || null;

    if (!observedValue) {
      return {
        ok: false,
        reason: "NO_RUNTIME_VALUE_CAPTURED",
        observedValue: null,
        jestResult: result,
      };
    }

    return {
      ok: true,
      reason: "OBSERVED",
      observedValue,
      observedValues,
      observableExpressionSource,
      assertionSource: found.source,
      testName: found.testName,
      matcher: found.parsed.matcher,
      jestResult: result,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "OBSERVATION_FAILED",
      error: error?.message || String(error),
      observedValue: null,
    };
  } finally {
    try {
      fs.writeFileSync(actualFilePath, originalCode, "utf8");
    } catch {
      // never throw from cleanup
    }
  }
}

export function isUsefulObservedValue(observedValue) {
  if (!observedValue || typeof observedValue !== "object") return false;

  if (observedValue.isUndefined) return false;

  if (observedValue.type === "function") return false;
  if (observedValue.type === "symbol") return false;

  return true;
}

export function summarizeObservedValueForLog(observedValue) {
  if (!observedValue || typeof observedValue !== "object") {
    return "none";
  }

  if (observedValue.isArray) {
    return `array(length=${observedValue.length ?? "unknown"})`;
  }

  if (observedValue.type === "object") {
    const keys = Array.isArray(observedValue.keys)
      ? observedValue.keys.slice(0, 5).join(", ")
      : "";

    return `object(keys=${keys || "none"})`;
  }

  if ("value" in observedValue) {
    return `${observedValue.type}(${String(observedValue.value)})`;
  }

  return observedValue.type || "unknown";
}