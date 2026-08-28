import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";
import * as t from "@babel/types";
import { parseSource } from "../../parser/parseFile.js";
import { validateSyntax } from "../../validation/validateSyntax.js";

const traverse = traverseModule.default;
const generate = generatorModule.default;

/* ======================================================
   HELPERS
====================================================== */
function getFailureType(failure) {
  return (
    failure?.failureType ||
    failure?.type ||
    failure?.errorType ||
    "UNKNOWN"
  );
}

function normalizeErrorMessage(msg = "") {
  return String(msg || "").toLowerCase();
}

function detectRuntimePatterns(errorMsg) {
  const msg = normalizeErrorMessage(errorMsg);

  const isAssertionError =
    msg.includes("expect(received)") ||
    msg.includes("expected:") ||
    msg.includes("received:") ||
    msg.includes("expected -") ||
    msg.includes("received +") ||
    msg.includes("assertionerror") ||
    msg.includes("object.is equality") ||
    msg.includes("deep equality") ||
    msg.includes("expect(") ||
    msg.includes("tobe") ||
    msg.includes("toequal") ||
    msg.includes("tostrictequal") ||
    msg.includes("tobecloseto");

  return {
    isDivisionError: msg.includes("division by zero"),
    isUndefinedAccess:
      msg.includes("cannot read") && msg.includes("undefined"),
    isNullAccess:
      msg.includes("cannot read") && msg.includes("null"),
    isNaNError:
      msg.includes("nan") || msg.includes("not a number"),
    isTypeError:
      msg.includes("typeerror") ||
      msg.includes("is not a function") ||
      msg.includes("undefined is not"),
    isExplicitThrow:
      !isAssertionError &&
      (
        msg.includes("error:") ||
        msg.includes("thrown") ||
        msg.includes("throws")
      ),
    isAssertionError,
    isRejectsMatcherMisuse:
      msg.includes(".rejects") &&
      msg.includes("received value must be a promise"),
    isResolvesMatcherMisuse:
      msg.includes(".resolves") &&
      msg.includes("received value must be a promise"),
    isToThrowMatcherMisuse:
      msg.includes("tothrow") &&
      (
        msg.includes("received value must be a function") ||
        msg.includes("did not throw")
      ),
    isNumericOracleMismatch:
      msg.includes("tobecloseto") ||
      (
        msg.includes("expected") &&
        msg.includes("received") &&
        /\d/.test(msg)
      ),
    isDeepEqualityMismatch:
      msg.includes("toequal") ||
      msg.includes("tostrictequal") ||
      msg.includes("deep equality") ||
      msg.includes("expected -") ||
      msg.includes("received +"),
    isNullishOracleMismatch:
      (
        msg.includes("tobenull") ||
        msg.includes("tobeundefined") ||
        msg.includes("null") ||
        msg.includes("undefined")
      ) &&
      msg.includes("received"),
  };
}

function extractErrorText(failure) {
  const raw = String(failure?.errorMessage || "");
  const match = raw.match(/Error:\s*([^\n\r]+)/);
  const text = match?.[1]?.trim();

  if (!text) return null;

  return text.replace(/\s+/g, " ").trim();
}

function isMatcherCall(node) {
  if (!t.isCallExpression(node)) return false;
  if (!t.isMemberExpression(node.callee)) return false;
  return true;
}

function getMatcherName(node) {
  if (!t.isCallExpression(node)) return null;
  if (!t.isMemberExpression(node.callee)) return null;
  if (!t.isIdentifier(node.callee.property)) return null;
  return node.callee.property.name;
}

function getOuterExpectStructure(node) {
  if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) {
    return null;
  }

  const matcherName = t.isIdentifier(node.callee.property)
    ? node.callee.property.name
    : null;

  const objectExpr = node.callee.object;

  // expect(...).matcher(...)
  if (
    t.isCallExpression(objectExpr) &&
    t.isIdentifier(objectExpr.callee, { name: "expect" })
  ) {
    return {
      matcherName,
      modifier: null,
      expectCall: objectExpr,
    };
  }

  // expect(...).rejects.matcher(...) / expect(...).resolves.matcher(...)
  if (
    t.isMemberExpression(objectExpr) &&
    t.isIdentifier(objectExpr.property)
  ) {
    const modifier = objectExpr.property.name;
    const maybeExpectCall = objectExpr.object;

    if (
      t.isCallExpression(maybeExpectCall) &&
      t.isIdentifier(maybeExpectCall.callee, { name: "expect" })
    ) {
      return {
        matcherName,
        modifier,
        expectCall: maybeExpectCall,
      };
    }
  }

  // expect(...).not.matcher(...)
  if (
    t.isMemberExpression(objectExpr) &&
    t.isIdentifier(objectExpr.property, { name: "not" })
  ) {
    const maybeExpectCall = objectExpr.object;

    if (
      t.isCallExpression(maybeExpectCall) &&
      t.isIdentifier(maybeExpectCall.callee, { name: "expect" })
    ) {
      return {
        matcherName,
        modifier: "not",
        expectCall: maybeExpectCall,
      };
    }
  }

  return null;
}

function testNameMatches(failureTestName, currentTestName) {
  if (!failureTestName || !currentTestName) return false;
  return String(failureTestName).includes(String(currentTestName));
}

function testNameSignalsErrorIntent(testName = "") {
  return /\b(?:error|invalid|reject|throw|fail|missing|unsupported|bad|wrong|denied|nonexistent|not found)\b/i.test(
    String(testName || "")
  );
}

function buildSyncThrowAssertion(callNode, errorText) {
  const arrowWrapper = t.arrowFunctionExpression(
    [],
    t.blockStatement([t.returnStatement(t.cloneNode(callNode, true))])
  );

  const expectCall = t.callExpression(t.identifier("expect"), [arrowWrapper]);

  return t.callExpression(
    t.memberExpression(expectCall, t.identifier("toThrow")),
    errorText ? [t.stringLiteral(errorText)] : []
  );
}

function buildAsyncRejectThrowAssertion(callNode, errorText) {
  const expectCall = t.callExpression(t.identifier("expect"), [
    t.cloneNode(callNode, true),
  ]);

  const rejectsExpr = t.memberExpression(
    expectCall,
    t.identifier("rejects")
  );

  return t.callExpression(
    t.memberExpression(rejectsExpr, t.identifier("toThrow")),
    errorText ? [t.stringLiteral(errorText)] : []
  );
}

function buildResolvesDefinedAssertion(callNode) {
  const expectCall = t.callExpression(t.identifier("expect"), [
    t.cloneNode(callNode, true),
  ]);

  const resolvesExpr = t.memberExpression(
    expectCall,
    t.identifier("resolves")
  );

  return t.callExpression(
    t.memberExpression(resolvesExpr, t.identifier("toBeDefined")),
    []
  );
}

function buildPromiseMatcherAssertion(
  callNode,
  modifier,
  matcherName,
  matcherArgs = []
) {
  const expectCall = t.callExpression(t.identifier("expect"), [
    t.cloneNode(callNode, true),
  ]);

  const modifierExpr = t.memberExpression(
    expectCall,
    t.identifier(modifier)
  );

  return t.callExpression(
    t.memberExpression(
      modifierExpr,
      t.identifier(matcherName || "toBeDefined")
    ),
    (matcherArgs || []).map((arg) => t.cloneNode(arg, true))
  );
}

function buildSyncThrowPreservingAssertion(
  callNode,
  matcherName,
  matcherArgs = []
) {
  const arrowWrapper = t.arrowFunctionExpression(
    [],
    t.cloneNode(callNode, true)
  );

  const expectCall = t.callExpression(t.identifier("expect"), [arrowWrapper]);

  return t.callExpression(
    t.memberExpression(
      expectCall,
      t.identifier(
        ["toThrow", "toThrowError"].includes(matcherName)
          ? matcherName
          : "toThrow"
      )
    ),
    (matcherArgs || []).map((arg) => t.cloneNode(arg, true))
  );
}


function extractUnderlyingCall(expectArgPath) {
  const node = expectArgPath.node;

  // expect(fn())
  if (t.isCallExpression(node)) {
    return { kind: "sync-call", callNode: t.cloneNode(node, true) };
  }

  // expect(await fn())
  if (t.isAwaitExpression(node) && t.isCallExpression(node.argument)) {
    return { kind: "async-call", callNode: t.cloneNode(node.argument, true) };
  }

  // expect(result) where result = fn() OR await fn()
  if (expectArgPath.isIdentifier()) {
    const binding = expectArgPath.scope.getBinding(expectArgPath.node.name);
    if (!binding) return null;

    const bindingPath = binding.path;
    if (!bindingPath.isVariableDeclarator()) return null;

    const init = bindingPath.node.init;
    if (!init) return null;

    if (t.isCallExpression(init)) {
      return { kind: "sync-call", callNode: t.cloneNode(init, true) };
    }

    if (t.isAwaitExpression(init) && t.isCallExpression(init.argument)) {
      return { kind: "async-call", callNode: t.cloneNode(init.argument, true) };
    }
  }

  return null;
}

function buildAssertionValueNode(receivedText) {
  if (receivedText === undefined || receivedText === null) return null;

  try {
    return t.valueToNode(JSON.parse(receivedText));
  } catch {
    if (receivedText === "undefined") return t.identifier("undefined");
    if (receivedText === "null") return t.nullLiteral();
    if (!Number.isNaN(Number(receivedText))) {
      return t.numericLiteral(Number(receivedText));
    }
    return t.stringLiteral(String(receivedText));
  }
}

function extractReceivedLiteral(errorMsg) {
  const msg = String(errorMsg || "");
  const match = msg.match(/Received(?: has value)?:\s*([^\n\r]+)/i);
  return match?.[1]?.trim() || null;
}

/* ======================================================
   SAFE ASSERTION REPAIR HELPERS
====================================================== */

function buildNotNullishAssertions(expectArgNode) {
  const expectNotNull = t.callExpression(
    t.memberExpression(
      t.memberExpression(
        t.callExpression(t.identifier("expect"), [t.cloneNode(expectArgNode, true)]),
        t.identifier("not")
      ),
      t.identifier("toBeNull")
    ),
    []
  );

  const expectNotUndefined = t.callExpression(
    t.memberExpression(
      t.memberExpression(
        t.callExpression(t.identifier("expect"), [t.cloneNode(expectArgNode, true)]),
        t.identifier("not")
      ),
      t.identifier("toBeUndefined")
    ),
    []
  );

  return [expectNotNull, expectNotUndefined];
}

function buildToBeUndefinedAssertion(expectArgNode) {
  return t.callExpression(
    t.memberExpression(
      t.callExpression(t.identifier("expect"), [t.cloneNode(expectArgNode, true)]),
      t.identifier("toBeUndefined")
    ),
    []
  );
}

function buildNumberShapeAssertions(expectArgNode) {
  const typeofAssertion = t.callExpression(
    t.memberExpression(
      t.callExpression(t.identifier("expect"), [
        t.unaryExpression("typeof", t.cloneNode(expectArgNode, true), true),
      ]),
      t.identifier("toBe")
    ),
    [t.stringLiteral("number")]
  );

  const finiteAssertion = t.callExpression(
    t.memberExpression(
      t.callExpression(t.identifier("expect"), [
        t.callExpression(
          t.memberExpression(t.identifier("Number"), t.identifier("isFinite")),
          [t.cloneNode(expectArgNode, true)]
        ),
      ]),
      t.identifier("toBe")
    ),
    [t.booleanLiteral(true)]
  );

  return [typeofAssertion, finiteAssertion];
}

function buildObjectShapeAssertions(expectArgNode) {
  const notNullish = buildNotNullishAssertions(expectArgNode);

  const objectAssertion = t.callExpression(
    t.memberExpression(
      t.callExpression(t.identifier("expect"), [
        t.unaryExpression("typeof", t.cloneNode(expectArgNode, true), true),
      ]),
      t.identifier("toBe")
    ),
    [t.stringLiteral("object")]
  );

  return [...notNullish, objectAssertion];
}

function buildArrayShapeAssertions(expectArgNode) {
  const notUndefined = t.callExpression(
    t.memberExpression(
      t.memberExpression(
        t.callExpression(t.identifier("expect"), [t.cloneNode(expectArgNode, true)]),
        t.identifier("not")
      ),
      t.identifier("toBeUndefined")
    ),
    []
  );

  const arrayAssertion = t.callExpression(
    t.memberExpression(
      t.callExpression(t.identifier("expect"), [
        t.callExpression(
          t.memberExpression(t.identifier("Array"), t.identifier("isArray")),
          [t.cloneNode(expectArgNode, true)]
        ),
      ]),
      t.identifier("toBe")
    ),
    [t.booleanLiteral(true)]
  );

  return [notUndefined, arrayAssertion];
}

function replaceExpressionWithMultipleStatements(innerPath, expressionNodes) {
  const statementPath = innerPath.getStatementParent?.();

  if (!statementPath || !statementPath.isExpressionStatement()) {
    return false;
  }

  statementPath.replaceWithMultiple(
    expressionNodes.map((expr) => t.expressionStatement(expr))
  );

  return true;
}

function isObjectOrArrayExpectedNode(node) {
  return t.isObjectExpression(node) || t.isArrayExpression(node);
}

function isPrimitiveExpectedNode(node) {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  );
}

function shouldUseShapeForExpectedNode(node) {
  if (t.isArrayExpression(node)) return "array";
  if (t.isObjectExpression(node)) return "object";
  return "";
}

/* ======================================================
   MAIN SEMANTIC REPAIR
====================================================== */
export function attemptSemanticRepair(originalCode, failure) {
  if (!failure) return null;

  // keep mock-heavy files untouched here
  if (originalCode.includes("jest.unstable_mockModule")) {
    return null;
  }

  let ast;
  try {
    ast = parseSource(originalCode);
  } catch {
    console.log("⚠️ Failed to parse test for semantic repair.");
    return null;
  }

  const failureType = getFailureType(failure);
  const errorMsg = normalizeErrorMessage(failure.errorMessage);
  const runtimeFlags = detectRuntimePatterns(errorMsg);
  const errorText = extractErrorText(failure);
  const receivedLiteral = extractReceivedLiteral(failure.errorMessage);

  let changed = false;

  traverse(ast, {
    CallExpression(path) {
      if (changed) {
        path.stop();
        return;
      }

      const callee = path.node.callee;

      // Only target test()/it()
      if (
        !t.isIdentifier(callee) ||
        !["test", "it"].includes(callee.name)
      ) {
        return;
      }

      const args = path.get("arguments");
      const testNamePath = args[0];
      const testFnPath = args[1];

      if (!testNamePath || !testFnPath) return;
      if (!testNamePath.isStringLiteral()) return;

      const currentTestName = testNamePath.node.value;

      if (!testNameMatches(failure.testName, currentTestName)) {
        return;
      }

      if (
        !testFnPath.isFunctionExpression() &&
        !testFnPath.isArrowFunctionExpression()
      ) {
        return;
      }

      testFnPath.traverse({
        CallExpression(innerPath) {
          if (changed) {
            innerPath.stop();
            return;
          }

          const node = innerPath.node;
          if (!isMatcherCall(node)) return;

          const structure = getOuterExpectStructure(node);
          if (!structure) return;

          const { matcherName, modifier, expectCall } = structure;

          let expectArgPath = null;

          if (modifier === "rejects" || modifier === "resolves" || modifier === "not") {
            const objectPath = innerPath.get("callee").get("object").get("object");
            if (objectPath && objectPath.isCallExpression()) {
              const args = objectPath.get("arguments");
              if (Array.isArray(args) && args.length > 0) {
                expectArgPath = args[0];
              }
            }
          } else {
            const args = innerPath.get("callee").get("object").get("arguments");
            if (Array.isArray(args) && args.length > 0) {
              expectArgPath = args[0];
            }
          }

          if (!expectArgPath) return;

          const recoveredCall = extractUnderlyingCall(expectArgPath);

          /* ==========================================
             1. FIX rejects misuse on an already-awaited value
             Preserve the original matcher/oracle; only restore the Promise.
          ========================================== */
          if (runtimeFlags.isRejectsMatcherMisuse && modifier === "rejects") {
            if (recoveredCall?.kind === "async-call") {
              innerPath.replaceWith(
                buildPromiseMatcherAssertion(
                  recoveredCall.callNode,
                  "rejects",
                  matcherName,
                  node.arguments
                )
              );
              changed = true;
              innerPath.stop();
              return;
            }

            if (
              recoveredCall?.kind === "sync-call" &&
              testNameSignalsErrorIntent(currentTestName)
            ) {
              innerPath.replaceWith(
                buildSyncThrowPreservingAssertion(
                  recoveredCall.callNode,
                  matcherName,
                  node.arguments
                )
              );
              changed = true;
              innerPath.stop();
              return;
            }
          }

          /* ==========================================
             2. FIX resolves misuse on an already-awaited value
             Preserve the exact original matcher/oracle.
          ========================================== */
          if (runtimeFlags.isResolvesMatcherMisuse && modifier === "resolves") {
            if (recoveredCall?.kind === "async-call") {
              innerPath.replaceWith(
                buildPromiseMatcherAssertion(
                  recoveredCall.callNode,
                  "resolves",
                  matcherName,
                  node.arguments
                )
              );
              changed = true;
              innerPath.stop();
              return;
            }
          }

          /* ==========================================
             3. FIX toThrow misuse against an executed call/value
             Keep the original error matcher arguments rather than inventing
             a new message.
          ========================================== */
          if (
            runtimeFlags.isToThrowMatcherMisuse &&
            ["toThrow", "toThrowError"].includes(matcherName)
          ) {
            if (recoveredCall?.kind === "sync-call") {
              innerPath.replaceWith(
                buildSyncThrowPreservingAssertion(
                  recoveredCall.callNode,
                  matcherName,
                  node.arguments
                )
              );
              changed = true;
              innerPath.stop();
              return;
            }

            if (recoveredCall?.kind === "async-call") {
              innerPath.replaceWith(
                buildPromiseMatcherAssertion(
                  recoveredCall.callNode,
                  "rejects",
                  matcherName,
                  node.arguments
                )
              );
              changed = true;
              innerPath.stop();
              return;
            }
          }

          /* ==========================================
             4. SAFE ASSERTION-SPECIFIC REPAIR
             Only touches test-side matcher/oracle shape.
          ========================================== */
          if (failureType === "ASSERTION" || runtimeFlags.isAssertionError) {
            const expectedArg = node.arguments?.[0];

            // expect(result).toBe({}) / toBe([]) -> toEqual(...)
            if (
              matcherName === "toBe" &&
              expectedArg &&
              isObjectOrArrayExpectedNode(expectedArg)
            ) {
              node.callee.property = t.identifier("toEqual");
              changed = true;
              innerPath.stop();
              return;
            }

            // expect(result).toEqual(primitive) -> toBe(primitive)
            if (
              (matcherName === "toEqual" || matcherName === "toStrictEqual") &&
              expectedArg &&
              isPrimitiveExpectedNode(expectedArg)
            ) {
              node.callee.property = t.identifier("toBe");
              changed = true;
              innerPath.stop();
              return;
            }

            // Numeric mismatch is intentionally NOT weakened to a type-only
            // assertion here. Exact runtime evidence is handled by the
            // evidence repair engine; otherwise the LLM/source-aware repair
            // must infer a truthful oracle.

            // expect(result).toBeDefined() but observed value is undefined -> assert the real void contract
            if (
              matcherName === "toBeDefined" &&
              runtimeFlags.isNullishOracleMismatch &&
              receivedLiteral === "undefined" &&
              modifier !== "not"
            ) {
              innerPath.replaceWith(buildToBeUndefinedAssertion(expectArgPath.node));
              changed = true;
              innerPath.stop();
              return;
            }

            // Exact/deep oracle expected a value, but the observed contract is void.
            if (
              ["toBe", "toEqual", "toStrictEqual"].includes(matcherName) &&
              runtimeFlags.isNullishOracleMismatch &&
              receivedLiteral === "undefined" &&
              modifier !== "not"
            ) {
              innerPath.replaceWith(buildToBeUndefinedAssertion(expectArgPath.node));
              changed = true;
              innerPath.stop();
              return;
            }
            // Do not weaken null/deep-equality failures into broad
            // not-null/type/shape assertions merely to make Jest green.
            // Concrete Received evidence is repaired exactly by
            // evidenceRepairEngine; otherwise leave the candidate for
            // source-aware/LLM repair.
          }

          /* ==========================================
             5. Generic runtime throw conversion
             Do not run this for normal assertion/oracle failures.
          ========================================== */
          const existingThrowIntent =
            ["toThrow", "toThrowError"].includes(matcherName) ||
            modifier === "rejects";

          const shouldConvertToThrow =
            !runtimeFlags.isAssertionError &&
            (existingThrowIntent || testNameSignalsErrorIntent(currentTestName)) &&
            (
              runtimeFlags.isDivisionError ||
              runtimeFlags.isUndefinedAccess ||
              runtimeFlags.isNullAccess ||
              runtimeFlags.isNaNError ||
              runtimeFlags.isTypeError ||
              runtimeFlags.isExplicitThrow ||
              failureType === "RUNTIME_THROW"
            );

          if (shouldConvertToThrow) {
            if (modifier === "rejects" && recoveredCall?.kind === "async-call") {
              innerPath.replaceWith(
                buildAsyncRejectThrowAssertion(recoveredCall.callNode, errorText)
              );
              changed = true;
              innerPath.stop();
              return;
            }

            if (recoveredCall?.kind === "sync-call") {
              innerPath.replaceWith(
                buildSyncThrowAssertion(recoveredCall.callNode, errorText)
              );
              changed = true;
              innerPath.stop();
              return;
            }

            if (recoveredCall?.kind === "async-call") {
              innerPath.replaceWith(
                buildAsyncRejectThrowAssertion(recoveredCall.callNode, errorText)
              );
              changed = true;
              innerPath.stop();
              return;
            }
          }

          /* ==========================================
             6. Reference errors
             Do not invent undefined bindings. Reference repairs require
             source/context evidence and are delegated to LLM repair.
          ========================================== */
        },
      });

      if (changed) {
        path.stop();
      }
    },
  });

  if (!changed) return null;

  const newCode = generate(ast).code;
  return validateSyntax(newCode) ? newCode : null;
}
