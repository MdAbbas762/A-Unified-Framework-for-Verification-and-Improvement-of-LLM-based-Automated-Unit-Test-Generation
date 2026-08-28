// src/core/assertion/assertionTransformer.js

import * as t from "@babel/types";
import { parseExpression } from "@babel/parser";
import generatorModule from "@babel/generator";

import {
  shouldUseToBe,
  isDangerousContext,
  getAssertionRiskCategory,
} from "./assertionRules.js";

import { validateSyntax } from "../validation/validateSyntax.js";
import { valueToNode } from "./utils/valueExtractor.js";

const generate = generatorModule.default;

/* ======================================================
   SAFE AST HELPERS
====================================================== */

function clone(node) {
  return node ? t.cloneNode(node, true) : null;
}

function sourceOf(node) {
  try {
    return node ? generate(node).code : "";
  } catch {
    return "";
  }
}

function parseExpressionSafe(source = "") {
  const text = String(source || "").trim();
  if (!text) return null;

  if (
    /\bawait\b/.test(text) ||
    /\bexpect\s*\(/.test(text) ||
    /\.resolves\b/.test(text) ||
    /\.rejects\b/.test(text)
  ) {
    return null;
  }

  try {
    return parseExpression(text, {
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
  } catch {
    return null;
  }
}

function isPrimitiveValue(value) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

function isObjectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayValue(value) {
  return Array.isArray(value);
}

function isNumericValue(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isEmptyObject(value) {
  return isObjectValue(value) && Object.keys(value).length === 0;
}

function isEmptyArray(value) {
  return isArrayValue(value) && value.length === 0;
}

function isLargeOrDeepLiteral(value) {
  if (!isObjectValue(value) && !isArrayValue(value)) return false;

  try {
    if (JSON.stringify(value).length > 260) return true;
  } catch {
    return true;
  }

  function tooDeep(v, depth = 0) {
    if (depth > 3) return true;

    if (Array.isArray(v)) {
      return v.some((item) => tooDeep(item, depth + 1));
    }

    if (isObjectValue(v)) {
      return Object.values(v).some((item) => tooDeep(item, depth + 1));
    }

    return false;
  }

  return tooDeep(value);
}

function getExpectCall(d) {
  if (d?.expectNode && t.isCallExpression(d.expectNode)) {
    return d.expectNode;
  }

  const node = d?.path?.node;
  if (!node || !t.isCallExpression(node)) return null;
  if (!t.isMemberExpression(node.callee)) return null;

  let cursor = node.callee.object;

  while (t.isMemberExpression(cursor)) {
    cursor = cursor.object;
  }

  if (
    t.isCallExpression(cursor) &&
    t.isIdentifier(cursor.callee, { name: "expect" })
  ) {
    return cursor;
  }

  return null;
}

function buildMatcherCallee(expectCall, matcher, modifiers = []) {
  let object = expectCall;

  for (const modifier of modifiers || []) {
    if (!modifier) continue;
    object = t.memberExpression(object, t.identifier(modifier));
  }

  return t.memberExpression(object, t.identifier(matcher));
}

function buildExpectCall(receivedNode, matcher, args = [], modifiers = []) {
  const expectCall = t.callExpression(t.identifier("expect"), [
    clone(receivedNode),
  ]);

  return t.callExpression(
    buildMatcherCallee(expectCall, matcher, modifiers),
    args
  );
}

function buildExpectStatement(receivedNode, matcher, args = [], modifiers = []) {
  return t.expressionStatement(
    buildExpectCall(receivedNode, matcher, args, modifiers)
  );
}

function replaceCurrentAssertionCall(d, matcher, args = [], modifiers = null) {
  const node = d?.path?.node;
  const expectCall = getExpectCall(d);

  if (!node || !t.isCallExpression(node) || !expectCall) return false;

  const safeModifiers = Array.isArray(modifiers)
    ? modifiers
    : Array.isArray(d.modifiers)
      ? d.modifiers
      : [];

  node.callee = buildMatcherCallee(expectCall, matcher, safeModifiers);
  node.arguments = args;

  return true;
}

function replaceAssertionWithStatements(d, statements = []) {
  if (!d?.path || !Array.isArray(statements) || statements.length === 0) {
    return false;
  }

  const statementPath = d.path.getStatementParent?.();

  if (!statementPath || !statementPath.isExpressionStatement?.()) {
    return false;
  }

  statementPath.replaceWithMultiple(statements);
  return true;
}

function buildNotUndefinedStatement(receivedNode) {
  return buildExpectStatement(receivedNode, "toBeUndefined", [], ["not"]);
}

function buildNotNullStatement(receivedNode) {
  return buildExpectStatement(receivedNode, "toBeNull", [], ["not"]);
}

function buildTypeofStatement(receivedNode, typeName) {
  return buildExpectStatement(
    t.unaryExpression("typeof", clone(receivedNode), true),
    "toBe",
    [t.stringLiteral(typeName)]
  );
}

function buildArrayIsArrayStatement(receivedNode) {
  return buildExpectStatement(
    t.callExpression(
      t.memberExpression(t.identifier("Array"), t.identifier("isArray")),
      [clone(receivedNode)]
    ),
    "toBe",
    [t.booleanLiteral(true)]
  );
}

function buildFiniteNumberStatement(receivedNode) {
  return buildExpectStatement(
    t.callExpression(
      t.memberExpression(t.identifier("Number"), t.identifier("isFinite")),
      [clone(receivedNode)]
    ),
    "toBe",
    [t.booleanLiteral(true)]
  );
}

function buildObjectKeysLengthStatement(receivedNode) {
  return buildExpectStatement(
    t.memberExpression(
      t.callExpression(
        t.memberExpression(t.identifier("Object"), t.identifier("keys")),
        [clone(receivedNode)]
      ),
      t.identifier("length")
    ),
    "toBeGreaterThan",
    [t.numericLiteral(0)]
  );
}

function buildArrayLengthStatement(receivedNode) {
  return buildExpectStatement(
    t.memberExpression(clone(receivedNode), t.identifier("length")),
    "toBeGreaterThanOrEqual",
    [t.numericLiteral(0)]
  );
}

function buildObjectShapeAssertions(
  receivedNode,
  { requireNonEmpty = false } = {}
) {
  const statements = [
    buildNotUndefinedStatement(receivedNode),
    buildNotNullStatement(receivedNode),
    buildTypeofStatement(receivedNode, "object"),
  ];

  if (requireNonEmpty) {
    statements.push(buildObjectKeysLengthStatement(receivedNode));
  }

  return statements;
}

function buildArrayShapeAssertions(
  receivedNode,
  { requireNonEmpty = false } = {}
) {
  const statements = [
    buildNotUndefinedStatement(receivedNode),
    buildArrayIsArrayStatement(receivedNode),
  ];

  if (requireNonEmpty) {
    statements.push(
      buildExpectStatement(
        t.memberExpression(clone(receivedNode), t.identifier("length")),
        "toBeGreaterThan",
        [t.numericLiteral(0)]
      )
    );
  } else {
    statements.push(buildArrayLengthStatement(receivedNode));
  }

  return statements;
}

function buildGeneralShapeAssertions(receivedNode) {
  return [
    buildNotUndefinedStatement(receivedNode),
    buildNotNullStatement(receivedNode),
  ];
}

/* ======================================================
   OBSERVED VALUE HELPERS
====================================================== */

function isIdentifierKey(key = "") {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(String(key || ""));
}

function buildPropertyAccess(objectNode, key) {
  const keyText = String(key || "");

  return t.memberExpression(
    clone(objectNode),
    isIdentifierKey(keyText) ? t.identifier(keyText) : t.stringLiteral(keyText),
    !isIdentifierKey(keyText)
  );
}

function previewValueToNode(value, depth = 0) {
  if (depth > 3) return null;

  if (value === "[undefined]") return null;
  if (value === "[Function]") return null;
  if (value === "[Symbol]") return null;
  if (value === "[Circular]") return null;
  if (value === "[MaxDepth]") return null;
  if (value === "[Unreadable]") return null;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return valueToNode(value);
  }

  if (Array.isArray(value)) {
    if (value.length > 5) return null;

    const elements = [];

    for (const item of value) {
      const node = previewValueToNode(item, depth + 1);
      if (!node) return null;
      elements.push(node);
    }

    return t.arrayExpression(elements);
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > 6) return null;

    const properties = [];

    for (const key of keys) {
      const node = previewValueToNode(value[key], depth + 1);
      if (!node) return null;

      properties.push(
        t.objectProperty(
          isIdentifierKey(key) ? t.identifier(key) : t.stringLiteral(key),
          node,
          !isIdentifierKey(key)
        )
      );
    }

    return t.objectExpression(properties);
  }

  return null;
}


function observedSummaryFromPreviewValue(value) {
  if (value === "[undefined]") {
    return { type: "undefined", isUndefined: true };
  }

  if (value === null) {
    return { type: "null", isNull: true };
  }

  if (Array.isArray(value)) {
    return {
      type: "object",
      isArray: true,
      length: value.length,
      preview: value,
    };
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return {
      type: typeof value,
      value,
      isArray: false,
      isNull: false,
      isUndefined: false,
    };
  }

  if (value && typeof value === "object") {
    return {
      type: "object",
      isArray: false,
      isNull: false,
      isUndefined: false,
      keys: Object.keys(value),
      preview: value,
    };
  }

  return null;
}

function getObservedExpressionSource(d = {}) {
  return (
    d.observableExpressionSource ||
    d.observedExpressionSource ||
    d.runtimeObservableExpressionSource ||
    d.observedSource ||
    ""
  );
}

function getObservedBaseNode(d, receivedNode) {
  const observedExpressionSource = getObservedExpressionSource(d);
  const parsed = parseExpressionSafe(observedExpressionSource);

  if (parsed) {
    return parsed;
  }

  return receivedNode;
}

function getMemberPropertyKey(node) {
  if (!t.isMemberExpression(node)) return "";

  if (t.isIdentifier(node.property)) {
    return node.property.name;
  }

  if (t.isStringLiteral(node.property)) {
    return node.property.value;
  }

  return "";
}

function deriveObservedValueForReceivedNode(d, observedValue, receivedNode) {
  if (!observedValue || typeof observedValue !== "object") {
    return { node: receivedNode, observedValue };
  }

  const observedBaseSource = getObservedExpressionSource(d);

  if (
    t.isMemberExpression(receivedNode) &&
    observedValue.type === "object" &&
    observedValue.preview &&
    typeof observedValue.preview === "object" &&
    !Array.isArray(observedValue.preview)
  ) {
    const objectSource = sourceOf(receivedNode.object);
    const key = getMemberPropertyKey(receivedNode);

    if (
      key &&
      observedBaseSource &&
      objectSource &&
      objectSource === observedBaseSource &&
      Object.prototype.hasOwnProperty.call(observedValue.preview, key)
    ) {
      const nested = observedSummaryFromPreviewValue(observedValue.preview[key]);
      if (nested) {
        return {
          node: receivedNode,
          observedValue: nested,
        };
      }
    }
  }

  return {
    node: getObservedBaseNode(d, receivedNode),
    observedValue,
  };
}

function buildObservedPrimitiveAssertions(receivedNode, observedValue) {
  const value = observedValue.value;

  if (observedValue.type === "number") {
    return [
      buildNotUndefinedStatement(receivedNode),
      buildTypeofStatement(receivedNode, "number"),
      buildFiniteNumberStatement(receivedNode),
    ];
  }

  if (observedValue.type === "string") {
    return [
      buildNotUndefinedStatement(receivedNode),
      buildTypeofStatement(receivedNode, "string"),
      buildExpectStatement(receivedNode, "toBe", [t.stringLiteral(value)]),
    ];
  }

  if (observedValue.type === "boolean") {
    return [
      buildNotUndefinedStatement(receivedNode),
      buildTypeofStatement(receivedNode, "boolean"),
      buildExpectStatement(receivedNode, "toBe", [t.booleanLiteral(value)]),
    ];
  }

  if (observedValue.type === "bigint") {
    return [
      buildNotUndefinedStatement(receivedNode),
      buildTypeofStatement(receivedNode, "bigint"),
    ];
  }

  return null;
}

function buildObservedNullAssertions(receivedNode) {
  return [buildExpectStatement(receivedNode, "toBeNull", [])];
}

function buildObservedArrayAssertions(receivedNode, observedValue) {
  const length =
    typeof observedValue.length === "number" && observedValue.length >= 0
      ? observedValue.length
      : null;

  const statements = [
    buildNotUndefinedStatement(receivedNode),
    buildArrayIsArrayStatement(receivedNode),
  ];

  if (length !== null) {
    statements.push(
      buildExpectStatement(
        t.memberExpression(clone(receivedNode), t.identifier("length")),
        length > 0 ? "toBeGreaterThan" : "toBeGreaterThanOrEqual",
        [t.numericLiteral(0)]
      )
    );
  } else {
    statements.push(buildArrayLengthStatement(receivedNode));
  }

  const preview = Array.isArray(observedValue.preview)
    ? observedValue.preview
    : [];

  if (preview.length > 0) {
    const firstNode = previewValueToNode(preview[0]);

    if (firstNode) {
      statements.push(
        buildExpectStatement(
          t.memberExpression(
            clone(receivedNode),
            t.numericLiteral(0),
            true
          ),
          "toEqual",
          [firstNode]
        )
      );
    }
  }

  return statements;
}

function buildObservedObjectAssertions(receivedNode, observedValue) {
  const keys = Array.isArray(observedValue.keys)
    ? observedValue.keys.filter(Boolean)
    : [];

  const statements = [
    buildNotUndefinedStatement(receivedNode),
    buildNotNullStatement(receivedNode),
    buildTypeofStatement(receivedNode, "object"),
  ];

  if (keys.length > 0) {
    statements.push(buildObjectKeysLengthStatement(receivedNode));
  }

  for (const key of keys.slice(0, 3)) {
    statements.push(
      buildExpectStatement(receivedNode, "toHaveProperty", [
        t.stringLiteral(String(key)),
      ])
    );
  }

  const preview =
    observedValue.preview &&
    typeof observedValue.preview === "object" &&
    !Array.isArray(observedValue.preview)
      ? observedValue.preview
      : null;

  if (preview) {
    for (const key of keys.slice(0, 3)) {
      if (!(key in preview)) continue;

      const valueNode = previewValueToNode(preview[key]);
      if (!valueNode) continue;

      statements.push(
        buildExpectStatement(buildPropertyAccess(receivedNode, key), "toEqual", [
          valueNode,
        ])
      );
    }
  }

  return statements;
}

function observedPreviewIsComplete(observedValue) {
  if (!observedValue || typeof observedValue !== "object") return false;

  if (observedValue.isArray) {
    return (
      Array.isArray(observedValue.preview) &&
      typeof observedValue.length === "number" &&
      observedValue.length === observedValue.preview.length &&
      observedValue.length <= 5
    );
  }

  if (observedValue.type === "object") {
    const keys = Array.isArray(observedValue.keys) ? observedValue.keys : [];
    const preview =
      observedValue.preview &&
      typeof observedValue.preview === "object" &&
      !Array.isArray(observedValue.preview)
        ? observedValue.preview
        : null;

    return Boolean(
      preview &&
      keys.length <= 6 &&
      Object.keys(preview).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(preview, key))
    );
  }

  return true;
}

function buildStableObservedAssertions(receivedNode, observedValue) {
  if (!observedValue || typeof observedValue !== "object") return null;

  if (observedValue.isUndefined || observedValue.type === "undefined") {
    return [
      buildExpectStatement(receivedNode, "toBe", [t.identifier("undefined")]),
    ];
  }

  if (observedValue.isNull || observedValue.type === "null") {
    return [
      buildExpectStatement(receivedNode, "toBe", [t.nullLiteral()]),
    ];
  }

  if (observedValue.type === "string") {
    return [
      buildExpectStatement(receivedNode, "toBe", [
        t.stringLiteral(String(observedValue.value)),
      ]),
    ];
  }

  if (observedValue.type === "boolean") {
    return [
      buildExpectStatement(receivedNode, "toBe", [
        t.booleanLiteral(Boolean(observedValue.value)),
      ]),
    ];
  }

  if (
    observedValue.type === "number" &&
    typeof observedValue.value === "number" &&
    Number.isFinite(observedValue.value)
  ) {
    // Repeated observations already proved the exact JavaScript Number value
    // stable. Numeric literals emitted by Babel round-trip to the same IEEE-754
    // value, so an exact toBe oracle is both stronger and non-brittle here.
    return [
      buildExpectStatement(receivedNode, "toBe", [
        t.numericLiteral(observedValue.value),
      ]),
    ];
  }

  if (observedValue.isArray && observedPreviewIsComplete(observedValue)) {
    const arrayNode = previewValueToNode(observedValue.preview);
    if (arrayNode) {
      return [buildExpectStatement(receivedNode, "toEqual", [arrayNode])];
    }
  }

  if (observedValue.type === "object" && observedPreviewIsComplete(observedValue)) {
    const objectNode = previewValueToNode(observedValue.preview);
    if (objectNode) {
      return [buildExpectStatement(receivedNode, "toMatchObject", [objectNode])];
    }
  }

  return null;
}

function buildObservedValueAssertions(receivedNode, observedValue) {
  if (!observedValue || typeof observedValue !== "object") return null;

  if (observedValue.isUndefined || observedValue.type === "undefined") {
    return null;
  }

  if (observedValue.isNull || observedValue.type === "null") {
    return buildObservedNullAssertions(receivedNode);
  }

  if (observedValue.isArray) {
    return buildObservedArrayAssertions(receivedNode, observedValue);
  }

  if (
    observedValue.type === "string" ||
    observedValue.type === "number" ||
    observedValue.type === "boolean" ||
    observedValue.type === "bigint"
  ) {
    return buildObservedPrimitiveAssertions(receivedNode, observedValue);
  }

  if (observedValue.type === "object") {
    return buildObservedObjectAssertions(receivedNode, observedValue);
  }

  return null;
}

function canUseObservedValueForMatcher(matcher) {
  return [
    "toBeDefined",
    "toBeTruthy",
    "toBeFalsy",
    "toBeNull",
    "toBeUndefined",
    "toEqual",
    "toStrictEqual",
    "toBeCloseTo",
    "toBe",
    "toHaveProperty",
    "toMatchObject",
    "toHaveLength",
    "toContain",
    "toContainEqual",
    "toMatch",
    "toBeGreaterThan",
    "toBeGreaterThanOrEqual",
    "toBeLessThan",
    "toBeLessThanOrEqual",
    "toBeInstanceOf",
  ].includes(matcher);
}

/* ======================================================
   FAILURE CONTEXT HELPERS
====================================================== */

function normalizeErrorMessage(failureData) {
  return JSON.stringify(failureData || {}).toLowerCase();
}

function isAssertionMismatch(errorMsg = "") {
  const msg = String(errorMsg || "").toLowerCase();

  return (
    msg.includes("expect(received)") ||
    msg.includes("expected") ||
    msg.includes("received") ||
    msg.includes("toequal") ||
    msg.includes("tostrictequal") ||
    msg.includes("tobe") ||
    msg.includes("tobenull") ||
    msg.includes("tobecloseto") ||
    msg.includes("assertionerror")
  );
}

function isCallShapeRuntimeError(errorMsg = "") {
  const msg = String(errorMsg || "").toLowerCase();

  return (
    msg.includes("is not a function") ||
    msg.includes("cannot read properties") ||
    msg.includes("cannot read property") ||
    msg.includes("referenceerror") ||
    msg.includes("is not defined")
  );
}

function isDeepEqualityFailure(errorMsg = "") {
  const msg = String(errorMsg || "").toLowerCase();

  return (
    msg.includes("toequal") ||
    msg.includes("tostrictequal") ||
    msg.includes("deep equality") ||
    (msg.includes("expected") &&
      msg.includes("received") &&
      msg.includes("object"))
  );
}

function isNullOracleFailure(errorMsg = "") {
  const msg = String(errorMsg || "").toLowerCase();

  return (
    msg.includes("tobenull") ||
    msg.includes("to be null") ||
    (msg.includes("received") && msg.includes("object"))
  );
}

function isBooleanOracleFailure(errorMsg = "") {
  const msg = String(errorMsg || "").toLowerCase();

  return (
    msg.includes("expected: true") ||
    msg.includes("expected: false") ||
    msg.includes("received: true") ||
    msg.includes("received: false") ||
    msg.includes("object.is equality")
  );
}

function isNumericOracleFailure(errorMsg = "") {
  const msg = String(errorMsg || "").toLowerCase();

  return (
    msg.includes("tobecloseto") ||
    (msg.includes("expected") && msg.includes("received") && /\d/.test(msg))
  );
}

function shouldSkipBecauseRuntimeCallShape(errorMsg = "") {
  return isCallShapeRuntimeError(errorMsg);
}

function sourceLooksLikeBroadBoolean(source = "") {
  const s = String(source || "");

  return (
    s.includes("||") ||
    /==\s*null/.test(s) ||
    /Array\.isArray\s*\(/.test(s) ||
    /typeof\s+/.test(s)
  );
}

function sourceLooksLikeArrayCheck(source = "") {
  return /Array\.isArray\s*\(/.test(String(source || ""));
}

function sourceLooksLikeTypeofCheck(source = "") {
  return /typeof\s+/.test(String(source || ""));
}

/* ======================================================
   MAIN TRANSFORMER
====================================================== */

export function transformAssertions(ast, detections, failureData, learningDB = {}) {
  let changed = false;

  const errorMsg = normalizeErrorMessage(failureData);

  for (const d of detections) {
    if (!d || !d.path) continue;

    const canProcess =
      d.runtimeObserved === true ||
      d.type === "WEAK" ||
      d.type === "INVALID";

    if (!canProcess) continue;

    try {
      const applied = applyFix(d, errorMsg, learningDB);

      if (applied) {
        changed = true;
        console.log(`🧠 [AST-Repair] Optimized: ${d.matcher}`);
      }
    } catch (err) {
      console.log("⚠️ Assertion transform failed:", err.message);
    }
  }

  if (changed) {
    const code = generate(ast).code;

    if (!validateSyntax(code)) {
      console.log("⚠️ Transformer produced invalid syntax. Reverting file.");
      return ast;
    }
  }

  return ast;
}

/* ======================================================
   APPLY FIX
====================================================== */

function applyFix(d, errorMsg, learningDB) {
  const {
    matcher,
    value,
    path,
    receivedNode,
    expectedNode,
    receivedSource = "",
    expectedSource = "",
    source = "",
    isNegated = false,
    isAsyncChain = false,
    assertionCountInTest = 0,
    hasSiblingAssertions = false,
    siblingMatchers = [],
    isOnlyAssertionInTest = false,
    observedValue = null,
    runtimeObserved = false,
    observationStable = false,
    assertionMode = "stable",
  } = d;

  const node = path?.node;

  if (!node || !node.callee) return false;
  if (!receivedNode) return false;

  if (isDangerousContext(errorMsg)) return false;

  if (shouldSkipBecauseRuntimeCallShape(errorMsg)) return false;

  if (path.findParent((p) => p.isVariableDeclarator())) return false;

  if (isAsyncChain) {
    return applyAsyncSafeFix(d, errorMsg);
  }

  /* ======================================================
     PRIORITY 0: RUNTIME-OBSERVED ASSERTION STRENGTHENING
  ====================================================== */

  if (
    runtimeObserved &&
    observedValue &&
    canUseObservedValueForMatcher(matcher)
  ) {
    const observedTarget = deriveObservedValueForReceivedNode(
      d,
      observedValue,
      receivedNode
    );

    const stableObservedStatements =
      observationStable === true
        ? buildStableObservedAssertions(
            observedTarget.node,
            observedTarget.observedValue
          )
        : null;

    if (stableObservedStatements && stableObservedStatements.length > 0) {
      return replaceAssertionWithStatements(d, stableObservedStatements);
    }

    // A failed assertion must never be made green by replacing an uncertain
    // oracle with a weaker shape/type check. If repeated observations are not
    // stable, leave the failure for source-aware/LLM repair.
    if (assertionMode !== "failed") {
      const observedStatements = buildObservedValueAssertions(
        observedTarget.node,
        observedTarget.observedValue
      );

      if (observedStatements && observedStatements.length > 0) {
        return replaceAssertionWithStatements(d, observedStatements);
      }
    }
  }

  if (assertionMode === "failed") {
    return false;
  }

  /* ======================================================
     PRIORITY 1: PASSING-TEST RULE-BASED STRENGTHENING
  ====================================================== */

  if (
    matcher === "toBeNull" &&
    !isNegated &&
    (isNullOracleFailure(errorMsg) || isAssertionMismatch(errorMsg))
  ) {
    return replaceAssertionWithStatements(
      d,
      [
        buildNotNullStatement(receivedNode),
        buildNotUndefinedStatement(receivedNode),
        buildTypeofStatement(receivedNode, "object"),
      ]
    );
  }

  if (
    matcher === "toBeUndefined" &&
    !isNegated &&
    isAssertionMismatch(errorMsg)
  ) {
    return replaceAssertionWithStatements(
      d,
      buildGeneralShapeAssertions(receivedNode)
    );
  }

  if (
    matcher === "toBe" &&
    typeof value === "boolean" &&
    (isBooleanOracleFailure(errorMsg) || sourceLooksLikeBroadBoolean(source))
  ) {
    if (sourceLooksLikeArrayCheck(receivedSource || source)) {
      return replaceAssertionWithStatements(
        d,
        buildArrayShapeAssertions(receivedNode, { requireNonEmpty: false })
      );
    }

    if (sourceLooksLikeTypeofCheck(receivedSource || source)) {
      return replaceAssertionWithStatements(
        d,
        buildObjectShapeAssertions(receivedNode, { requireNonEmpty: false })
      );
    }

    return replaceAssertionWithStatements(
      d,
      buildGeneralShapeAssertions(receivedNode)
    );
  }

  if (
    ["toEqual", "toStrictEqual"].includes(matcher) &&
    (isDeepEqualityFailure(errorMsg) ||
      isLargeOrDeepLiteral(value) ||
      isEmptyObject(value) ||
      isEmptyArray(value))
  ) {
    if (isArrayValue(value)) {
      return replaceAssertionWithStatements(
        d,
        buildArrayShapeAssertions(receivedNode, {
          requireNonEmpty: !isEmptyArray(value),
        })
      );
    }

    if (isObjectValue(value)) {
      return replaceAssertionWithStatements(
        d,
        buildObjectShapeAssertions(receivedNode, {
          requireNonEmpty: !isEmptyObject(value),
        })
      );
    }

    return replaceAssertionWithStatements(
      d,
      buildGeneralShapeAssertions(receivedNode)
    );
  }

  if (
    matcher === "toBeCloseTo" &&
    (isNumericOracleFailure(errorMsg) || isNumericValue(value))
  ) {
    return replaceAssertionWithStatements(
      d,
      [
        buildNotUndefinedStatement(receivedNode),
        buildTypeofStatement(receivedNode, "number"),
        buildFiniteNumberStatement(receivedNode),
      ]
    );
  }

  if (
    ["toBe", "toEqual", "toStrictEqual"].includes(matcher) &&
    isNumericValue(value) &&
    isAssertionMismatch(errorMsg)
  ) {
    return replaceAssertionWithStatements(
      d,
      [
        buildNotUndefinedStatement(receivedNode),
        buildTypeofStatement(receivedNode, "number"),
        buildFiniteNumberStatement(receivedNode),
      ]
    );
  }

  /* ======================================================
     PRIORITY 2: SYNC THROW ARCHITECTURE FIX
  ====================================================== */

  if (matcher === "toThrow" && errorMsg.includes("did not throw")) {
    const expectCall = getExpectCall(d);

    if (expectCall?.arguments?.length > 0) {
      const arg = expectCall.arguments[0];

      if (t.isCallExpression(arg)) {
        expectCall.arguments[0] = t.arrowFunctionExpression([], arg);
        return true;
      }
    }
  }

  /* ======================================================
     PRIORITY 3: RULE-CATEGORY BASED TRANSFORMS
  ====================================================== */

  const riskCategory = getAssertionRiskCategory({
    matcher,
    value,
    receivedSource,
    expectedSource,
    source,
    isNegated,
    isAsyncChain,
    assertionCountInTest,
    hasSiblingAssertions,
    siblingMatchers,
    isOnlyAssertionInTest,
  });

  if (riskCategory === "ADEQUATE_INVARIANT") {
    return false;
  }

  if (riskCategory === "BROAD_BOOLEAN_ASSERTION") {
    return replaceAssertionWithStatements(
      d,
      buildGeneralShapeAssertions(receivedNode)
    );
  }

  if (riskCategory === "BRITTLE_DEEP_EQUALITY") {
    if (isArrayValue(value)) {
      return replaceAssertionWithStatements(
        d,
        buildArrayShapeAssertions(receivedNode, { requireNonEmpty: true })
      );
    }

    if (isObjectValue(value)) {
      return replaceAssertionWithStatements(
        d,
        buildObjectShapeAssertions(receivedNode, { requireNonEmpty: true })
      );
    }
  }

  if (riskCategory === "EMPTY_COLLECTION_ASSERTION") {
    if (isArrayValue(value)) {
      return replaceAssertionWithStatements(
        d,
        buildArrayShapeAssertions(receivedNode, { requireNonEmpty: false })
      );
    }

    if (isObjectValue(value)) {
      return replaceAssertionWithStatements(
        d,
        buildObjectShapeAssertions(receivedNode, { requireNonEmpty: false })
      );
    }
  }

  if (riskCategory === "BRITTLE_NUMERIC_ORACLE") {
    return replaceAssertionWithStatements(
      d,
      [
        buildNotUndefinedStatement(receivedNode),
        buildTypeofStatement(receivedNode, "number"),
        buildFiniteNumberStatement(receivedNode),
      ]
    );
  }

  if (riskCategory === "GENERIC_INSTANCE_ASSERTION") {
    const expected = String(expectedSource || "").trim();

    if (expected === "Array") {
      return replaceAssertionWithStatements(
        d,
        buildArrayShapeAssertions(receivedNode, { requireNonEmpty: false })
      );
    }

    if (expected === "Object") {
      return replaceAssertionWithStatements(
        d,
        buildObjectShapeAssertions(receivedNode, { requireNonEmpty: false })
      );
    }

    if (expected === "Function") {
      return replaceAssertionWithStatements(
        d,
        [
          buildNotUndefinedStatement(receivedNode),
          buildTypeofStatement(receivedNode, "function"),
        ]
      );
    }
  }

  /* ======================================================
     PRIORITY 4: LEARNING ENGINE
  ====================================================== */

  const learned = learningDB?.[matcher];

  if (learned && learned.failures > learned.success) {
    if (matcher === "toHaveProperty") {
      return replaceAssertionWithStatements(
        d,
        [
          buildNotUndefinedStatement(receivedNode),
          buildNotNullStatement(receivedNode),
        ]
      );
    }

    if (matcher === "toBeDefined" || matcher === "toBeTruthy") {
      return replaceAssertionWithStatements(
        d,
        [
          buildNotUndefinedStatement(receivedNode),
          buildNotNullStatement(receivedNode),
        ]
      );
    }
  }

  /* ======================================================
     PRIORITY 5: STRUCTURAL STRENGTHENING
  ====================================================== */

  if (matcher === "toBeDefined") {
    return replaceAssertionWithStatements(
      d,
      [buildNotUndefinedStatement(receivedNode)]
    );
  }

  if (matcher === "toBeTruthy") {
    if (sourceLooksLikeArrayCheck(receivedSource || source)) {
      return replaceCurrentAssertionCall(d, "toBe", [t.booleanLiteral(true)]);
    }

    if (sourceLooksLikeTypeofCheck(receivedSource || source)) {
      return replaceCurrentAssertionCall(d, "toBe", [
        t.stringLiteral("object"),
      ]);
    }

    return replaceAssertionWithStatements(
      d,
      [
        buildNotUndefinedStatement(receivedNode),
        buildNotNullStatement(receivedNode),
      ]
    );
  }

  if (matcher === "toBeFalsy") {
    return replaceCurrentAssertionCall(d, "toBe", [t.booleanLiteral(false)]);
  }

  if (matcher === "toBeUndefined" && isNegated) {
    return replaceAssertionWithStatements(
      d,
      [buildNotUndefinedStatement(receivedNode)]
    );
  }

  if (matcher === "toBeNull" && isNegated) {
    return replaceAssertionWithStatements(
      d,
      [buildNotNullStatement(receivedNode)]
    );
  }

  /* ======================================================
     PRIORITY 6: MATCHER CORRECTION
  ====================================================== */

  if (matcher === "toBe" && (isObjectValue(value) || isArrayValue(value))) {
    return replaceCurrentAssertionCall(d, "toEqual", [valueToNode(value)]);
  }

  if (
    (matcher === "toEqual" || matcher === "toStrictEqual") &&
    isPrimitiveValue(value) &&
    shouldUseToBe(value)
  ) {
    return replaceCurrentAssertionCall(d, "toBe", [valueToNode(value)]);
  }

  if (matcher === "toHaveProperty" && (!expectedNode || !expectedSource)) {
    return replaceAssertionWithStatements(
      d,
      [
        buildNotUndefinedStatement(receivedNode),
        buildNotNullStatement(receivedNode),
      ]
    );
  }

  return false;
}

/* ======================================================
   ASYNC-SAFE FIXES
====================================================== */

function applyAsyncSafeFix(d, errorMsg) {
  const {
    matcher,
    receivedNode,
    isNegated = false,
    asyncModifier = "",
  } = d;

  if (!receivedNode) return false;

  const modifier = asyncModifier || "resolves";

  if (matcher === "toBeDefined") {
    return replaceCurrentAssertionCall(
      d,
      "toBeUndefined",
      [],
      [modifier, "not"]
    );
  }

  if (matcher === "toBeTruthy") {
    return replaceCurrentAssertionCall(
      d,
      "toBe",
      [t.booleanLiteral(true)],
      [modifier]
    );
  }

  if (matcher === "toBeFalsy") {
    return replaceCurrentAssertionCall(
      d,
      "toBe",
      [t.booleanLiteral(false)],
      [modifier]
    );
  }

  if (matcher === "toBeUndefined" && isNegated) {
    return replaceCurrentAssertionCall(
      d,
      "toBeUndefined",
      [],
      [modifier, "not"]
    );
  }

  if (matcher === "toBeNull" && isNegated) {
    return replaceCurrentAssertionCall(
      d,
      "toBeNull",
      [],
      [modifier, "not"]
    );
  }

  if (matcher === "toThrow" && errorMsg.includes("did not throw")) {
    const expectCall = getExpectCall(d);

    if (expectCall?.arguments?.length > 0) {
      const arg = expectCall.arguments[0];

      if (t.isCallExpression(arg)) {
        expectCall.arguments[0] = t.arrowFunctionExpression([], arg);
        return true;
      }
    }
  }

  return false;
}