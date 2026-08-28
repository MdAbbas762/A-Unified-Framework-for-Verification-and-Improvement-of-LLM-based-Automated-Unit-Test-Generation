// src/core/assertion/assertionDetector.js

import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import generatorModule from "@babel/generator";

import { classifyAssertion } from "./assertionRules.js";

import { extractValueFromNode } from "./utils/valueExtractor.js";

const traverse = traverseModule.default;
const generate = generatorModule.default;

const UNITGEN_REPAIR_CANDIDATE_MARKER = "__UNITGEN_REPAIR_CANDIDATE__";

/* ======================================================
   SAFE SOURCE GENERATION
====================================================== */

function codeOf(node) {
  if (!node) return "";

  try {
    return generate(node).code;
  } catch {
    return "";
  }
}

function getMemberPropertyName(member) {
  if (!member || !t.isMemberExpression(member)) return "";

  if (t.isIdentifier(member.property)) {
    return member.property.name;
  }

  if (t.isStringLiteral(member.property)) {
    return member.property.value;
  }

  return "";
}

/* ======================================================
   EXPECT CHAIN PARSER
====================================================== */

function parseExpectMatcherChain(callNode) {
  if (!callNode || !t.isCallExpression(callNode)) return null;
  if (!t.isMemberExpression(callNode.callee)) return null;

  const finalMember = callNode.callee;
  const matcher = getMemberPropertyName(finalMember);

  if (!matcher) return null;

  let cursor = finalMember.object;
  const modifiers = [];

  while (t.isMemberExpression(cursor)) {
    const modifier = getMemberPropertyName(cursor);

    if (modifier) {
      modifiers.unshift(modifier);
    }

    cursor = cursor.object;
  }

  if (
    !t.isCallExpression(cursor) ||
    !t.isIdentifier(cursor.callee, { name: "expect" })
  ) {
    return null;
  }

  const expectCall = cursor;

  return {
    matcher,
    modifiers,
    expectCall,
    isNegated: modifiers.includes("not"),
    isAsyncChain:
      modifiers.includes("resolves") ||
      modifiers.includes("rejects") ||
      matcher === "resolves" ||
      matcher === "rejects",
    asyncModifier: modifiers.includes("resolves")
      ? "resolves"
      : modifiers.includes("rejects")
        ? "rejects"
        : "",
  };
}

/* ======================================================
   TEST CONTEXT DETECTION
====================================================== */

function isTestCallExpression(node) {
  if (!node || !t.isCallExpression(node)) return false;

  if (
    t.isIdentifier(node.callee) &&
    ["test", "it"].includes(node.callee.name)
  ) {
    return true;
  }

  if (
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object) &&
    ["test", "it"].includes(node.callee.object.name)
  ) {
    return true;
  }

  return false;
}

function getTestNameFromCall(node) {
  if (!isTestCallExpression(node)) return "";

  const firstArg = node.arguments?.[0];

  if (t.isStringLiteral(firstArg)) {
    return firstArg.value;
  }

  if (t.isTemplateLiteral(firstArg)) {
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

function getAssertionSource(path) {
  const parent = path.parentPath?.node;

  if (t.isAwaitExpression(parent)) {
    return codeOf(parent);
  }

  return codeOf(path.node);
}

/* ======================================================
   REPAIR CANDIDATE DETECTION
====================================================== */

function nodeHasRepairCandidateMarker(node) {
  if (!node) return false;

  const comments = [
    ...(node.leadingComments || []),
    ...(node.innerComments || []),
    ...(node.trailingComments || []),
  ];

  return comments.some((comment) =>
    String(comment.value || "").includes(UNITGEN_REPAIR_CANDIDATE_MARKER)
  );
}

function isInsideRepairCandidateTest(path) {
  const testNode = findEnclosingTestCall(path);
  if (!testNode) return false;

  const testSource = codeOf(testNode);
  if (testSource.includes(UNITGEN_REPAIR_CANDIDATE_MARKER)) {
    return true;
  }

  let foundMarker = false;

  function scanComments(node) {
    if (!node || typeof node !== "object" || foundMarker) return;

    if (nodeHasRepairCandidateMarker(node)) {
      foundMarker = true;
      return;
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) scanComments(item);
      } else if (value && typeof value === "object" && value.type) {
        scanComments(value);
      }
    }
  }

  scanComments(testNode);
  return foundMarker;
}

/* ======================================================
   TEST BLOCK ASSERTION CONTEXT
====================================================== */

function collectAssertionCallsInTest(testNode) {
  const assertions = [];

  if (!testNode) return assertions;

  const callback = testNode.arguments?.[1];

  if (
    !t.isFunctionExpression(callback) &&
    !t.isArrowFunctionExpression(callback)
  ) {
    return assertions;
  }

  /*
   * Important:
   * Do not call Babel traverse() directly on ArrowFunctionExpression/
   * FunctionExpression nodes without scope/parentPath. That causes:
   * "You must pass a scope and parentPath unless traversing a Program/File."
   *
   * This recursive visitor is enough here because we only need to collect
   * expect(...).matcher() calls inside the test callback.
   */
  function visit(node) {
    if (!node || typeof node !== "object") return;

    if (t.isCallExpression(node)) {
      const parsed = parseExpectMatcherChain(node);

      if (parsed) {
        assertions.push({
          node,
          source: codeOf(node),
          matcher: parsed.matcher,
          modifiers: parsed.modifiers,
        });
      }
    }

    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "extra" ||
        key === "leadingComments" ||
        key === "trailingComments" ||
        key === "innerComments"
      ) {
        continue;
      }

      const value = node[key];

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && item.type) {
            visit(item);
          }
        }
      } else if (value && typeof value === "object" && value.type) {
        visit(value);
      }
    }
  }

  visit(callback.body);

  return assertions;
}

function getAssertionIndexInTest(path, assertions = []) {
  const source = codeOf(path.node);

  for (let i = 0; i < assertions.length; i++) {
    if (assertions[i].node === path.node) return i;
    if (assertions[i].source === source) return i;
  }

  return -1;
}

function getSiblingAssertionSources(assertions = [], index = -1) {
  return assertions
    .filter((_, i) => i !== index)
    .map((a) => a.source)
    .filter(Boolean);
}

function getSiblingMatchers(assertions = [], index = -1) {
  return assertions
    .filter((_, i) => i !== index)
    .map((a) => a.matcher)
    .filter(Boolean);
}

/* ======================================================
   RECEIVED VALUE SHAPE DETECTION
====================================================== */

function getReceivedKind(receivedNode) {
  if (!receivedNode) return "missing";

  if (t.isIdentifier(receivedNode)) return "identifier";
  if (t.isMemberExpression(receivedNode)) return "member";
  if (t.isCallExpression(receivedNode)) return "call";
  if (t.isUnaryExpression(receivedNode) && receivedNode.operator === "typeof") {
    return "typeof";
  }
  if (t.isArrowFunctionExpression(receivedNode) || t.isFunctionExpression(receivedNode)) {
    return "function";
  }
  if (t.isArrayExpression(receivedNode)) return "array";
  if (t.isObjectExpression(receivedNode)) return "object";
  if (t.isStringLiteral(receivedNode)) return "string";
  if (t.isNumericLiteral(receivedNode)) return "number";
  if (t.isBooleanLiteral(receivedNode)) return "boolean";
  if (t.isNullLiteral(receivedNode)) return "null";

  return receivedNode.type || "unknown";
}

function isArrayIsArrayAssertion(receivedNode) {
  return (
    t.isCallExpression(receivedNode) &&
    t.isMemberExpression(receivedNode.callee) &&
    t.isIdentifier(receivedNode.callee.object, { name: "Array" }) &&
    t.isIdentifier(receivedNode.callee.property, { name: "isArray" })
  );
}

function isObjectKeysAssertion(receivedNode) {
  return (
    t.isCallExpression(receivedNode) &&
    t.isMemberExpression(receivedNode.callee) &&
    t.isIdentifier(receivedNode.callee.object, { name: "Object" }) &&
    ["keys", "values", "entries"].includes(
      getMemberPropertyName(receivedNode.callee)
    )
  );
}

function isLengthAssertion(receivedNode) {
  return (
    t.isMemberExpression(receivedNode) &&
    getMemberPropertyName(receivedNode) === "length"
  );
}

function isTypeofAssertion(receivedNode) {
  return (
    t.isUnaryExpression(receivedNode) &&
    receivedNode.operator === "typeof"
  );
}

/* ======================================================
   CONFIDENCE ENGINE
====================================================== */

function getConfidence({
  matcher,
  value,
  expectedNode,
  receivedNode,
  isNegated,
  isAsyncChain,
  isOnlyAssertionInTest,
  learningDB = {},
}) {
  const learned = learningDB[matcher];

  if (learned && learned.failures > learned.success) {
    return "HIGH";
  }

  if (
    matcher === "toBeDefined" ||
    matcher === "toBeTruthy" ||
    matcher === "toBeFalsy" ||
    matcher === "toBeUndefined" ||
    matcher === "toBeNull"
  ) {
    return "HIGH";
  }

  if (isNegated && ["toBeUndefined", "toBeNull"].includes(matcher)) {
    return "HIGH";
  }

  if (isAsyncChain) {
    return "HIGH";
  }

  if (
    isOnlyAssertionInTest &&
    (
      isArrayIsArrayAssertion(receivedNode) ||
      isObjectKeysAssertion(receivedNode) ||
      isLengthAssertion(receivedNode) ||
      isTypeofAssertion(receivedNode)
    )
  ) {
    return "HIGH";
  }

  if (
    expectedNode &&
    (
      t.isStringLiteral(expectedNode) ||
      t.isNumericLiteral(expectedNode) ||
      t.isBooleanLiteral(expectedNode) ||
      t.isNullLiteral(expectedNode)
    )
  ) {
    return "HIGH";
  }

  if (value && typeof value === "object") {
    return "MEDIUM";
  }

  if (
    value === undefined ||
    (value && value.__type === "dynamic") ||
    (value && value.__type === "identifier")
  ) {
    return "MEDIUM";
  }

  return "MEDIUM";
}

/* ======================================================
   MAIN DETECTOR
====================================================== */

export function detectAssertions(ast, learningDB = {}) {
  const detections = [];

  traverse(ast, {
    CallExpression(path) {
      const node = path.node;

      const parsed = parseExpectMatcherChain(node);
      if (!parsed) return;

      const {
        matcher,
        modifiers,
        expectCall,
        isNegated,
        isAsyncChain,
        asyncModifier,
      } = parsed;

      const isAwaited = t.isAwaitExpression(path.parentPath?.node);
      const receivedNode = expectCall.arguments?.[0];
      const enclosingTestCall = findEnclosingTestCall(path);
      const testName = getTestNameFromCall(enclosingTestCall);

      const testAssertions = collectAssertionCallsInTest(enclosingTestCall);
      const assertionIndex = getAssertionIndexInTest(path, testAssertions);
      const assertionCountInTest = testAssertions.length;
      const siblingAssertionSources = getSiblingAssertionSources(
        testAssertions,
        assertionIndex
      );
      const siblingMatchers = getSiblingMatchers(testAssertions, assertionIndex);
      const isOnlyAssertionInTest = assertionCountInTest <= 1;

      const isRepairCandidateTest = isInsideRepairCandidateTest(path);

      if (!receivedNode) {
        detections.push({
          type: "INVALID",
          matcher,
          modifiers,
          value: undefined,
          confidence: "LOW",
          path,
          node,
          expectNode: expectCall,
          receivedNode: null,
          expectedNode: null,

          source: getAssertionSource(path),
          receivedSource: "",
          expectedSource: "",

          testName,
          isNegated,
          isAsyncChain,
          asyncModifier,
          isAwaited,
          isRepairCandidateTest,

          assertionIndex,
          assertionCountInTest,
          siblingAssertionSources,
          siblingMatchers,
          isOnlyAssertionInTest,
          hasSiblingAssertions: assertionCountInTest > 1,

          isInsideFailedTest: false,
          receivedKind: "missing",
          isFunction: false,
        });
        return;
      }

      const expectedNode = node.arguments?.[0];
      const extractedValue = extractValueFromNode(expectedNode);

      const receivedSource = codeOf(receivedNode);
      const expectedSource = codeOf(expectedNode);
      const source = getAssertionSource(path);

      const type = classifyAssertion({
        matcher,
        value: extractedValue,
        expectedNode,
        receivedNode,
        receivedSource,
        expectedSource,
        source,
        isNegated,
        isAsyncChain,
        asyncModifier,
        assertionCountInTest,
        siblingAssertionSources,
        siblingMatchers,
        isOnlyAssertionInTest,
        hasSiblingAssertions: assertionCountInTest > 1,
        isRepairCandidateTest,
      });

      const confidence = getConfidence({
        matcher,
        value: extractedValue,
        expectedNode,
        receivedNode,
        isNegated,
        isAsyncChain,
        isOnlyAssertionInTest,
        learningDB,
      });

      detections.push({
        type,
        matcher,
        modifiers,
        value: extractedValue,
        confidence,
        path,
        node,
        expectNode: expectCall,
        receivedNode,
        expectedNode,

        source,
        receivedSource,
        expectedSource,

        testName,
        isNegated,
        isAsyncChain,
        asyncModifier,
        isAwaited,
        isRepairCandidateTest,

        assertionIndex,
        assertionCountInTest,
        siblingAssertionSources,
        siblingMatchers,
        isOnlyAssertionInTest,
        hasSiblingAssertions: assertionCountInTest > 1,

        isInsideFailedTest: false,

        receivedKind: getReceivedKind(receivedNode),
        isArrayIsArrayAssertion: isArrayIsArrayAssertion(receivedNode),
        isObjectKeysAssertion: isObjectKeysAssertion(receivedNode),
        isLengthAssertion: isLengthAssertion(receivedNode),
        isTypeofAssertion: isTypeofAssertion(receivedNode),

        isAsync:
          isAwaited ||
          isAsyncChain ||
          matcher === "toResolve" ||
          matcher === "toReject",

        isFunction:
          t.isArrowFunctionExpression(receivedNode) ||
          t.isFunctionExpression(receivedNode),
      });
    },
  });

  return detections;
}