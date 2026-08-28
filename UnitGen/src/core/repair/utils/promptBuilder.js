// src/core/repair/utils/promptBuilder.js

/* ======================================================
   SAFE TEXT HELPERS
====================================================== */

function safeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeWhitespaceOneLine(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatList(items = []) {
  return Array.isArray(items) && items.length > 0
    ? items.filter(Boolean).join(", ")
    : "(none)";
}

/* ======================================================
   FAILURE HISTORY
====================================================== */

function buildHistoryText(history = []) {
  if (!Array.isArray(history) || history.length === 0) {
    return "No previous attempts.";
  }

  return history
    .map((h) => {
      const attempt = h?.attempt ?? "?";
      const testName = h?.testName || "unknown test";
      const strategy = h?.strategy || "repair";
      const message = normalizeWhitespaceOneLine(h?.message || "");

      return `Attempt ${attempt} via ${strategy}: [${testName}] ${message}`;
    })
    .join("\n");
}

/* ======================================================
   MOCK HANDLING
====================================================== */

function buildMockContext({ jestMocks, mockEntries }) {
  if (jestMocks && String(jestMocks).trim()) {
    return `
MOCK SETUP PRESENT IN TEST FILE — DO NOT MODIFY OR REMOVE:
${jestMocks}
    `.trim();
  }

  if (Array.isArray(mockEntries) && mockEntries.length > 0) {
    return mockEntries
      .map((entry) => {
        const mod = entry?.module || entry?.source || "unknown-module";

        if (mod === "fs") {
          return "- fs is mocked; do not use real file-system access.";
        }

        if (mod === "path") {
          return "- path is mocked; do not rely on real machine-specific paths.";
        }

        if (mod === "axios" || mod === "node-fetch" || mod === "fetch") {
          return `- ${mod} is mocked; do not use real network access.`;
        }

        return `- ${mod} is mocked; use only existing mock setup.`;
      })
      .join("\n");
  }

  return "No external dependencies are used, or no mock metadata was provided.";
}

/* ======================================================
   FAILURE FORMATTER
====================================================== */

function formatFailures(failures = []) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return "No failure details provided.";
  }

  return failures
    .map((f, index) => {
      const testName = f?.testName || `failure-${index + 1}`;
      const type = f?.failureType || f?.errorType || "UNKNOWN_FAILURE";
      const evidence = f?.evidence || {};
      const message = safeText(f?.errorMessage || f?.message || f?.stack, "");

      const location = evidence?.stackLocation
        ? `${evidence.stackLocation.filePath || ""}:${evidence.stackLocation.line || 0}:${evidence.stackLocation.column || 0}`
        : "";

      const facts = [
        `Failure ${index + 1}`,
        `Test: ${testName}`,
        `Type: ${type}`,
        evidence?.matcher ? `Matcher: ${evidence.matcher}` : "",
        evidence?.expectedRaw ? `Expected (Jest): ${evidence.expectedRaw}` : "",
        evidence?.receivedRaw ? `Received (Jest): ${evidence.receivedRaw}` : "",
        evidence?.receivedType ? `Observed type: ${evidence.receivedType}` : "",
        evidence?.fsCode ? `Filesystem code: ${evidence.fsCode}` : "",
        evidence?.promiseResolvedInsteadOfRejected
          ? "Promise evidence: resolved while the test expected rejection"
          : "",
        evidence?.promiseRejectedInsteadOfResolved
          ? "Promise evidence: rejected while the test expected resolution"
          : "",
        evidence?.receivedMustBePromise
          ? "Matcher evidence: received value was not a Promise"
          : "",
        evidence?.receivedMustBeFunction
          ? "Matcher evidence: toThrow/toThrowError did not receive a function"
          : "",
        evidence?.didNotThrow
          ? "Throw evidence: the received function did not throw"
          : "",
        evidence?.timeout ? "Runtime evidence: test timed out" : "",
        location ? `Failure location: ${location}` : "",
        `Message:\n${message || "No message available."}`,
      ];

      return facts.filter(Boolean).join("\n");
    })
    .join("\n\n");
}

/* ======================================================
   IDENTIFIER RULES
====================================================== */

function buildAllowedIdentifierText({ allowedIdentifiers, context }) {
  const identifiers = new Set();

  if (Array.isArray(allowedIdentifiers)) {
    for (const id of allowedIdentifiers) {
      if (id) identifiers.add(id);
    }
  } else if (allowedIdentifiers instanceof Set) {
    for (const id of allowedIdentifiers) {
      if (id) identifiers.add(id);
    }
  }

  if (context?.fnName) identifiers.add(context.fnName);
  if (context?.displayName) identifiers.add(context.displayName);
  if (context?.fullName) identifiers.add(context.fullName);
  if (context?.ownerClassName) identifiers.add(context.ownerClassName);
  if (context?.methodName) identifiers.add(context.methodName);

  identifiers.add("result");
  identifiers.add("instance");
  identifiers.add("expect");
  identifiers.add("jest");
  identifiers.add("Array");
  identifiers.add("Object");
  identifiers.add("Math");
  identifiers.add("Number");
  identifiers.add("String");
  identifiers.add("Boolean");
  identifiers.add("Date");
  identifiers.add("Promise");
  identifiers.add("JSON");

  return Array.from(identifiers).filter(Boolean).sort().join(", ");
}

/* ======================================================
   CONTEXT HELPERS
====================================================== */

function buildTargetName(context = {}) {
  if (context.isClassMethod && context.ownerClassName && context.methodName) {
    if (context.methodKind === "static") {
      return `${context.ownerClassName}.${context.methodName}`;
    }

    if (context.methodKind === "constructor") {
      return context.ownerClassName;
    }

    return `${context.ownerClassName}.${context.methodName}`;
  }

  return context.displayName || context.fullName || context.fnName || "functionUnderTest";
}

function buildActExample(context = {}) {
  const fnName = context.fnName || "functionUnderTest";

  if (context.isClassMethod && context.ownerClassName && context.methodName) {
    if (context.methodKind === "static") {
      return `${context.isAsync ? "const result = await " : "const result = "}${context.ownerClassName}.${context.methodName}(...);`;
    }

    if (context.methodKind === "constructor") {
      return `const result = new ${context.ownerClassName}(...);`;
    }

    return `${context.isAsync ? "const result = await " : "const result = "}instance.${context.methodName}(...);`;
  }

  return `${context.isAsync ? "const result = await " : "const result = "}${fnName}(...);`;
}

/* ======================================================
   MAIN REPAIR PROMPT
====================================================== */

export function buildRepairPrompt({
  originalCode,
  failures,
  context,
  attempt,
  history = [],
  allowedIdentifiers = [],
}) {
  const {
    fnName,
    isAsync,
    functionCode,
    sourceCode,
    code,
    jestMocks,
    mockEntries,
    ownerClassName,
    methodName,
    methodKind,
    params,
    isClassLike,
    isClassMethod,
    constructorParams,
    docs,
    usageSnippets,
    repairFallbackContext,
  } = context || {};

  const targetName = buildTargetName(context || {});
  const historyText = buildHistoryText(history);
  const mockContext = buildMockContext({ jestMocks, mockEntries });
  const failureDetails = formatFailures(failures);
  const allowedIdentifierText = buildAllowedIdentifierText({
    allowedIdentifiers,
    context,
  });

  const sourceContext =
    functionCode ||
    sourceCode ||
    code ||
    "N/A";

  const documentationContext = [
    safeText(docs, ""),
    ...(Array.isArray(usageSnippets) ? usageSnippets.map((x) => safeText(x, "")) : []),
  ]
    .filter(Boolean)
    .join("\n\n");

  return `
You are the final repair stage of UnitGen, a JavaScript/Jest automated unit-test generator.

Your task is NOT to make a test green by weakening it. Your task is to repair the
failing test so that it expresses observable behavior supported by runtime evidence,
the source/usage context, and the test's original intent.

Return ONLY repaired test-case fragments as JSON. UnitGen will transactionally insert
the fragments, run the repaired file in isolation, and then run the complete suite.
A repair is discarded unless execution proves a real failure reduction with no
regression of previously passing tests.

--------------------------------------------------
TARGET UNDER TEST
--------------------------------------------------
Target: ${targetName}
Function name: ${fnName || "(unknown/test-derived context)"}
Async hint: ${isAsync ? "yes" : "no/unknown"}
Parameters: ${formatList(params || [])}
Class-like target: ${isClassLike ? "yes" : "no/unknown"}
Class method: ${isClassMethod ? "yes" : "no/unknown"}
Owner class: ${ownerClassName || "(none/unknown)"}
Method name: ${methodName || "(none/unknown)"}
Method kind: ${methodKind || "(function/unknown)"}
Constructor parameters: ${formatList(constructorParams || [])}
Repair attempt: ${attempt}
Context source: ${repairFallbackContext ? "generated test fallback context" : "generation context"}

--------------------------------------------------
AVAILABLE IDENTIFIERS YOU MAY USE
--------------------------------------------------
${allowedIdentifierText || "(none provided)"}

You may use:
- identifiers listed above;
- local variables/functions that you declare INSIDE this repaired test case;
- JavaScript/Jest globals already available in the current test environment.

You may NOT invent imports, modules, top-level mocks, external services, or identifiers
that are unavailable in the current generated test file.

--------------------------------------------------
CURRENT GENERATED TEST FILE
--------------------------------------------------
${originalCode || "(not available)"}

--------------------------------------------------
STRUCTURED JEST FAILURE EVIDENCE
--------------------------------------------------
${failureDetails}

--------------------------------------------------
PREVIOUS REJECTED/FAILED REPAIR HISTORY
--------------------------------------------------
${historyText}

--------------------------------------------------
SOURCE / IMPLEMENTATION CONTEXT WHEN AVAILABLE
--------------------------------------------------
${sourceContext}

--------------------------------------------------
DOCUMENTATION / USAGE CONTEXT WHEN AVAILABLE
--------------------------------------------------
${documentationContext || "N/A"}

--------------------------------------------------
EXISTING MOCK ENVIRONMENT
--------------------------------------------------
${mockContext}

--------------------------------------------------
REPAIR CONTRACT
--------------------------------------------------

1. Preserve intent
   - Repair ONLY a currently failing test.
   - Keep its original behavioral purpose whenever evidence permits.
   - Never delete the meaningful behavior under test just to obtain a pass.
   - Never change a passing test in this response.

2. Evidence hierarchy
   Use evidence in this order:
   a) concrete Jest Expected/Received/runtime evidence;
   b) deterministic source semantics and explicit branches;
   c) provided docs/usage snippets;
   d) existing test setup and public API contract.
   If those sources do not justify an exact value, do NOT invent one.

3. Assertions
   - Assert observable package behavior, return value, state transition, thrown error,
     callback result, or Promise settlement.
   - Do not return an assertion whose only purpose is mock call bookkeeping.
   - Do not replace a meaningful exact oracle with only toBeDefined()/toBeTruthy()
     just to make the test pass.
   - Exact primitive/array/object expectations are preferred when runtime/source
     evidence makes them deterministic.
   - Use toMatchObject/toHaveProperty/toContain/toHaveLength/range/type invariants
     only when they are the strongest truthful contract supported by evidence.
   - Preserve .not/.resolves/.rejects semantics unless Jest evidence proves the
     existing direction is wrong and the test's behavioral intent supports changing it.

4. Act/setup flexibility
   - "arrange" may contain multiple TEST-LOCAL setup lines and local helper callbacks.
   - "act" may contain zero or one "const result = ..." declaration.
   - A direct throw/rejection assertion may legitimately have no result variable.
   - Callback/stateful tests may act through a local callback or state variable.
   - Do not move imports, mocks, describe/test declarations, or lifecycle hooks into
     arrange/act/assert.

5. Throw and Promise repair
   - Sync throw: expect(() => target(...)).toThrow(...)
   - Async rejection: await expect(target(...)).rejects.toThrow(...)
   - Async resolution: await expect(target(...)).resolves....
   - Never use .rejects/.resolves on an already-awaited non-Promise value.
   - Never use toThrow on the result of an already-executed call.

6. Receiver/call-shape repair
   - Do not call prototype methods as static methods.
   - If the existing file/source proves a constructor/receiver is required, create
     that receiver inside arrange using identifiers already available.
   - Do not invent constructor arguments or helper objects without evidence.

7. Filesystem/stateful repair
   - Reuse fs/path/os identifiers only when they already exist in the file/context.
   - Prefer unique temporary fixtures and explicit cleanup when those APIs are
     already available.
   - Do not write fixed project-root fixture names.
   - No network, database, process.exit, long sleep, nondeterministic randomness,
     or destructive external side effects.

8. Safety
   - No import/export/require.
   - No describe/test/it wrappers.
   - No beforeEach/afterEach/beforeAll/afterAll.
   - No new jest.mock/jest.unstable_mockModule/sinon/vi.mock.
   - Do not remove or rewrite the file's existing top-level mocks.
   - Do not reference undeclared raw parameter names.
   - Keep each repair concise and local to one failed test.

9. When a truthful repair cannot be inferred
   - Do not fabricate a passing oracle.
   - Return [] rather than guessing.

--------------------------------------------------
OUTPUT FORMAT
--------------------------------------------------

<JSON>
[
  {
    "title": "same failing test title or a clearer equivalent",
    "arrange": "test-local deterministic setup; may be empty",
    "act": "zero or one result-producing/action statement(s) supported by the original test",
    "assert": "one or more meaningful Jest assertions over observable behavior"
  }
]
</JSON>

Return only the JSON block.
`.trim();
}

/* ======================================================
   HELPER: Extract Assertion Line
====================================================== */

export function extractAssertionLine(msg) {
  if (!msg) return "Unknown assertion";

  const lines = String(msg || "").split("\n");

  for (const line of lines) {
    if (line.includes("expect(")) return line.trim();
  }

  return "Unknown assertion";
}