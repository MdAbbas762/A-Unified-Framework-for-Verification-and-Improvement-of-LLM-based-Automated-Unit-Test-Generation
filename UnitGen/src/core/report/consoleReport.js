export function formatJestSummary(jestJson) {
  if (!jestJson) {
    return {
      totalTests: 0,
      passed: 0,
      failed: 0,
      totalSuites: 0,
      failedSuites: 0,
      details: [],
      suiteErrors: [],
      note: "No Jest JSON output found.",
    };
  }

  const totalTests = jestJson.numTotalTests ?? 0;
  const passed = jestJson.numPassedTests ?? 0;
  const failed = jestJson.numFailedTests ?? 0;

  const totalSuites = jestJson.numTotalTestSuites ?? 0;
  const failedSuites = jestJson.numFailedTestSuites ?? 0;

  const details = [];
  const suiteErrors = [];

  const testResults = jestJson.testResults ?? [];
  for (const fileResult of testResults) {
    // If the file failed to run/load, Jest often puts the error in fileResult.message
    if (fileResult.status === "failed" && fileResult.message) {
      suiteErrors.push({
        file: fileResult.name || fileResult.testFilePath || "Unknown file",
        error: shorten(fileResult.message),
      });
    }

    const assertionResults = fileResult.assertionResults ?? [];
    for (const a of assertionResults) {
      const status = (a.status || "").toUpperCase();
      const name = a.fullName || a.title || "Unnamed test";

      if (status === "FAILED") {
        const msg =
          a.failureMessages && a.failureMessages[0]
            ? a.failureMessages[0]
            : "Unknown error";
        details.push({ test: name, status: "FAIL", error: shorten(msg) });
      } else {
        details.push({ test: name, status: "PASS" });
      }
    }
  }

  const note =
    totalTests === 0 && (failedSuites > 0 || suiteErrors.length > 0)
      ? "0 tests collected because one or more test files failed to load (often due to import/export errors)."
      : undefined;

  return { totalTests, passed, failed, totalSuites, failedSuites, details, suiteErrors, note };
}

function shorten(text, max = 220) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 3) + "...";
}

export function printReport(summary) {
  console.log("\n==================== UnitGen Test Report ====================");
  console.log(`Total Test Suites : ${summary.totalSuites ?? 0}`);
  console.log(`Failed Suites     : ${summary.failedSuites ?? 0}`);
  console.log(`Total Tests       : ${summary.totalTests}`);
  console.log(`Passed            : ${summary.passed}`);
  console.log(`Failed            : ${summary.failed}`);

  if (summary.note) console.log(`Note              : ${summary.note}`);

  if (summary.suiteErrors?.length) {
    console.log("------------------------------------------------------------");
    console.log("❌ Suite Load/Runtime Errors:");
    for (const e of summary.suiteErrors) {
      console.log(`- ${e.file}`);
      console.log(`  ${e.error}`);
    }
  }

  console.log("------------------------------------------------------------");
  for (const d of summary.details) {
    if (d.status === "PASS") console.log(`✅ PASS  - ${d.test}`);
    else {
      console.log(`❌ FAIL  - ${d.test}`);
      console.log(`   Error: ${d.error}`);
    }
  }
  console.log("============================================================\n");
}