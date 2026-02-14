/**
 * LLM PROMPT CONTRACT (RELIABLE):
 * The model MUST return ONLY JSON describing test cases.
 * It must NOT write imports, mocks, or rewrite the harness.
 */

export function buildOllamaPrompt({
  fnName,
  isAsync,
  params,
  functionCode,
  harnessNotes = "",
}) {
  const arithmeticHint = /^(add|sum|subtract|sub|minus|multiply|mul|divide|div)$/i.test(
    String(fnName || "")
  )
    ? "IMPORTANT: This looks like an arithmetic function. Use NUMBER inputs only (no quoted numbers like '5' or \"5\")."
    : "";

  return `
You are generating Jest test cases for a JavaScript function.

Function name: ${fnName}
Async: ${isAsync}
Params: ${JSON.stringify(params)}

${arithmeticHint}

Function code:
${functionCode}

Harness notes (read-only, already handled by the tool):
${harnessNotes || "(none)"}

OUTPUT FORMAT (MUST FOLLOW EXACTLY):
- Return ONLY a JSON array of test cases.
- Wrap the JSON array between these tags exactly:
<JSON>
[ ... ]
</JSON>
- Do NOT include any other text before or after.
- Do NOT use backticks.
- All values MUST be valid JSON strings (use double quotes).

Schema (example):
<JSON>
[
  {
    "title": "example title",
    "arrange": "const a = 1;\\nconst b = 2;",
    "act": "const result = add(a, b);",
    "assert": "expect(result).toBe(3);"
  }
]
</JSON>

Rules:
- Do NOT write import statements.
- Do NOT write jest.mock or jest.unstable_mockModule.
- Do NOT access real filesystem or network.
- Use correct JavaScript types.
- The "act" field MUST include: const result =
- Provide 2 to 4 test cases.

Now output ONLY the <JSON> ... </JSON> block:
`.trim();
}