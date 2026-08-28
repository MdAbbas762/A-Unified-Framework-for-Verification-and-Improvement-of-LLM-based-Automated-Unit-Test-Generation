// src/core/repair/failureEvidence.js
//
// Structured, package-agnostic evidence extraction from Jest failure messages.
// This module intentionally has no package-specific rules and no dependencies
// outside Node/JavaScript so the repair system can reason from actual runtime
// evidence instead of guessed expectations.

function stripAnsi(text = "") {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function firstMatch(text, patterns = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  return null;
}

function parsePrimitiveOrJson(raw) {
  if (raw === undefined || raw === null) {
    return { known: false, value: undefined, raw: "" };
  }

  const text = String(raw).trim().replace(/,$/, "");

  if (!text) return { known: false, value: undefined, raw: text };
  if (text === "undefined") return { known: true, value: undefined, raw: text };
  if (text === "null") return { known: true, value: null, raw: text };
  if (text === "true") return { known: true, value: true, raw: text };
  if (text === "false") return { known: true, value: false, raw: text };
  if (text === "NaN") return { known: true, value: NaN, raw: text };
  if (text === "Infinity") return { known: true, value: Infinity, raw: text };
  if (text === "-Infinity") return { known: true, value: -Infinity, raw: text };

  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    const value = Number(text);
    return { known: Number.isFinite(value), value, raw: text };
  }

  // Jest usually prints strings with quotes. JSON.parse handles the common
  // escaped-string case safely.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("[") && text.endsWith("]")) ||
    (text.startsWith("{") && text.endsWith("}"))
  ) {
    try {
      return { known: true, value: JSON.parse(text), raw: text };
    } catch {
      // Continue with conservative string handling below.
    }
  }

  if (text.startsWith("'") && text.endsWith("'")) {
    return {
      known: true,
      value: text.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\"),
      raw: text,
    };
  }

  return { known: false, value: undefined, raw: text };
}

function extractMatcher(text = "") {
  const normalized = stripAnsi(text);
  const match = firstMatch(normalized, [
    /expect\(received\)\.(?:resolves\.|rejects\.|not\.)?([A-Za-z][A-Za-z0-9_]*)/i,
    /\b(toBe|toEqual|toStrictEqual|toBeCloseTo|toBeDefined|toBeUndefined|toBeNull|toBeTruthy|toBeFalsy|toContainEqual|toContain|toHaveProperty|toHaveLength|toMatchObject|toMatch|toBeInstanceOf|toBeGreaterThanOrEqual|toBeGreaterThan|toBeLessThanOrEqual|toBeLessThan|toThrowError|toThrow)\b/i,
  ]);
  return match?.[1] || "";
}

function extractExpectedReceived(text = "") {
  const clean = stripAnsi(text);

  const expectedMatch = firstMatch(clean, [
    /^\s*Expected(?: constructor)?:\s*(.+)$/im,
    /^\s*Expected value:\s*(.+)$/im,
  ]);
  const receivedMatch = firstMatch(clean, [
    /^\s*Received(?: value| has value)?:\s*(.+)$/im,
    /^\s*Received:\s*(.+)$/im,
  ]);

  const expectedRaw = expectedMatch?.[1]?.trim() || "";
  const receivedRaw = receivedMatch?.[1]?.trim() || "";

  return {
    expectedRaw,
    receivedRaw,
    expected: parsePrimitiveOrJson(expectedRaw),
    received: parsePrimitiveOrJson(receivedRaw),
  };
}

function extractFsCode(text = "") {
  const match = stripAnsi(text).match(
    /\b(EACCES|EPERM|ENOENT|EEXIST|ENOTDIR|EISDIR|EINVAL|ENOTEMPTY|EXDEV|EBADF|ELOOP|EROFS)\b/
  );
  return match?.[1] || "";
}

function extractStackLocation(text = "") {
  const clean = stripAnsi(text);
  const match = firstMatch(clean, [
    /\(([^()\n]+\.test\.[cm]?js):(\d+):(\d+)\)/,
    /\bat\s+([^()\n]+\.test\.[cm]?js):(\d+):(\d+)/,
  ]);

  if (!match) return null;

  return {
    filePath: match[1],
    line: Number(match[2] || 0),
    column: Number(match[3] || 0),
  };
}

function inferObservedType(receivedRaw = "", receivedValue) {
  const raw = String(receivedRaw || "").trim();

  if (raw === "undefined") return "undefined";
  if (raw === "null") return "null";
  if (/^(true|false)$/.test(raw)) return "boolean";
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return "number";
  if (/^["']/.test(raw)) return "string";
  if (/^\[/.test(raw)) return "array";
  if (/^\{/.test(raw)) return "object";

  if (receivedValue === undefined && raw === "undefined") return "undefined";
  if (receivedValue === null) return "null";
  if (Array.isArray(receivedValue)) return "array";
  if (receivedValue !== undefined) return typeof receivedValue;

  const typeMatch = raw.match(/^(?:\[)?([A-Z][A-Za-z]+)(?:\])?$/);
  return typeMatch ? typeMatch[1].toLowerCase() : "";
}

export function parseJestFailureEvidence(errorText = "") {
  const clean = stripAnsi(errorText);
  const lower = clean.toLowerCase();
  const values = extractExpectedReceived(clean);

  const promiseResolvedInsteadOfRejected =
    lower.includes("received promise resolved instead of rejected");
  const promiseRejectedInsteadOfResolved =
    lower.includes("received promise rejected instead of resolved");

  const receivedMustBePromise =
    lower.includes("received value must be a promise") ||
    lower.includes("received value must be a promise or a function returning a promise");

  const receivedMustBeFunction =
    lower.includes("received value must be a function");

  const didNotThrow =
    lower.includes("received function did not throw") ||
    lower.includes("function did not throw");

  const timeout =
    lower.includes("exceeded timeout") ||
    lower.includes("timeout") ||
    lower.includes("async callback was not invoked");

  const matcher = extractMatcher(clean);

  return {
    raw: clean,
    matcher,
    expectedRaw: values.expectedRaw,
    receivedRaw: values.receivedRaw,
    expectedKnown: values.expected.known,
    expectedValue: values.expected.value,
    receivedKnown: values.received.known,
    receivedValue: values.received.value,
    receivedType: inferObservedType(values.receivedRaw, values.received.value),
    fsCode: extractFsCode(clean),
    stackLocation: extractStackLocation(clean),
    promiseResolvedInsteadOfRejected,
    promiseRejectedInsteadOfResolved,
    receivedMustBePromise,
    receivedMustBeFunction,
    didNotThrow,
    timeout,
    isAssertion:
      Boolean(matcher) ||
      lower.includes("expect(received)") ||
      lower.includes("assertionerror") ||
      (lower.includes("expected:") && lower.includes("received:")),
    isTypeError:
      lower.includes("typeerror") ||
      lower.includes("is not a function") ||
      lower.includes("cannot read properties of"),
    isReferenceError:
      lower.includes("referenceerror") || lower.includes("is not defined"),
    isSyntaxError:
      lower.includes("syntaxerror") || lower.includes("unexpected token"),
  };
}

export function stableValueFingerprint(value) {
  function normalize(input, depth = 0) {
    if (depth > 4) return "[MaxDepth]";
    if (input === undefined) return "[undefined]";
    if (typeof input === "number" && Number.isNaN(input)) return "[NaN]";
    if (input === Infinity) return "[Infinity]";
    if (input === -Infinity) return "[-Infinity]";
    if (input === null || typeof input !== "object") return input;

    if (Array.isArray(input)) {
      return input.slice(0, 20).map((item) => normalize(item, depth + 1));
    }

    const out = {};
    for (const key of Object.keys(input).sort().slice(0, 20)) {
      out[key] = normalize(input[key], depth + 1);
    }
    return out;
  }

  try {
    return JSON.stringify(normalize(value));
  } catch {
    return String(value);
  }
}
