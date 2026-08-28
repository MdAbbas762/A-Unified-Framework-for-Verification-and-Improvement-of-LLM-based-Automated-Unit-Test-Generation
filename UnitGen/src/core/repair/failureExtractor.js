// src/core/repair/failureExtractor.js

import path from "path";
import { classifyFailure } from "./failureClassifier.js";

function normalizeTestFilePath(filePath) {
  if (!filePath) return "";
  return path.normalize(String(filePath).trim());
}

function buildFailureFingerprint(
  testName,
  errorType,
  failureType,
  filePath,
  evidence = {}
) {
  return [
    String(testName || "UNKNOWN_TEST"),
    String(errorType || "UNKNOWN_ERROR"),
    String(failureType || "UNKNOWN"),
    String(evidence?.matcher || ""),
    String(evidence?.fsCode || ""),
    String(filePath || "UNKNOWN_FILE"),
  ].join("::");
}

function collectSuiteLevelFailureMessages(suite) {
  const messages = [];

  if (suite?.message) messages.push(String(suite.message));

  if (Array.isArray(suite?.failureMessage)) {
    messages.push(...suite.failureMessage.map(String));
  } else if (suite?.failureMessage) {
    messages.push(String(suite.failureMessage));
  }

  if (typeof suite?.testExecError === "string") {
    messages.push(suite.testExecError);
  } else if (suite?.testExecError?.message) {
    messages.push(String(suite.testExecError.message));
  }

  return messages.join("\n").trim();
}

function makeFailure({
  testName,
  filePath,
  errorMessage,
  title = "",
  fullName = "",
  ancestorTitles = [],
}) {
  const classification = classifyFailure(errorMessage);

  return {
    testName,
    title,
    fullName,
    ancestorTitles,
    filePath,
    errorMessage,
    errorType: classification.errorType,
    failureType: classification.failureType,
    evidence: classification.evidence || {},
    fingerprint: buildFailureFingerprint(
      testName,
      classification.errorType,
      classification.failureType,
      filePath,
      classification.evidence
    ),
  };
}

function extractFailures(jestJson = {}) {
  const failures = [];
  const suites = Array.isArray(jestJson.testResults) ? jestJson.testResults : [];

  for (const suite of suites) {
    const normalizedFilePath = normalizeTestFilePath(suite.name);
    const testCases = Array.isArray(suite?.assertionResults)
      ? suite.assertionResults
      : [];

    const suiteLevelMessage = collectSuiteLevelFailureMessages(suite);

    if (suiteLevelMessage && testCases.length === 0) {
      failures.push(
        makeFailure({
          testName: "SUITE_LOAD_ERROR",
          filePath: normalizedFilePath,
          errorMessage: suiteLevelMessage,
        })
      );
    }

    for (const testCase of testCases) {
      if (testCase.status !== "failed") continue;

      const failureMessages = Array.isArray(testCase.failureMessages)
        ? testCase.failureMessages
        : [];

      const cleanedError =
        failureMessages.join("\n").trim() ||
        suiteLevelMessage ||
        "Unknown Jest failure";

      const fullName = testCase.fullName || testCase.title || "UNKNOWN_TEST";

      failures.push(
        makeFailure({
          testName: fullName,
          title: testCase.title || "",
          fullName,
          ancestorTitles: Array.isArray(testCase.ancestorTitles)
            ? testCase.ancestorTitles
            : [],
          filePath: normalizedFilePath,
          errorMessage: cleanedError,
        })
      );
    }
  }

  return failures;
}

export {
  extractFailures,
  normalizeTestFilePath,
  buildFailureFingerprint,
};
