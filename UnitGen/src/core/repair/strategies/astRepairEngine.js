// src/core/repair/strategies/astRepairEngine.js

import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";
import * as t from "@babel/types";
import { parseSource } from "../../parser/parseFile.js";
import { validateSyntax } from "../../validation/validateSyntax.js";

const traverse = traverseModule.default;
const generate = generatorModule.default;

/* ======================================================
   MAIN AST REPAIR
====================================================== */

export function attemptAstRepair(originalCode, failure) {

  /* ======================================================
     🔥 0. EARLY EXIT (SMART FILTER)
  ====================================================== */

  if (!failure) return null;

  // Only allow AST repair for specific types
  if (
    failure.errorType !== "SYNTAX_ERROR" &&
    failure.errorType !== "UNEXPECTED_THROW"
  ) {
    return null;
  }

  // DO NOT risk touching mock-heavy files unnecessarily
  const hasMocks = originalCode.includes("jest.unstable_mockModule") ||
                   originalCode.includes("jest.mock(");

  let ast;

  try {
    ast = parseSource(originalCode);
  } catch {
    console.log("⚠️ AST parsing failed.");
    return null;
  }

  let repaired = false;

  traverse(ast, {

    CallExpression(path) {

      if (repaired) {
        path.stop();
        return;
      }

      /* ======================================================
         🔥 1. PROTECT MOCKS (CRITICAL)
      ====================================================== */

      const parentCode = generate(path.node).code;

      if (
        parentCode.includes("jest.unstable_mockModule") ||
        parentCode.includes("jest.mock(")
      ) {
        return;
      }

      /* ======================================================
         🔥 2. TARGET ONLY test()/it()
      ====================================================== */

      const callee = path.node.callee;

      if (
        !t.isIdentifier(callee) ||
        !["test", "it"].includes(callee.name)
      ) return;

      const args = path.get("arguments");

      const testNamePath = args[0];
      const testFnPath = args[1];

      if (!testNamePath || !testFnPath) return;
      if (!testNamePath.isStringLiteral()) return;

      const testName = testNamePath.node.value;

      if (!failure?.testName?.includes(testName)) return;

      /* ======================================================
         🔥 3. APPLY CONTROLLED FIXES
      ====================================================== */

      if (failure.errorType === "UNEXPECTED_THROW") {
        repaired = fixUnexpectedThrow(testFnPath, failure);
      }

      if (repaired) path.stop();
    }

  });

  if (!repaired) return null;

  const newCode = generate(ast).code;

  /* ======================================================
     🔥 4. SAFETY CHECKS (VERY IMPORTANT)
  ====================================================== */

  // Prevent mock removal (environment drift)
  if (hasMocks && !newCode.includes("jest")) {
    console.log("⚠️ AST removed mocks. Skipping.");
    return null;
  }

  // Prevent broken string issues
  if (
    newCode.includes("toThrow('") &&
    newCode.includes(" in ")
  ) {
    console.log("⚠️ AST produced unsafe string. Skipping.");
    return null;
  }

  // Prevent multi-line string break
  if (/(['"])\n/.test(newCode)) {
    console.log("⚠️ AST produced broken string. Skipping.");
    return null;
  }

  // Prevent accidental full rewrite
  if (newCode.length < originalCode.length * 0.5) {
    console.log("⚠️ AST produced suspicious shrink. Skipping.");
    return null;
  }

  // Final syntax validation
  return validateSyntax(newCode) ? newCode : null;
}

/* ======================================================
   THROW REPAIR (SAFE + CONTROLLED)
====================================================== */

function fixUnexpectedThrow(testFnPath, failure) {

  const errorMsg =
    failure?.errorMessage?.toLowerCase() || "";

  if (!errorMsg.includes("throw")) return false;

  let changed = false;

  const msgMatch =
    failure.errorMessage?.match(/Error:\s*(.*)/);

  let errorText = msgMatch?.[1] || null;

  /* ======================================================
     🔥 SAFE STRING CLEANUP
  ====================================================== */

  if (errorText) {

    errorText = errorText
      .replace(/'/g, "\\'")
      .replace(/\n/g, " ")
      .trim();

    // Remove risky patterns
    if (errorText.includes(" in ")) {
      errorText = null;
    }
  }

  testFnPath.traverse({

    CallExpression(path) {

      if (changed) {
        path.stop();
        return;
      }

      const callee = path.node.callee;

      if (!t.isIdentifier(callee, { name: "expect" })) return;

      const arg = path.node.arguments[0];

      if (!t.isCallExpression(arg)) return;

      /* ======================================================
         🔥 SAFE WRAP: expect(() => fn()).toThrow()
      ====================================================== */

      const clonedCall = t.cloneNode(arg, true);

      const arrowWrapper = t.arrowFunctionExpression(
        [],
        t.blockStatement([
          t.returnStatement(clonedCall)
        ])
      );

      const expectCall = t.callExpression(
        t.identifier("expect"),
        [arrowWrapper]
      );

      const toThrowCall = t.callExpression(
        t.memberExpression(expectCall, t.identifier("toThrow")),
        errorText ? [t.stringLiteral(errorText)] : []
      );

      path.replaceWith(toThrowCall);

      changed = true;
      path.stop();
    }

  });

  return changed;
}