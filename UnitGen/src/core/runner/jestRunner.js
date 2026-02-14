import { spawn } from "child_process";
import fs from "fs";
import path from "path";

/**
 * Prefer running Jest via its JS entrypoint using Node.
 * This avoids Windows spawn issues with .cmd (EINVAL).
 */
function getJestJsEntrypoint() {
  // node_modules/jest/bin/jest.js
  return path.join(process.cwd(), "node_modules", "jest", "bin", "jest.js");
}

export async function runJest({ configPath = "jest.config.js" } = {}) {
  const jestJs = getJestJsEntrypoint();
  const outputFile = path.join(
    process.cwd(),
    "tests",
    "generated",
    ".jest-results.json"
  );

  // If Jest isn't installed, fail gracefully
  if (!fs.existsSync(jestJs)) {
    return {
      exitCode: 1,
      json: null,
      stdout: "",
      stderr:
        "Jest entrypoint not found. Make sure jest is installed (npm install).",
      outputFile,
    };
  }

  // Clean old output if present
  try {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  } catch (_) { }

  const args = [
    "--experimental-vm-modules",
    jestJs,
    "--config",
    configPath,
    "--json",
    "--outputFile",
    outputFile,
    "--runInBand",
  ];


  // Run: node <jest.js> ...
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  let json = null;
  try {
    if (fs.existsSync(outputFile)) {
      json = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
    }
  } catch (_) {
    json = null;
  }

  return { exitCode, json, stdout, stderr, outputFile };
}