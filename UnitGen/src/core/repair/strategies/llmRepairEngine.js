import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";

import { callLLM } from "../utils/llmClient.js";
import { buildRepairPrompt } from "../utils/promptBuilder.js";
import { validateSyntax } from "../../validation/validateSyntax.js";

const traverse = traverseModule.default;
const generate = generatorModule.default;

/* ======================================================
   BASIC HELPERS
====================================================== */
function asText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function stripMarkdownCodeFences(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n/, "");
  s = s.replace(/\n```$/, "");
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
  s = s.replace(/```$/g, "");
  return s.trim();
}

function extractJSON(text) {
  if (!text || typeof text !== "string") return null;

  const cleaned = stripMarkdownCodeFences(text);

  const tagMatch = cleaned.match(/<JSON>([\s\S]*?)<\/JSON>/i);
  if (tagMatch) return tagMatch[1].trim();

  const openTagMatch = cleaned.match(/<JSON>([\s\S]*)/i);
  if (openTagMatch) return openTagMatch[1].trim();

  const arrayMatch = cleaned.match(/\[\s*{[\s\S]*}\s*\]/);
  if (arrayMatch) {
    console.log("ℹ️ Extraction fallback used.");
    return arrayMatch[0].trim();
  }

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");

  if (start !== -1 && end !== -1 && end > start) {
    console.log("ℹ️ Extraction deep fallback used.");
    return cleaned.slice(start, end + 1).trim();
  }

  return null;
}

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
  if (!ast.program.body.length) return null;
  return ast.program.body[0];
}

/* ======================================================
   IDENTIFIER / REFERENCE SAFETY
====================================================== */
const ALLOWED_GLOBALS = new Set([
  "expect",
  "jest",
  "Array",
  "Object",
  "JSON",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Promise",
  "Set",
  "Map",
  "WeakMap",
  "WeakSet",
  "URL",
  "URLSearchParams",
  "Buffer",
  "console",
  "undefined",
  "null",
  "NaN",
  "Infinity",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
]);

function extractDeclaredVariables(code) {
  const declared = new Set();

  if (!code || !String(code).trim()) return declared;

  try {
    const wrapped = `
      function __unitgen_decl_scope__() {
        ${code}
      }
    `;

    const ast = parseModule(wrapped);

    traverse(ast, {
      VariableDeclarator(path) {
        const id = path.node.id;

        if (id?.type === "Identifier") {
          declared.add(id.name);
        }

        if (id?.type === "ObjectPattern") {
          for (const prop of id.properties || []) {
            if (prop?.value?.type === "Identifier") {
              declared.add(prop.value.name);
            }
          }
        }

        if (id?.type === "ArrayPattern") {
          for (const element of id.elements || []) {
            if (element?.type === "Identifier") {
              declared.add(element.name);
            }
          }
        }
      },
      FunctionDeclaration(path) {
        if (path.node.id?.name) declared.add(path.node.id.name);
      },
      FunctionExpression(path) {
        if (path.node.id?.name) declared.add(path.node.id.name);
      },
      CatchClause(path) {
        if (path.node.param?.type === "Identifier") {
          declared.add(path.node.param.name);
        }
      },
    });
  } catch {
    // Caller will reject malformed code later.
  }

  return declared;
}

function collectReferencedIdentifiers(code) {
  const referenced = new Set();

  if (!code || !String(code).trim()) return referenced;

  try {
    const wrapped = `
      function __unitgen_ref_scope__() {
        ${code}
      }
    `;

    const ast = parseModule(wrapped);

    traverse(ast, {
      ReferencedIdentifier(path) {
        referenced.add(path.node.name);
      },
    });
  } catch {
    // Caller will reject malformed code later.
  }

  return referenced;
}

function extractTopLevelAvailableIdentifiers(originalCode = "") {
  const allowed = new Set();

  try {
    const ast = parseModule(originalCode);

    for (const statement of ast.program.body || []) {
      if (statement.type === "ImportDeclaration") {
        for (const specifier of statement.specifiers || []) {
          if (specifier.local?.name) allowed.add(specifier.local.name);
        }
        continue;
      }

      if (statement.type === "VariableDeclaration") {
        for (const declaration of statement.declarations || []) {
          addPatternIdentifiers(declaration.id, allowed);
        }
        continue;
      }

      if (
        (statement.type === "FunctionDeclaration" ||
          statement.type === "ClassDeclaration") &&
        statement.id?.name
      ) {
        allowed.add(statement.id.name);
      }
    }
  } catch {
    // Fallback globals/context identifiers are added separately.
  }

  return allowed;
}

function buildAllowedIdentifiers({ originalCode, ctx }) {
  const allowed = extractTopLevelAvailableIdentifiers(originalCode);

  for (const name of ALLOWED_GLOBALS) allowed.add(name);

  if (ctx?.fnName) allowed.add(ctx.fnName);
  if (ctx?.displayName) allowed.add(ctx.displayName);
  if (ctx?.fullName) allowed.add(ctx.fullName);
  if (ctx?.ownerClassName) allowed.add(ctx.ownerClassName);
  if (ctx?.methodName) allowed.add(ctx.methodName);

  allowed.add("result");
  allowed.add("instance");

  return allowed;
}

function hasUndeclaredRepairReferences({
  arrange,
  act,
  assert,
  allowedIdentifiers,
}) {
  const declared = extractDeclaredVariables(arrange);
  const referenced = collectReferencedIdentifiers(`${arrange}\n${act}\n${assert}`);

  const allowed = new Set([
    ...Array.from(allowedIdentifiers || []),
    ...Array.from(declared),
  ]);

  for (const name of referenced) {
    if (allowed.has(name)) continue;
    return true;
  }

  return false;
}

/* ======================================================
   CASE VALIDATION HELPERS
====================================================== */
function normalizeCase(rawCase) {
  if (!rawCase || typeof rawCase !== "object") return null;

  const title = asText(rawCase.title, "").trim();
  const arrange = asText(rawCase.arrange, "").trim();
  const act = asText(rawCase.act, "").trim();
  const assert = asText(rawCase.assert, "").trim();

  if (!title || !assert) return null;

  // A repair may legitimately assert a throw/rejection directly in "assert"
  // and therefore need no separate act statement.
  return { title, arrange, act, assert };
}

function containsForbiddenTopLevelConstructs(text) {
  const s = String(text || "");

  const forbidden = [
    /\bimport\s.+from\s.+/i,
    /\bexport\s+(default|const|function|class)\b/i,
    /\brequire\s*\(/i,
    /\bdescribe\s*\(/i,
    /\bit\s*\(/i,
    /\btest\s*\(/i,
    /\bbeforeEach\s*\(/i,
    /\bafterEach\s*\(/i,
    /\bbeforeAll\s*\(/i,
    /\bafterAll\s*\(/i,
    /\bjest\.mock\s*\(/i,
    /\bjest\.unstable_mockModule\s*\(/i,
    /\bvi\.mock\s*\(/i,
    /\bsinon\./i,
  ];

  return forbidden.some((re) => re.test(s));
}

function countResultDeclarations(text) {
  return (String(text || "").match(/\bconst\s+result\s*=/g) || []).length;
}

function referencesUndeclaredFunctionParams({ arrange, assert, params }) {
  const paramNames = Array.isArray(params) ? params : [];
  if (paramNames.length === 0) return false;

  const declared = extractDeclaredVariables(arrange);
  const unsafeZones = `${arrange}\n${assert}`;

  for (const param of paramNames) {
    const name = String(param || "").trim();
    if (!name) continue;

    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(unsafeZones) && !declared.has(name)) {
      return true;
    }
  }

  return false;
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFunctionCall(fnName, act) {
  const safeName = escapeRegExp(fnName);
  const callRegex = new RegExp(`\\b${safeName}\\s*\\(([^)]*)\\)`, "m");
  const match = String(act || "").match(callRegex);

  if (!match) return null;

  const fullCall = match[0];
  const argsText = match[1].trim();

  let argCount = 0;
  if (argsText.length > 0) {
    argCount = argsText.split(",").map((s) => s.trim()).filter(Boolean).length;
  }

  return { fullCall, argCount };
}

function hasMissingRequiredArguments({ fnName, act, params }) {
  const expectedCount = Array.isArray(params) ? params.length : 0;

  if (!fnName) return false;

  const info = extractFunctionCall(fnName, act);
  if (!info) return false;

  if (expectedCount === 0) return false;

  return info.argCount < expectedCount;
}

function hasRejectsOrResolvesMisuse(text) {
  const s = String(text || "");

  return (
    /\bconst\s+result\s*=.*\.rejects\b/i.test(s) ||
    /\bconst\s+result\s*=.*\.resolves\b/i.test(s) ||
    /\bawait\s+[a-zA-Z0-9_$]+\([^)]*\)\.rejects\b/i.test(s) ||
    /\bawait\s+[a-zA-Z0-9_$]+\([^)]*\)\.resolves\b/i.test(s)
  );
}

function canParseCaseAsFunctionBody({ arrange, act, assert, isAsync }) {
  const wrapped = `
    ${isAsync ? "async " : ""}function __unitgen_case__() {
      ${arrange}
      ${act}
      ${assert}
    }
  `;

  try {
    parseModule(wrapped);
    return true;
  } catch {
    return false;
  }
}

function hasResultCenteredAssertion(assertCode = "") {
  const s = String(assertCode || "");

  return (
    /\bresult\b/.test(s) ||
    /expect\s*\(\s*Array\.isArray\s*\(\s*result\s*\)\s*\)/i.test(s) ||
    /expect\s*\(\s*Object\.keys\s*\(\s*result\s*\)\s*\)/i.test(s) ||
    /expect\s*\(\s*Object\.values\s*\(\s*result\s*\)\s*\)/i.test(s) ||
    /expect\s*\(\s*Object\.entries\s*\(\s*result\s*\)\s*\)/i.test(s)
  );
}

function hasBehaviorCenteredAssertion(assertCode = "") {
  const s = String(assertCode || "");
  if (!/\bexpect\s*\(/.test(s)) return false;

  // Reject candidates that merely assert mock call bookkeeping. Repair should
  // describe observable behavior, return values, thrown errors, callbacks, or
  // externally visible state.
  const expectCount = (s.match(/\bexpect\s*\(/g) || []).length;
  const mockOnlyCount = (
    s.match(
      /\bexpect\s*\([^)]*(?:mock|spy|jest\.)[^)]*\)\s*\.\s*(?:toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes)/gi
    ) || []
  ).length;

  if (expectCount > 0 && mockOnlyCount === expectCount) return false;

  return true;
}

function hasOnlyWeakExistenceAssertion(assertCode = "") {
  const s = String(assertCode || "").trim();
  const expects = s.match(/\bexpect\s*\(/g) || [];
  if (expects.length !== 1) return false;

  return /\.(?:toBeDefined|toBeTruthy)\s*\(\s*\)\s*;?\s*$/.test(s);
}

function sanitizeRepairCases({
  fnName,
  isAsync,
  params,
  cases,
  allowedIdentifiers,
}) {
  if (!Array.isArray(cases)) return [];

  const safe = [];
  const seen = new Set();

  for (const rawCase of cases) {
    const c = normalizeCase(rawCase);
    if (!c) continue;

    const combined = `${c.arrange}\n${c.act}\n${c.assert}`;

    if (containsForbiddenTopLevelConstructs(combined)) continue;
    if (hasRejectsOrResolvesMisuse(combined)) continue;

    // Repairs may legitimately need test-local fixture/setup variables. They
    // may also assert throws/rejections directly without declaring `result`.
    // We only prevent conflicting result declarations.
    if (countResultDeclarations(c.arrange) > 0) continue;
    if (countResultDeclarations(c.assert) > 0) continue;
    if (countResultDeclarations(c.act) > 1) continue;

    if (!hasBehaviorCenteredAssertion(c.assert)) continue;
    if (hasOnlyWeakExistenceAssertion(c.assert)) continue;

    if (
      referencesUndeclaredFunctionParams({
        arrange: c.arrange,
        assert: c.assert,
        params,
      })
    ) {
      continue;
    }

    if (
      hasUndeclaredRepairReferences({
        arrange: c.arrange,
        act: c.act,
        assert: c.assert,
        allowedIdentifiers,
      })
    ) {
      continue;
    }

    if (
      !canParseCaseAsFunctionBody({
        arrange: c.arrange,
        act: c.act,
        assert: c.assert,
        isAsync,
      })
    ) {
      continue;
    }

    const signature = JSON.stringify(c);
    if (seen.has(signature)) continue;

    seen.add(signature);
    safe.push(c);
  }

  return safe;
}

/* ======================================================
   BUILD TEST NODES
====================================================== */
function buildTestStatement({ title, arrange, act, assert, isAsync }) {
  const safeTitle = String(title || "repaired test").replace(/"/g, '\\"');

  const testCode = `
    test("${safeTitle}", ${isAsync ? "async " : ""}() => {
      {
        ${arrange}
        ${act}
        ${assert}
      }
    });
  `;

  return parseStatement(testCode);
}

function isTestCallExpressionStatement(node) {
  if (!node || node.type !== "ExpressionStatement") return false;

  const expr = node.expression;
  if (!expr || expr.type !== "CallExpression") return false;

  const callee = expr.callee;

  if (
    callee?.type === "Identifier" &&
    (callee.name === "test" || callee.name === "it")
  ) {
    return true;
  }

  if (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    (callee.object.name === "test" || callee.object.name === "it")
  ) {
    return true;
  }

  return false;
}

function getTestTitleFromStatement(node) {
  if (!isTestCallExpressionStatement(node)) return null;

  const args = node.expression.arguments || [];
  const first = args[0];

  return first && first.type === "StringLiteral" ? first.value : null;
}

function shouldReplaceTest(title, failures) {
  if (!title) return false;

  return failures.some((f) => {
    const failed = String(f.testName || "");
    return failed === title || failed.includes(title) || title.includes(failed);
  });
}

function replaceFailingTestsInAst(ast, failures, newTestStatements) {
  let replaced = false;

  traverse(ast, {
    BlockStatement(path) {
      const body = path.node.body || [];
      const indexesToReplace = [];

      body.forEach((stmt, index) => {
        if (!isTestCallExpressionStatement(stmt)) return;

        const title = getTestTitleFromStatement(stmt);
        if (shouldReplaceTest(title, failures)) {
          indexesToReplace.push(index);
        }
      });

      if (indexesToReplace.length === 0) return;

      const firstIndex = indexesToReplace[0];
      const newBody = body.filter((_, index) => !indexesToReplace.includes(index));

      newBody.splice(firstIndex, 0, ...newTestStatements);
      path.node.body = newBody;
      replaced = true;
      path.stop();
    },
  });

  return replaced;
}

/* ======================================================
   FULL FILE SAFETY CHECKS
====================================================== */
function addPatternIdentifiers(node, out) {
  if (!node || !out) return;

  if (node.type === "Identifier") {
    out.add(node.name);
    return;
  }

  if (node.type === "ObjectPattern") {
    for (const prop of node.properties || []) {
      if (prop?.type === "RestElement") {
        addPatternIdentifiers(prop.argument, out);
      } else {
        addPatternIdentifiers(prop?.value, out);
      }
    }
    return;
  }

  if (node.type === "ArrayPattern") {
    for (const element of node.elements || []) {
      addPatternIdentifiers(element, out);
    }
  }
}

function getFileIdentifierSet(code) {
  const ids = new Set();

  try {
    const ast = parseModule(code);

    // This guard is intentionally TOP-LEVEL only. Test-local variables are
    // allowed to change during repair; imports/modules/file-level bindings are
    // not.
    for (const statement of ast.program.body || []) {
      if (statement.type === "ImportDeclaration") {
        for (const specifier of statement.specifiers || []) {
          if (specifier.local?.name) ids.add(specifier.local.name);
        }
        continue;
      }

      if (statement.type === "VariableDeclaration") {
        for (const declaration of statement.declarations || []) {
          addPatternIdentifiers(declaration.id, ids);
        }
        continue;
      }

      if (
        (statement.type === "FunctionDeclaration" ||
          statement.type === "ClassDeclaration") &&
        statement.id?.name
      ) {
        ids.add(statement.id.name);
      }
    }
  } catch {
    // Syntax validation happens elsewhere.
  }

  return ids;
}

function introducedNewTopLevelIdentifiers(originalCode, repairedCode) {
  const before = getFileIdentifierSet(originalCode);
  const after = getFileIdentifierSet(repairedCode);

  const introduced = [];

  for (const name of after) {
    if (!before.has(name)) introduced.push(name);
  }

  return introduced;
}


function buildSyntheticRepairContext({ originalCode = "", failures = [] } = {}) {
  const firstFailure = failures?.[0] || {};
  const testName = String(firstFailure.testName || "generated failing test");

  let inferredTarget = "";
  if (/\b__unitgen_target__\b/.test(originalCode)) {
    inferredTarget = "__unitgen_target__";
  } else {
    try {
      const ast = parseModule(originalCode);
      const candidates = [];

      traverse(ast, {
        ImportSpecifier(path) {
          if (path.node.local?.name) candidates.push(path.node.local.name);
        },
        ImportDefaultSpecifier(path) {
          if (path.node.local?.name) candidates.push(path.node.local.name);
        },
        VariableDeclarator(path) {
          if (
            path.parentPath?.parentPath?.isProgram?.() &&
            path.node.id?.type === "Identifier"
          ) {
            const name = path.node.id.name;
            if (!/^__(?:unitgen|repair)/i.test(name)) candidates.push(name);
          }
        },
      });

      inferredTarget =
        candidates.find((name) => !["fs", "path", "os"].includes(name)) || "";
    } catch {
      inferredTarget = "";
    }
  }

  return {
    testFilePath: firstFailure.filePath || "",
    fnName: inferredTarget,
    displayName: inferredTarget || "generated test target",
    fullName: inferredTarget || "generated test target",
    params: [],
    isAsync: /\basync\s*\([^)]*\)\s*=>|\basync\s+function|\bawait\b/.test(
      originalCode
    ),
    sourceCode: "",
    code: "",
    docs: "",
    usageSnippets: [],
    dependencyUsage: [],
    repairFallbackContext: true,
    failingTestName: testName,
  };
}

/* ======================================================
   MAIN LLM REPAIR ENGINE
====================================================== */
export async function attemptLLMRepair({
  originalCode,
  failures,
  contexts,
  model,
  attempt,
  history = [],
}) {
  try {
    if (!Array.isArray(failures) || failures.length === 0) return null;

    const filePath = failures[0].filePath;

    const ctx =
      (Array.isArray(contexts)
        ? contexts.find(
            (c) =>
              c?.testFilePath &&
              filePath &&
              String(c.testFilePath) === String(filePath)
          )
        : null) ||
      buildSyntheticRepairContext({
        originalCode,
        failures,
      });

    if (ctx?.repairFallbackContext) {
      console.log(
        "ℹ️ No generation context was available; LLM repair is using a safe test-derived fallback context."
      );
    }

    const allowedIdentifiers = buildAllowedIdentifiers({ originalCode, ctx });

    const prompt = buildRepairPrompt({
      originalCode,
      failures,
      context: ctx,
      attempt,
      history,
      allowedIdentifiers,
    });

    const response = await callLLM({
      prompt,
      model,
      temperature: 0.1,
    });

    if (!response) return null;

    const jsonContent = extractJSON(response);
    if (!jsonContent) {
      console.log("⚠️ No valid JSON in LLM response.");
      return null;
    }

    let parsed;

    try {
      parsed = JSON.parse(jsonContent);
    } catch {
      try {
        let fixed = jsonContent;
        fixed = fixed.replace(/,\s*([\]}])/g, "$1");
        fixed = fixed.replace(/```json|```/g, "");
        fixed = fixed.replace(/\\n/g, " ");
        parsed = JSON.parse(fixed);
      } catch {
        console.log("⚠️ JSON parse failed.");
        return null;
      }
    }

    const safeCases = sanitizeRepairCases({
      fnName: ctx.fnName,
      isAsync: ctx.isAsync,
      params: ctx.params || [],
      cases: parsed,
      allowedIdentifiers,
    });

    if (!Array.isArray(safeCases) || safeCases.length === 0) {
      console.log("⚠️ No usable LLM repair cases.");
      return null;
    }

    const originalAst = parseModule(originalCode);

    const newTestStatements = safeCases
      .map((c) =>
        buildTestStatement({
          title: c.title,
          arrange: c.arrange,
          act: c.act,
          assert: c.assert,
          isAsync: ctx.isAsync,
        })
      )
      .filter(Boolean);

    if (newTestStatements.length === 0) {
      console.log("⚠️ Could not build repaired test statements.");
      return null;
    }

    const replaced = replaceFailingTestsInAst(
      originalAst,
      failures,
      newTestStatements
    );

    if (!replaced) {
      console.log("⚠️ Could not locate failing tests to replace.");
      return null;
    }

    const repairedCode = generate(originalAst).code;

    if (
      originalCode.includes("jest.unstable_mockModule") &&
      !repairedCode.includes("jest.unstable_mockModule")
    ) {
      console.log("⚠️ Lost mocks → rejecting repair");
      return null;
    }

    if (
      originalCode.includes("jest.mock") &&
      !repairedCode.includes("jest.mock")
    ) {
      console.log("⚠️ Lost Jest mocks → rejecting repair");
      return null;
    }

    const introduced = introducedNewTopLevelIdentifiers(originalCode, repairedCode);

    if (introduced.length > 0) {
      console.log(
        `⚠️ LLM repair introduced new top-level identifiers: ${introduced.join(", ")}`
      );
      return null;
    }

    if (!validateSyntax(repairedCode)) {
      console.log("⚠️ Repaired code has syntax errors.");
      return null;
    }

    console.log("🧪 LLM repair candidate constructed.");
    return repairedCode;
  } catch (err) {
    console.log("⚠️ LLM repair failed:", err?.message);
    return null;
  }
}