import fs from "fs";
import path from "path";

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "out",
]);

/**
 * Recursively collect JS source files from a folder.
 * - Includes: .js (prototype scope)
 * - Skips common heavy/irrelevant dirs (node_modules, dist, etc.)
 */

export function collectJsFiles(rootDir, options = {}) {
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const exts = options.exts ?? [".js"];

  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name)) continue;
        walk(full);
        continue;
      }

      if (!ent.isFile()) continue;

      const ext = path.extname(ent.name).toLowerCase();
      if (exts.includes(ext)) files.push(full);
    }
  }

  walk(rootDir);
  return files;
}
