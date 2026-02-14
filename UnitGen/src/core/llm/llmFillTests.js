import fs from "fs";
import { ollamaGenerate } from "./ollamaClient.js";
import { buildOllamaPrompt } from "./promptBuilder.js";

function stripMarkdownCodeFences(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n/, "");
  s = s.replace(/\n```$/, "");
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
  s = s.replace(/```$/g, "");
  return s.trim();
}

function extractJsonArray(text) {
  let s = String(text || "").trim();

  const startTag = "<JSON>";
  const endTag = "</JSON>";
  const start = s.indexOf(startTag);
  const end = s.lastIndexOf(endTag);

  if (start !== -1 && end !== -1 && end > start) {
    return s.slice(start + startTag.length, end).trim();
  }

  s = s.replace(/```[a-zA-Z0-9_-]*\s*/g, "");
  s = s.replace(/```/g, "");
  s = s.replace(/`/g, "");

  const b0 = s.indexOf("[");
  const b1 = s.lastIndexOf("]");
  if (b0 === -1 || b1 === -1 || b1 <= b0) {
    throw new Error("LLM output did not contain a JSON array.");
  }
  return s.slice(b0, b1 + 1);
}

function indentBlock(code, spaces = 4) {
  const pad = " ".repeat(spaces);
  return String(code || "")
    .split("\n")
    .map((line) => (line.trim().length ? pad + line : line))
    .join("\n");
}

/**
 * Hard reject patterns that frequently break Jest/JS parsing.
 * This is general tool-level hygiene.
 */
function containsBannedPatterns(code) {
  const s = String(code || "");
  const banned = [
    /\bawait\s+const\b/i,        // "await const" (invalid JS)
    /\bconst\s*\{/i,             // destructuring const { ... } (often misused by LLM)
    /\bfunction\s*\*/i,          // generators (LLM sometimes invents)
    /```/,                       // markdown fences should never be here
  ];
  return banned.some((re) => re.test(s));
}

/**
 * ✅ NEW: Prevent the LLM from using module identifiers inside test bodies.
 * In UnitGen, mocks are configured at top-level. The LLM test snippets should NOT
 * touch path/fs/axios/readFileSync/etc directly.
 */
function referencesBannedIdentifiers(code) {
  const s = String(code || "");

  const banned = [
    /\bpath\b/i,
    /\bfs\b/i,
    /\breadFileSync\b/i,
    /\breadFile\b/i,
    /\baxios\b/i,
    /\bimport\b/i,
    /\brequire\b/i,
  ];

  return banned.some((re) => re.test(s));
}

/**
 * Make act a single line: const result = (await) fnName(...)
 * We do NOT allow the model to invent extra computations in act.
 */
function buildCanonicalAct({ fnName, isAsync, rawAct }) {
  let a = String(rawAct || "").trim();

  // Extract fn call if model wrote it, otherwise fallback to fnName()
  const callLike = a.match(new RegExp(`\\b${fnName}\\s*\\([^;]*\\)`, "m"));
  const callExpr = callLike ? callLike[0] : `${fnName}()`;

  if (isAsync) return `const result = await ${callExpr};`;
  return `const result = ${callExpr};`;
}

/**
 * Validate + sanitize cases.
 * - drop broken cases instead of failing whole file
 * - enforce safe act
 * - prevent redeclaration of result
 * - reject LLM trying to use path/fs/axios identifiers in test body
 * - reject logically wrong "result.id is undefined" cases
 */
function sanitizeCases({ fnName, isAsync, cases }) {
  if (!Array.isArray(cases) || cases.length === 0) return [];

  const cleaned = [];

  for (const c0 of cases) {
    const c = {
      title: String(c0?.title ?? "generated test"),
      arrange: String(c0?.arrange ?? ""),
      act: String(c0?.act ?? ""),
      assert: String(c0?.assert ?? ""),
    };

    // ✅ Ban obvious broken patterns anywhere + banned identifiers
    if (
      containsBannedPatterns(c.arrange) ||
      containsBannedPatterns(c.act) ||
      containsBannedPatterns(c.assert) ||
      referencesBannedIdentifiers(c.arrange) ||
      referencesBannedIdentifiers(c.act) ||
      referencesBannedIdentifiers(c.assert)
    ) {
      continue;
    }

    // Reject if assert/arrange redeclares result (common LLM bug)
    if (
      /\bconst\s+result\s*=/.test(c.arrange) ||
      /\bconst\s+result\s*=/.test(c.assert)
    ) {
      continue;
    }

    // ✅ Drop cases that expect result.id to be undefined (commonly wrong)
    // Your function returns { id, ... } and keeps the given id.
    const combinedLower = `${c.arrange}\n${c.act}\n${c.assert}`.toLowerCase();
    if (combinedLower.includes("result.id") && combinedLower.includes("tobeundefined")) {
      continue;
    }

    // Canonicalize act into exactly one const result line
    c.act = buildCanonicalAct({ fnName, isAsync, rawAct: c.act });

    // After canonicalization, it must contain exactly one "const result ="
    const count = (c.act.match(/\bconst\s+result\s*=/g) || []).length;
    if (count !== 1) continue;

    // Arithmetic heuristic (prevents add("5","3") style mistakes)
    const isArithmetic = /^(add|sum|subtract|sub|minus|multiply|mul|divide|div)$/i.test(
      String(fnName || "")
    );

    if (isArithmetic) {
      const combined = `${c.arrange}\n${c.act}\n${c.assert}`;
      if (/['"]\d+['"]/.test(combined)) {
        continue;
      }
    }

    cleaned.push(c);
  }

  return cleaned;
}

function buildTestBlocks({ isAsync, cases }) {
  return cases
    .map((c) => {
      const title = String(c.title || "generated test").replace(/"/g, '\\"');
      const arrange = String(c.arrange || "").trim();
      const act = String(c.act || "").trim();
      const assert = String(c.assert || "").trim();

      return `
  test("${title}", ${isAsync ? "async " : ""}() => {
    {
${arrange ? indentBlock(arrange, 6) + "\n" : ""}${indentBlock(act, 6)}
${assert ? "\n" + indentBlock(assert, 6) : ""}
    }
  });`.trimEnd();
    })
    .join("\n\n");
}

export async function fillGeneratedTestsWithOllama({
  contexts,
  model = "qwen2.5:1.5b",
}) {
  let updated = 0;
  let failed = 0;

  for (const ctx of contexts) {
    try {
      const template = fs.readFileSync(ctx.testFilePath, "utf8");

      if (!template.includes("/*__UNITGEN_LLM_TESTS__*/")) {
        throw new Error("Template marker not found in generated test file.");
      }

      const harnessNotes = [
        "Tool already handles imports and dependency mocks.",
        "DO NOT write imports or mocks.",
        "Return ONLY JSON inside <JSON>...</JSON>.",
        "The act MUST be a function call. Tool will build: const result = (await) fn(...).",
        "DO NOT reference path/fs/axios/readFileSync inside test bodies.",
        "Write assertions consistent with mocks: readFileSync -> 'dummy file', axios.get -> { data: {} }.",
      ].join(" ");

      const prompt = buildOllamaPrompt({
        fnName: ctx.fnName,
        isAsync: ctx.isAsync,
        params: ctx.params,
        functionCode: ctx.functionCode,
        harnessNotes,
      });

      let raw = await ollamaGenerate({ model, prompt, temperature: 0.2 });
      raw = stripMarkdownCodeFences(raw);

      const jsonText = extractJsonArray(raw);
      const parsed = JSON.parse(jsonText);

      const safeCases = sanitizeCases({
        fnName: ctx.fnName,
        isAsync: ctx.isAsync,
        cases: parsed,
      });

      if (safeCases.length === 0) {
        failed++;
        console.log(
          `⚠️ LLM produced no safe tests for ${ctx.fnName}; keeping prototype only.`
        );
        continue;
      }

      const injected = buildTestBlocks({ isAsync: ctx.isAsync, cases: safeCases });
      const finalTestFile = template.replace("/*__UNITGEN_LLM_TESTS__*/", injected);

      fs.writeFileSync(ctx.testFilePath, finalTestFile, "utf8");
      updated++;
      console.log(`✨ LLM injected tests: ${ctx.testFilePath}`);
    } catch (e) {
      failed++;
      console.log(`⚠️ LLM failed for ${ctx.fnName}: ${e?.message ?? e}`);
    }
  }

  return { updated, failed };
}
