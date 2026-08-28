// src/core/repair/failureClassifier.js

import { parseJestFailureEvidence } from "./failureEvidence.js";

function classifyFailure(errorText = "") {
  const raw = String(errorText || "");
  const text = raw.toLowerCase();
  const evidence = parseJestFailureEvidence(raw);

  if (
    evidence.isSyntaxError ||
    text.includes("unexpected identifier") ||
    text.includes("unexpected end of input") ||
    text.includes("missing )") ||
    text.includes("missing ]") ||
    text.includes("missing }")
  ) {
    return { errorType: "SYNTAX_ERROR", failureType: "SYNTAX", evidence };
  }

  if (evidence.isReferenceError) {
    return { errorType: "REFERENCE_ERROR", failureType: "REFERENCE", evidence };
  }

  if (
    text.includes("cannot find module") ||
    text.includes("module not found") ||
    text.includes("cannot resolve module") ||
    text.includes("err_module_not_found")
  ) {
    return { errorType: "IMPORT_ERROR", failureType: "IMPORT", evidence };
  }

  if (evidence.timeout) {
    return { errorType: "TIMEOUT_ERROR", failureType: "TIMEOUT", evidence };
  }

  if (
    evidence.promiseResolvedInsteadOfRejected ||
    evidence.promiseRejectedInsteadOfResolved ||
    evidence.receivedMustBePromise ||
    text.includes(".rejects") ||
    text.includes(".resolves") ||
    text.includes("rejected promise")
  ) {
    return { errorType: "ASYNC_ERROR", failureType: "ASYNC", evidence };
  }

  // Assertion classification must precede generic TypeError/runtime-throw
  // classification because Jest assertion stacks often contain Error/TypeError
  // words that describe the matcher rather than the package behavior.
  if (evidence.isAssertion) {
    return { errorType: "ASSERTION_ERROR", failureType: "ASSERTION", evidence };
  }

  if (evidence.fsCode) {
    return {
      errorType: "FILESYSTEM_ERROR",
      failureType: "FILESYSTEM",
      evidence,
    };
  }

  if (evidence.isTypeError) {
    return { errorType: "TYPE_ERROR", failureType: "TYPE", evidence };
  }

  if (
    text.includes("error:") ||
    text.includes("thrown:") ||
    text.includes("uncaught") ||
    text.includes("division by zero")
  ) {
    return {
      errorType: "UNEXPECTED_THROW",
      failureType: "RUNTIME_THROW",
      evidence,
    };
  }

  return {
    errorType: "UNKNOWN_ERROR",
    failureType: "UNKNOWN",
    evidence,
  };
}

export { classifyFailure };
