// src/core/repair/strategies/evidenceRepairEngine.js
//
// Deterministic runtime-evidence repair. This engine only proposes changes that
// can be justified directly from Jest's observed Expected/Received information.
// Every proposal is still transactionally executed before it can be committed.

import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";
import * as t from "@babel/types";

import { parseSource } from "../../parser/parseFile.js";
import { validateSyntax } from "../../validation/validateSyntax.js";
import { parseJestFailureEvidence } from "../failureEvidence.js";

const traverse = traverseModule.default;
const generate = generatorModule.default;

function testNameMatches(failureName = "", currentName = "") {
  const a = String(failureName || "");
  const b = String(currentName || "");
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function getMemberName(node) {
  if (!t.isMemberExpression(node)) return "";
  if (t.isIdentifier(node.property)) return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  return "";
}

function parseExpectChain(callNode) {
  if (!t.isCallExpression(callNode) || !t.isMemberExpression(callNode.callee)) {
    return null;
  }

  const matcher = getMemberName(callNode.callee);
  if (!matcher) return null;

  let cursor = callNode.callee.object;
  const modifiers = [];

  while (t.isMemberExpression(cursor)) {
    const name = getMemberName(cursor);
    if (name) modifiers.unshift(name);
    cursor = cursor.object;
  }

  if (
    !t.isCallExpression(cursor) ||
    !t.isIdentifier(cursor.callee, { name: "expect" })
  ) {
    return null;
  }

  return {
    matcher,
    modifiers,
    expectCall: cursor,
  };
}

function valueNode(value, known = true) {
  if (!known) return null;
  if (value === undefined) return t.identifier("undefined");

  try {
    return t.valueToNode(value);
  } catch {
    return null;
  }
}

function isPrimitiveNode(node) {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isIdentifier(node, { name: "undefined" })
  );
}

function isErrorIntentName(name = "") {
  return /\b(error|invalid|reject|throw|fail|missing|unsupported|bad|wrong)\b/i.test(
    String(name || "")
  );
}

function makeMatcherCallee(expectCall, matcher, modifiers = []) {
  let object = expectCall;

  for (const modifier of modifiers) {
    object = t.memberExpression(object, t.identifier(modifier));
  }

  return t.memberExpression(object, t.identifier(matcher));
}

function rewriteMatcher(callPath, parsed, matcher, args = [], modifiers = null) {
  const safeModifiers = modifiers === null ? parsed.modifiers : modifiers;
  callPath.node.callee = makeMatcherCallee(parsed.expectCall, matcher, safeModifiers);
  callPath.node.arguments = args;
  return true;
}

function buildCandidate(
  originalCode,
  failure,
  mutate,
  strategy,
  reason,
  occurrence = 0
) {
  let ast;

  try {
    ast = parseSource(originalCode);
  } catch {
    return null;
  }

  let changed = false;
  let targetTest = "";
  let eligibleIndex = 0;

  traverse(ast, {
    CallExpression(testPath) {
      if (changed) return;

      const callee = testPath.node.callee;
      if (
        !t.isIdentifier(callee) ||
        !["test", "it"].includes(callee.name)
      ) {
        return;
      }

      const args = testPath.get("arguments");
      const titlePath = args[0];
      const fnPath = args[1];

      if (!titlePath?.isStringLiteral?.()) return;
      const title = titlePath.node.value;

      if (!testNameMatches(failure?.testName, title)) return;
      if (
        !fnPath?.isArrowFunctionExpression?.() &&
        !fnPath?.isFunctionExpression?.()
      ) {
        return;
      }

      targetTest = title;

      fnPath.traverse({
        CallExpression(assertionPath) {
          if (changed) return;

          const parsed = parseExpectChain(assertionPath.node);
          if (!parsed) return;

          const backupNode = t.cloneNode(assertionPath.node, true);
          const mutated = mutate({ assertionPath, parsed, title });

          if (!mutated) return;

          if (eligibleIndex !== occurrence) {
            assertionPath.replaceWith(backupNode);
            eligibleIndex += 1;
            return;
          }

          changed = true;
          assertionPath.stop();
        },
      });

      if (changed) testPath.stop();
    },
  });

  if (!changed) return null;

  const code = generate(ast).code;
  if (!code || code === originalCode || !validateSyntax(code)) return null;

  return {
    code,
    strategy,
    reason,
    testName: targetTest,
    occurrence,
  };
}

function buildExactObservedCandidate(originalCode, failure, evidence, occurrence = 0) {
  if (!evidence.receivedKnown) return null;

  return buildCandidate(
    originalCode,
    failure,
    ({ assertionPath, parsed }) => {
      if (evidence.matcher && parsed.matcher.toLowerCase() !== evidence.matcher.toLowerCase()) {
        return false;
      }

      const node = valueNode(evidence.receivedValue, evidence.receivedKnown);
      if (!node) return false;

      // Preserve exact-value semantics whenever a concrete stable primitive or
      // small JSON value was observed by Jest.
      if (["toBe", "toEqual", "toStrictEqual", "toBeCloseTo"].includes(parsed.matcher)) {
        const matcher = isPrimitiveNode(node) ? "toBe" : "toEqual";
        return rewriteMatcher(assertionPath, parsed, matcher, [node]);
      }

      if (parsed.matcher === "toBeDefined" && evidence.receivedValue === undefined) {
        return rewriteMatcher(assertionPath, parsed, "toBeUndefined", []);
      }

      if (parsed.matcher === "toBeUndefined" && evidence.receivedValue !== undefined) {
        const matcher = isPrimitiveNode(node) ? "toBe" : "toEqual";
        return rewriteMatcher(assertionPath, parsed, matcher, [node]);
      }

      if (parsed.matcher === "toBeNull" && evidence.receivedValue !== null) {
        const matcher = isPrimitiveNode(node) ? "toBe" : "toEqual";
        return rewriteMatcher(assertionPath, parsed, matcher, [node]);
      }

      if (
        ["toBeTruthy", "toBeFalsy"].includes(parsed.matcher) &&
        typeof evidence.receivedValue === "boolean"
      ) {
        return rewriteMatcher(
          assertionPath,
          parsed,
          "toBe",
          [t.booleanLiteral(evidence.receivedValue)]
        );
      }

      return false;
    },
    "runtime-exact-oracle",
    "Jest provided a concrete Received value for the failed oracle",
    occurrence
  );
}

function buildTypeofCandidate(originalCode, failure, evidence, occurrence = 0) {
  if (!evidence.receivedKnown || typeof evidence.receivedValue !== "string") {
    return null;
  }

  // Handles messages such as:
  // Expected: "number"
  // Received: "boolean"
  // for expect(typeof result).toBe("number")
  return buildCandidate(
    originalCode,
    failure,
    ({ assertionPath, parsed }) => {
      if (parsed.matcher !== "toBe") return false;

      const receivedNode = parsed.expectCall.arguments?.[0];
      if (!t.isUnaryExpression(receivedNode, { operator: "typeof" })) return false;

      if (evidence.expectedKnown && typeof evidence.expectedValue === "string") {
        return rewriteMatcher(
          assertionPath,
          parsed,
          "toBe",
          [t.stringLiteral(evidence.receivedValue)]
        );
      }

      return false;
    },
    "runtime-type-oracle",
    "Jest observed the concrete typeof result",
    occurrence
  );
}

function buildThrowWrapperCandidate(originalCode, failure, evidence, occurrence = 0) {
  if (!evidence.receivedMustBeFunction) return null;

  return buildCandidate(
    originalCode,
    failure,
    ({ assertionPath, parsed }) => {
      if (!["toThrow", "toThrowError"].includes(parsed.matcher)) return false;

      const receivedNode = parsed.expectCall.arguments?.[0];
      if (!t.isCallExpression(receivedNode)) return false;

      parsed.expectCall.arguments[0] = t.arrowFunctionExpression(
        [],
        t.cloneNode(receivedNode, true)
      );
      return true;
    },
    "throw-call-wrapper",
    "Jest requires toThrow/toThrowError to receive a function",
    occurrence
  );
}

function buildAsyncDirectionCandidate(originalCode, failure, evidence, occurrence = 0) {
  if (
    !evidence.promiseResolvedInsteadOfRejected &&
    !evidence.promiseRejectedInsteadOfResolved
  ) {
    return null;
  }

  return buildCandidate(
    originalCode,
    failure,
    ({ assertionPath, parsed, title }) => {
      const modifiers = [...parsed.modifiers];

      if (evidence.promiseResolvedInsteadOfRejected) {
        const idx = modifiers.indexOf("rejects");
        if (idx < 0 || isErrorIntentName(title)) return false;
        modifiers[idx] = "resolves";
        return rewriteMatcher(
          assertionPath,
          parsed,
          parsed.matcher,
          assertionPath.node.arguments,
          modifiers
        );
      }

      if (evidence.promiseRejectedInsteadOfResolved) {
        const idx = modifiers.indexOf("resolves");
        if (idx < 0 || !isErrorIntentName(title)) return false;
        modifiers[idx] = "rejects";
        return rewriteMatcher(
          assertionPath,
          parsed,
          parsed.matcher,
          assertionPath.node.arguments,
          modifiers
        );
      }

      return false;
    },
    "async-direction",
    "Jest proved the promise settled in the opposite direction",
    occurrence
  );
}

export function generateEvidenceRepairCandidates(originalCode, failures = []) {
  const candidates = [];
  const seen = new Set();

  const builders = [
    buildTypeofCandidate,
    buildExactObservedCandidate,
    buildThrowWrapperCandidate,
    buildAsyncDirectionCandidate,
  ];

  for (const failure of failures || []) {
    const evidence =
      failure?.evidence || parseJestFailureEvidence(failure?.errorMessage || "");

    for (const build of builders) {
      for (let occurrence = 0; occurrence < 8; occurrence += 1) {
        const candidate = build(
          originalCode,
          failure,
          evidence,
          occurrence
        );

        if (!candidate) break;
        if (!candidate.code || seen.has(candidate.code)) continue;

        seen.add(candidate.code);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}
