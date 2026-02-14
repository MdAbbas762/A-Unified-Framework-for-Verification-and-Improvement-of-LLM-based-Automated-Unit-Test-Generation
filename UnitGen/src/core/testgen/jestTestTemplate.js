/**
 * ESM-safe Jest test template (stable harness).
 * - Always uses @jest/globals
 * - Converts rendered mocks (jest.mock) to ESM-safe jest.unstable_mockModule
 * - Imports module under test AFTER mocks using dynamic import
 * - Keeps a fallback prototype test so suite is never empty
 * - Provides a marker where LLM-generated tests will be injected
 */

export function renderJestTestTemplate({
  fnName,
  isAsync,
  importPath,
  params = [],
  jestMocks = "",
}) {
  // Convert renderer output to ESM-safe mocking API
  const esmMocks = (jestMocks || "").replaceAll(
    "jest.mock(",
    "jest.unstable_mockModule("
  );

  // Build safe placeholder declarations + call args (fallback prototype test)
  const declarations = [];
  const callArgs = [];

  for (const raw of params) {
    const name = String(raw || "arg").replace(/[^a-zA-Z0-9_$]/g, "") || "arg";
    const lower = name.toLowerCase();

    if (lower.includes("id")) {
      declarations.push(`    const ${name} = 1;`);
      callArgs.push(name);
      continue;
    }

    if (lower.includes("api") || lower.includes("client") || lower.includes("service")) {
      declarations.push(
        `    const ${name} = { get: jest.fn().mockResolvedValue({ data: {} }) };`
      );
      callArgs.push(name);
      continue;
    }

    if (lower.includes("cb") || lower.includes("callback")) {
      declarations.push(`    const ${name} = jest.fn();`);
      callArgs.push(name);
      continue;
    }

    if (lower.includes("url") || lower.includes("path") || lower.includes("name")) {
      declarations.push(`    const ${name} = "test";`);
      callArgs.push(name);
      continue;
    }

    declarations.push(`    const ${name} = 1;`);
    callArgs.push(name);
  }

  const callLine = isAsync
    ? `    const result = await ${fnName}(${callArgs.join(", ")});`
    : `    const result = ${fnName}(${callArgs.join(", ")});`;

  // We always import jest, because the harness/mocks and placeholders may need it
  return `import { describe, test, expect, jest } from "@jest/globals";

${esmMocks ? `${esmMocks}\n` : ""}
// Import AFTER mocks (required for ESM mocking)
const mod = await import("${importPath}");
const { ${fnName} } = mod;

describe("${fnName}", () => {
  // Fallback prototype test (always present so suite is never empty)
  test("auto-generated (prototype)", ${isAsync ? "async " : ""}() => {
${declarations.length ? declarations.join("\n") + "\n" : ""}${callLine}
    expect(result).toBeDefined();
  });

  /*__UNITGEN_LLM_TESTS__*/
});
`;
}