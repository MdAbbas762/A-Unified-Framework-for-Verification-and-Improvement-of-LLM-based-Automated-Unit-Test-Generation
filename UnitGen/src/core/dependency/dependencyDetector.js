import traverseModule from "@babel/traverse";
import { parseSource } from "../parser/parseFile.js";
import { buildImportMap } from "./importMapBuilder.js";

const traverse = traverseModule.default;

/**
 * Step 2B:
 * For each function from Step 1, find which imported identifiers are used inside it.
 *
 * @param {string} code - Full source code of the file
 * @param {Array} functions - Step 1 output (array of function records)
 * @returns {{ importMap: object, usage: object }}
 */

export function detectImportedIdentifierUsage(code, functions) {
  const ast = parseSource(code);

  // Step 2A output: localName -> moduleName
  const importMap = buildImportMap(code);

  // Imported identifiers that we care about (e.g. axios, readFileSync, path)
  const importedNames = new Set(Object.keys(importMap));

  // Only analyze the functions that Step 1 already extracted
  const targetFunctionNames = new Set(functions.map((f) => f.name));

  // Result object: functionName -> [used imported identifier names]
  const usage = {};
  const memberUsage = {};

  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (!name || !targetFunctionNames.has(name)) return;

      const used = new Set();
      const usedMembers = new Set();

      // Traverse ONLY inside this function
      path.traverse({
        Identifier(innerPath) {
          const idName = innerPath.node.name;
          if (importedNames.has(idName)) used.add(idName);
        },

        MemberExpression(innerPath) {
          const obj = innerPath.node.object;
          const prop = innerPath.node.property;

          // Handle patterns like: path.join or axios.get
          if (obj?.type === "Identifier" && prop?.type === "Identifier") {
            const objName = obj.name;
            const propName = prop.name;

        if (importedNames.has(objName)) {
              used.add(objName); // base identifier is used
              usedMembers.add(`${objName}.${propName}`);
            }
          }
        },
      });

      usage[name] = Array.from(used);
      memberUsage[name] = Array.from(usedMembers);

    },

    VariableDeclarator(path) {
      // Handles: const mul = (x,y)=>... or const mul = function(x,y){...}
      const id = path.node.id;
      const init = path.node.init;

      if (!id || id.type !== "Identifier" || !init) return;
      if (!targetFunctionNames.has(id.name)) return;

      const isArrow = init.type === "ArrowFunctionExpression";
      const isFuncExpr = init.type === "FunctionExpression";
      if (!isArrow && !isFuncExpr) return;

      const used = new Set();
      const usedMembers = new Set();


      // Traverse ONLY inside the function expression / arrow function node
      path.get("init").traverse({
  Identifier(innerPath) {
    const idName = innerPath.node.name;
    if (importedNames.has(idName)) used.add(idName);
  },

  MemberExpression(innerPath) {
    const obj = innerPath.node.object;
    const prop = innerPath.node.property;

    if (obj?.type === "Identifier" && prop?.type === "Identifier") {
      const objName = obj.name;
      const propName = prop.name;

      if (importedNames.has(objName)) {
        used.add(objName);
        usedMembers.add(`${objName}.${propName}`);
      }
    }
  },
});

      usage[id.name] = Array.from(used);
      memberUsage[id.name] = Array.from(usedMembers);

    },
  });

  // Ensure every function has an entry even if no deps were used
  for (const fn of functions) {
    if (!usage[fn.name]) usage[fn.name] = [];
    if (!memberUsage[fn.name]) memberUsage[fn.name] = [];

  }

  return { importMap, usage, memberUsage };
}


/**
 * Step 2C:
 * Converts identifier usage into module dependencies using importMap.
 *
 * @param {object} importMap - localName -> moduleName
 * @param {object} usage - functionName -> [localNamesUsed]
 * @returns {object} dependencies - functionName -> [moduleNamesUsed]
 */

export function convertUsageToModuleDependencies(importMap, usage) {
  const dependencies = {};

  for (const [fnName, usedNames] of Object.entries(usage)) {
    const modules = new Set();

    for (const localName of usedNames) {
      const moduleName = importMap[localName];
      if (moduleName) modules.add(moduleName);
    }

    dependencies[fnName] = Array.from(modules);
  }

  return dependencies;
}
