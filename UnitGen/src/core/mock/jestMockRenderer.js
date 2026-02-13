/*
Renders a mock plan entry into Jest mock code strings.
Output is strings only.
*/

export function renderJestMocksForFunction(mockEntries) {
  if (!mockEntries || mockEntries.length === 0) return "";

  const lines = [];

  for (const entry of mockEntries) {
    const moduleName = entry.module;
    const targets = entry.targets || [];

    // BUILT-IN MODULES (fs, path)
    if (entry.type === "builtin") {
      // Only mock real members like join, readFileSync
      // Skip namespace identifier if it appears as a target (e.g., "path")
      const members = targets.filter((t) => t !== moduleName);

      if (members.length > 0) {
        const props = members
          .map((m) => {
            if (moduleName === "path" && m === "join") { 
              return `${m}: jest.fn(() => "data/x.txt")`;
            }
            if (moduleName === "fs" && m === "readFileSync") { 
              return `${m}: jest.fn(() => "dummy file")`;
            }  
            if (moduleName === "fs" && m === "readFile") {
              return `${m}: jest.fn((_, __, cb) => cb(null, "dummy file"))`;
            }  
            return `${m}: jest.fn()`;
        })
        .join(", ");

        lines.push(`jest.mock("${moduleName}", () => ({ ${props} }));`);
      } else {
        // If no specific member detected, fallback mock as empty object
        lines.push(`jest.mock("${moduleName}", () => ({}));`);
      }

      continue;
    }

    // EXTERNAL MODULES (axios, lodash, etc.)
    // Prototype assumption: default import style
    const methods = targets
      .filter((t) => t !== moduleName) // remove base identifier (e.g., "axios")
      .filter(Boolean);

    if (moduleName === "axios") {
      lines.push(
        `jest.mock("axios", () => { const api = { get: jest.fn().mockResolvedValue({ data: {} }) }; return { ...api, default: api }; });`
      );
      continue;
    }  

    const methodBlock =
      methods.length > 0
        ? methods
          .map((m) => {
            if (m === "get") return `${m}: jest.fn().mockResolvedValue({ data: {} })`;
            return `${m}: jest.fn()`;
          })
          .join(", ")
        : 'get: jest.fn().mockResolvedValue({ data: {} })'; // axios-like fallback

    lines.push(`jest.mock("${moduleName}", () => ({ default: { ${methodBlock} } }));`);

  }

  return lines.join("\n");
}

/*
Renders Jest mocks for the full mockPlan:
{ fnName -> [entries] }  => { fnName -> "jest.mock(...)" }
*/

export function renderJestMocks(mockPlan) {
  const out = {};

  for (const [fnName, entries] of Object.entries(mockPlan)) {
    out[fnName] = renderJestMocksForFunction(entries);
  }

  return out;
}
