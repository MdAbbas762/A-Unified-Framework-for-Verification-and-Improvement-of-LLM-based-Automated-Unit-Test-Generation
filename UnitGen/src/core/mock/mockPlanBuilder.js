/*
Builds a per-function mock plan.

Input:
- functions: Step 1 array (function records)
- importMap: localName -> moduleName
- usage: functionName -> [localNamesUsed]
- dependencies: functionName -> [moduleNamesUsed]

Output:
- mockPlan: functionName -> array of { module, type, targets[] }
*/

import { classifyModule } from "./moduleClassifier.js";

export function buildMockPlan({ functions, importMap, usage, memberUsage, dependencies }) {
  const mockPlan = {};

  for (const fn of functions) {
    const fnName = fn.name;

    const fnUsageNames = usage[fnName] || [];
    const fnModules = dependencies[fnName] || [];
    const fnMemberUsage = memberUsage?.[fnName] || [];

    // Create module -> targets mapping
    const moduleTargets = new Map();

    // For each used identifier, find its module via importMap
    for (const localName of fnUsageNames) {
      const moduleName = importMap[localName];
      if (!moduleName) continue;

      if (!moduleTargets.has(moduleName)) moduleTargets.set(moduleName, new Set());
      moduleTargets.get(moduleName).add(localName);
    }

    // Add member usage targets like: "path.join" -> module "path", target "join"
for (const full of fnMemberUsage) {
  const [objName, memberName] = full.split(".");
  if (!objName || !memberName) continue;

  const moduleName = importMap[objName];
  if (!moduleName) continue;

  if (!moduleTargets.has(moduleName)) moduleTargets.set(moduleName, new Set());
  moduleTargets.get(moduleName).add(memberName);
}

    // Ensure every dependency module exists in the plan even if no targets found
    for (const moduleName of fnModules) {
      if (!moduleTargets.has(moduleName)) moduleTargets.set(moduleName, new Set());
    }

    // Convert into array format
    const entries = [];
    for (const [moduleName, targetsSet] of moduleTargets.entries()) {
      entries.push({
        module: moduleName,
        type: classifyModule(moduleName), // "builtin" or "external"
        targets: Array.from(targetsSet),  // identifiers used from that module
      });
    }

    mockPlan[fnName] = entries;
  }

  return mockPlan;
}