import fs from "fs";
import path from "path";

/**
 * Build a clean, lecturer-friendly report from Jest JSON output.
 * @param {object} jestJson - Jest JSON output object
 * @returns {object} final report object
 */
export function buildFinalReport(jestJson) {
  const totalTests = jestJson?.numTotalTests ?? 0;
  const passedTests = jestJson?.numPassedTests ?? 0;
  const failedTestsCount = jestJson?.numFailedTests ?? 0;

  const failedTests = [];

  const testResults = Array.isArray(jestJson?.testResults) ? jestJson.testResults : [];
  for (const suite of testResults) {
    const testFile = suite?.name ?? "";

    const assertions = Array.isArray(suite?.assertionResults) ? suite.assertionResults : [];
    for (const a of assertions) {
      if (a?.status === "failed") {
        const msgs = Array.isArray(a?.failureMessages) ? a.failureMessages : [];
        const errorMessage = msgs.length
          ? String(msgs[0]).split("\n").slice(0, 6).join("\n") // keep short
          : "Unknown test failure";

        failedTests.push({
          testFile,
          testName: a?.fullName ?? a?.title ?? "Unnamed test",
          errorMessage,
        });
      }
    }

    // Also capture suite-level runtime errors
    const suiteMsgs = Array.isArray(suite?.message) ? suite.message : suite?.message;
    if (suite?.status === "failed" && suiteMsgs) {
      // Jest sometimes puts runtime errors in `message` string on the suite
      failedTests.push({
        testFile,
        testName: "Suite runtime error",
        errorMessage: String(suiteMsgs).split("\n").slice(0, 8).join("\n"),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalTests,
      passedTests,
      failedTests: failedTestsCount,
    },
    failedTests,
  };
}

/**
 * Write the final report JSON to output/final-report.json
 * @param {object} jestJson
 * @param {string} outPath
 * @returns {string} absolute output file path
 */
export function writeFinalReport(jestJson, outPath = "output/final-report.json") {
  const report = buildFinalReport(jestJson);

  const absOut = path.resolve(outPath);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, JSON.stringify(report, null, 2), "utf8");

  return absOut;
}
