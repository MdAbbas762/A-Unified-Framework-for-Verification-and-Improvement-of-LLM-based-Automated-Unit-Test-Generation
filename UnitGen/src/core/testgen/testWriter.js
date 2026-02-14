import fs from "fs";
import path from "path";

/**
 * Writes test content into tests/generated/<fnName>.test.js
 * Creates directory if missing.
 */
export function writeGeneratedTest(fnName, content) {
  const outDir = path.join("tests", "generated");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outFile = path.join(outDir, `${fnName}.test.js`);
  fs.writeFileSync(outFile, content, "utf8");

  return outFile;
}
