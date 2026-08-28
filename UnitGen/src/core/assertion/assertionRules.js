// src/core/assertion/assertionRules.js

/* ======================================================
   WEAK / RISKY MATCHERS
====================================================== */

const WEAK_MATCHERS = new Set([
  "toBeDefined",
  "toBeTruthy",
  "toBeFalsy",
]);

const EXISTENCE_MATCHERS = new Set([
  "toBeDefined",
  "toBeUndefined",
  "toBeNull",
]);

const RANGE_MATCHERS = new Set([
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
]);

const MOCK_MATCHERS = new Set([
  "toHaveBeenCalled",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
]);

const PROPERTY_OR_VALUE_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toHaveProperty",
  "toMatchObject",
  "toContain",
  "toContainEqual",
  "toHaveLength",
  "toMatch",
]);

/* ======================================================
   STRONG MATCHERS
====================================================== */

const STRONG_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toBeCloseTo",
  "toContain",
  "toContainEqual",
  "toMatch",
  "toThrow",
  "toThrowError",
  "toHaveProperty",
  "toMatchObject",
  "toHaveLength",
  "toBeInstanceOf",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
]);

/* ======================================================
   HELPERS
====================================================== */

function isPrimitive(val) {
  return (
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "boolean"
  );
}

function isObject(val) {
  return (
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val)
  );
}

function isArray(val) {
  return Array.isArray(val);
}

function getLiteralSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 9999;
  }
}

function isEmptyObject(value) {
  return isObject(value) && Object.keys(value).length === 0;
}

function isEmptyArray(value) {
  return isArray(value) && value.length === 0;
}

function isLargeObjectOrArray(value) {
  if (!isObject(value) && !isArray(value)) return false;
  return getLiteralSize(value) > 260;
}

function isDeepObjectOrArray(value, depth = 0) {
  if (depth > 3) return true;

  if (Array.isArray(value)) {
    return value.some((item) => isDeepObjectOrArray(item, depth + 1));
  }

  if (isObject(value)) {
    return Object.values(value).some((item) =>
      isDeepObjectOrArray(item, depth + 1)
    );
  }

  return false;
}

function sourceLooksLikeFullResult(source = "") {
  return /expect\s*\(\s*result\s*\)/.test(String(source || ""));
}

function sourceLooksLikeArrayCheck(receivedSource = "", source = "") {
  return (
    /Array\.isArray\s*\(/.test(String(receivedSource || "")) ||
    /Array\.isArray\s*\(/.test(String(source || ""))
  );
}

function sourceLooksLikeTypeofCheck(receivedSource = "", source = "") {
  return (
    /^typeof\s+/.test(String(receivedSource || "").trim()) ||
    /expect\s*\(\s*typeof\s+/.test(String(source || ""))
  );
}

function sourceLooksLikeLengthCheck(receivedSource = "", source = "") {
  return (
    /\.length$/.test(String(receivedSource || "").trim()) ||
    /expect\s*\([^)]*\.length\s*\)/.test(String(source || ""))
  );
}

function sourceLooksLikeBroadBoolean(source = "") {
  const s = String(source || "");
  return (
    /Array\.isArray\s*\([^)]*\)\s*\|\|/.test(s) ||
    /typeof\s+[^=]+===?\s*["']object["']/.test(s) ||
    /==\s*null\s*\|\|/.test(s) ||
    /\|\|/.test(s)
  );
}

function expectedLooksGenericConstructor(expectedSource = "") {
  const s = String(expectedSource || "").trim();
  return ["Object", "Array", "Function", "String", "Number", "Boolean"].includes(s);
}

function matcherNeedsExpectedValue(matcher) {
  return [
    "toBe",
    "toEqual",
    "toStrictEqual",
    "toBeCloseTo",
    "toContain",
    "toContainEqual",
    "toMatch",
    "toHaveProperty",
    "toMatchObject",
    "toHaveLength",
    "toBeInstanceOf",
    ...RANGE_MATCHERS,
  ].includes(matcher);
}

function isBooleanLiteralTrue(value, expectedSource = "") {
  return value === true || String(expectedSource || "").trim() === "true";
}

function isBooleanLiteralFalse(value, expectedSource = "") {
  return value === false || String(expectedSource || "").trim() === "false";
}

function isNumericLiteral(value, expectedSource = "") {
  if (typeof value === "number") return true;
  return /^-?\d+(\.\d+)?$/.test(String(expectedSource || "").trim());
}

function hasSiblingAssertions({
  assertionCountInTest = 0,
  hasSiblingAssertions = false,
  siblingMatchers = [],
}) {
  return (
    hasSiblingAssertions ||
    assertionCountInTest > 1 ||
    (Array.isArray(siblingMatchers) && siblingMatchers.length > 0)
  );
}

function hasSiblingPropertyOrValueAssertion(siblingMatchers = []) {
  if (!Array.isArray(siblingMatchers)) return false;

  return siblingMatchers.some((matcher) =>
    PROPERTY_OR_VALUE_MATCHERS.has(matcher)
  );
}

function isStructuralInvariant({
  matcher,
  value,
  receivedSource = "",
  expectedSource = "",
  source = "",
}) {
  if (
    matcher === "toBe" &&
    sourceLooksLikeArrayCheck(receivedSource, source) &&
    isBooleanLiteralTrue(value, expectedSource)
  ) {
    return true;
  }

  if (
    matcher === "toBe" &&
    sourceLooksLikeTypeofCheck(receivedSource, source) &&
    typeof value === "string"
  ) {
    return true;
  }

  if (
    RANGE_MATCHERS.has(matcher) &&
    sourceLooksLikeLengthCheck(receivedSource, source)
  ) {
    return true;
  }

  if (matcher === "toHaveLength") {
    return true;
  }

  return false;
}

function isBroadBooleanAssertion({
  matcher,
  value,
  expectedSource = "",
  source = "",
}) {
  return (
    matcher === "toBe" &&
    isBooleanLiteralTrue(value, expectedSource) &&
    sourceLooksLikeBroadBoolean(source)
  );
}

/* ======================================================
   RULE 1 — IS WEAK MATCHER
====================================================== */

export function isWeakMatcher(matcher) {
  return WEAK_MATCHERS.has(matcher);
}

/* ======================================================
   RULE 2 — IS STRONG MATCHER
====================================================== */

export function isStrongMatcher(matcher) {
  return STRONG_MATCHERS.has(matcher);
}

/* ======================================================
   RULE 3 — SHOULD USE toEqual
====================================================== */

export function shouldUseToEqual(value) {
  return typeof value === "object" && value !== null;
}

/* ======================================================
   RULE 4 — SHOULD USE toBe
====================================================== */

export function shouldUseToBe(value) {
  return isPrimitive(value);
}

/* ======================================================
   RULE 5 — DANGEROUS CONTEXT
====================================================== */

export function isDangerousContext(errorMsg = "") {
  const msg = String(errorMsg || "").toLowerCase();

  const isRuntimeCrash =
    msg.includes("syntaxerror") ||
    msg.includes("unexpected token") ||
    msg.includes("cannot find module") ||
    msg.includes("module not found");

  return isRuntimeCrash;
}

/* ======================================================
   RULE 6 — INVALID ASSERTION
====================================================== */

export function isInvalidAssertion({
  matcher,
  value,
  expectedNode,
  expectedSource = "",
  isAsyncChain = false,
}) {
  if (!matcher) return true;

  if (matcher === "resolves" || matcher === "rejects") {
    return false;
  }

  if (matcherNeedsExpectedValue(matcher) && value === undefined && !expectedNode) {
    return true;
  }

  if (matcher === "toBe" && (isObject(value) || isArray(value))) {
    return true;
  }

  if (matcher === "toEqual" && isPrimitive(value)) {
    return true;
  }

  if (matcher === "toStrictEqual" && isPrimitive(value)) {
    return true;
  }

  if (matcher === "toHaveProperty" && value === undefined && !expectedSource) {
    return true;
  }

  if (
    matcher === "toBeCloseTo" &&
    value !== undefined &&
    !isNumericLiteral(value, expectedSource)
  ) {
    return true;
  }

  if (
    RANGE_MATCHERS.has(matcher) &&
    value !== undefined &&
    !isNumericLiteral(value, expectedSource)
  ) {
    return true;
  }

  if (isAsyncChain && ["toBeDefined", "toBeTruthy", "toBeFalsy"].includes(matcher)) {
    return false;
  }

  return false;
}

/* ======================================================
   RISK CLASSIFICATION HELPERS
====================================================== */

export function getAssertionRiskCategory({
  matcher,
  value,
  receivedSource = "",
  expectedSource = "",
  source = "",
  isNegated = false,
  isAsyncChain = false,
  assertionCountInTest = 0,
  hasSiblingAssertions: hasSiblings = false,
  siblingMatchers = [],
  isOnlyAssertionInTest = false,
}) {
  if (!matcher) return "INVALID_ASSERTION";

  const hasSiblingsNow = hasSiblingAssertions({
    assertionCountInTest,
    hasSiblingAssertions: hasSiblings,
    siblingMatchers,
  });

  const hasPropertySibling = hasSiblingPropertyOrValueAssertion(siblingMatchers);

  if (isBroadBooleanAssertion({ matcher, value, expectedSource, source })) {
    return "BROAD_BOOLEAN_ASSERTION";
  }

  if (WEAK_MATCHERS.has(matcher)) {
    return "WEAK_EXISTENCE_ASSERTION";
  }

  if (
    isNegated &&
    EXISTENCE_MATCHERS.has(matcher) &&
    sourceLooksLikeFullResult(source) &&
    isOnlyAssertionInTest
  ) {
    return "WEAK_EXISTENCE_ASSERTION";
  }

  if (
    (matcher === "toBeUndefined" || matcher === "toBeNull") &&
    isOnlyAssertionInTest
  ) {
    return "WEAK_EXISTENCE_ASSERTION";
  }

  if (
    isStructuralInvariant({
      matcher,
      value,
      receivedSource,
      expectedSource,
      source,
    })
  ) {
    if (isOnlyAssertionInTest || !hasSiblingsNow) {
      return "WEAK_TYPE_ASSERTION";
    }

    if (hasPropertySibling) {
      return "";
    }

    return "ADEQUATE_INVARIANT";
  }

  if (
    matcher === "toBeInstanceOf" &&
    expectedLooksGenericConstructor(expectedSource)
  ) {
    if (isOnlyAssertionInTest) {
      return "GENERIC_INSTANCE_ASSERTION";
    }

    return "ADEQUATE_INVARIANT";
  }

  if (
    (matcher === "toEqual" || matcher === "toStrictEqual") &&
    isEmptyObject(value)
  ) {
    return "EMPTY_COLLECTION_ASSERTION";
  }

  if (
    (matcher === "toEqual" || matcher === "toStrictEqual") &&
    isEmptyArray(value)
  ) {
    return "EMPTY_COLLECTION_ASSERTION";
  }

  if (
    (matcher === "toEqual" || matcher === "toStrictEqual") &&
    (isLargeObjectOrArray(value) || isDeepObjectOrArray(value)) &&
    sourceLooksLikeFullResult(source)
  ) {
    return "BRITTLE_DEEP_EQUALITY";
  }

  if (
    matcher === "toBeCloseTo" &&
    sourceLooksLikeFullResult(source) &&
    isNumericLiteral(value, expectedSource)
  ) {
    return "BRITTLE_NUMERIC_ORACLE";
  }

  if (MOCK_MATCHERS.has(matcher)) {
    if (hasSiblingsNow) {
      return "ADEQUATE_INVARIANT";
    }

    return "MOCK_ONLY_ASSERTION";
  }

  if (
    isAsyncChain &&
    ["toBeDefined", "toBeTruthy", "toBeFalsy"].includes(matcher)
  ) {
    return "WEAK_EXISTENCE_ASSERTION";
  }

  return "";
}

/* ======================================================
   RULE 7 — MEANINGLESS / WEAK ASSERTION
====================================================== */

export function isMeaninglessAssertion({
  matcher,
  value,
  receivedSource = "",
  expectedSource = "",
  source = "",
  isNegated = false,
  isAsyncChain = false,
  assertionCountInTest = 0,
  hasSiblingAssertions = false,
  siblingMatchers = [],
  isOnlyAssertionInTest = false,
}) {
  const category = getAssertionRiskCategory({
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

  return Boolean(category && category !== "ADEQUATE_INVARIANT");
}

/* ======================================================
   RULE 8 — STRONG ASSERTION CHECK
====================================================== */

export function isStrongAssertion({
  matcher,
  value,
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
}) {
  if (!matcher) return false;

  if (!isStrongMatcher(matcher)) return false;

  if (
    isInvalidAssertion({
      matcher,
      value,
      expectedNode,
      expectedSource,
      isAsyncChain,
    })
  ) {
    return false;
  }

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

  if (riskCategory && riskCategory !== "ADEQUATE_INVARIANT") {
    return false;
  }

  return true;
}

/* ======================================================
   RULE 9 — CLASSIFY ASSERTION
====================================================== */

export function classifyAssertion({
  matcher,
  value,
  expectedNode,
  receivedNode,
  receivedSource = "",
  expectedSource = "",
  source = "",
  isNegated = false,
  isAsyncChain = false,
  assertionCountInTest = 0,
  hasSiblingAssertions = false,
  siblingMatchers = [],
  isOnlyAssertionInTest = false,
}) {
  if (!matcher) return "INVALID";

  if (
    isInvalidAssertion({
      matcher,
      value,
      expectedNode,
      receivedNode,
      expectedSource,
      isAsyncChain,
    })
  ) {
    return "INVALID";
  }

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
    return "STRONG";
  }

  if (riskCategory) {
    return "WEAK";
  }

  if (
    isStrongAssertion({
      matcher,
      value,
      expectedNode,
      receivedSource,
      expectedSource,
      source,
      isNegated,
      isAsyncChain,
      assertionCountInTest,
      hasSiblingAssertions,
      siblingMatchers,
      isOnlyAssertionInTest,
    })
  ) {
    return "STRONG";
  }

  return "WEAK";
}

/* ======================================================
   RULE 10 — ASYNC MISMATCH
====================================================== */

export function needsAsyncUpgrade(matcher, isAsync) {
  const asyncMatchers = ["toResolve", "toReject", "toThrowAsync"];
  return asyncMatchers.includes(matcher) && !isAsync;
}

/* ======================================================
   OPTIONAL EXPLANATION FOR LOGGING / FUTURE UI
====================================================== */

export function explainAssertionWeakness(assertion = {}) {
  const category = getAssertionRiskCategory(assertion);

  const explanations = {
    WEAK_EXISTENCE_ASSERTION:
      "Assertion only checks existence/truthiness/nullishness and may not validate behavior.",
    WEAK_TYPE_ASSERTION:
      "Assertion mostly checks type/shape alone and may not validate functional correctness.",
    WEAK_RANGE_ASSERTION:
      "Assertion checks a broad range or length condition alone and may be too shallow.",
    BRITTLE_DEEP_EQUALITY:
      "Assertion compares a large/deep expected object or array that may be fabricated or brittle.",
    BRITTLE_NUMERIC_ORACLE:
      "Assertion uses an exact guessed numeric oracle that may be unreliable.",
    EMPTY_COLLECTION_ASSERTION:
      "Assertion compares against an empty object or array and may miss behavior.",
    GENERIC_INSTANCE_ASSERTION:
      "Assertion checks only a generic constructor such as Object or Array.",
    MOCK_ONLY_ASSERTION:
      "Assertion only checks mock interaction and may not validate returned behavior.",
    BROAD_BOOLEAN_ASSERTION:
      "Assertion uses a broad boolean OR condition and should be replaced with focused result-shape assertions.",
    INVALID_ASSERTION:
      "Assertion is structurally invalid or missing required expected value.",
    ADEQUATE_INVARIANT:
      "Assertion is a structural invariant combined with other checks and is acceptable.",
  };

  return explanations[category] || "";
}