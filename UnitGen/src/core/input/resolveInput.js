import path from "path";
import fs from "fs";
import { collectJsFiles } from "./fileScanner.js";
import { pathExists, statSafe, isJsFile, hasPackageJson } from "./validators.js";

/*
 * Step 0 — Input selection & validation.
 *
 * Accepts: a JS file path or a folder path (small Node/JS project).
 * Returns an object:
 * {
 *   ok: boolean,
 *   kind: "file" | "folder",
 *   root: string,
 *   files: string[],
 *   messages: { level: "info"|"warn"|"error", text: string }[]
 * }
 */

export function resolveInput(userPath) {
  const messages = [];

  if (!userPath) {
    return {
      ok: false,
      kind: null,
      root: null,
      files: [],
      messages: [{ level: "error", text: "Missing path. Usage: node src/index.js <file-or-folder>" }],
    };
  }

  const normalized = path.resolve(userPath);

  if (!pathExists(normalized)) {
    return {
      ok: false,
      kind: null,
      root: null,
      files: [],
      messages: [{ level: "error", text: `Path does not exist: ${normalized}` }],
    };
  }

  const st = statSafe(normalized);
  if (!st) {
    return {
      ok: false,
      kind: null,
      root: null,
      files: [],
      messages: [{ level: "error", text: `Unable to access: ${normalized}` }],
    };
  }

  // Case A: Single file
  if (st.isFile()) {
    if (!isJsFile(normalized)) {
      return {
        ok: false,
        kind: "file",
        root: normalized,
        files: [],
        messages: [{ level: "error", text: `Not a .js file: ${normalized}` }],
      };
    }

    messages.push({ level: "info", text: `Input: JavaScript file (${normalized})` });
    return { ok: true, kind: "file", root: normalized, files: [normalized], messages };
  }

  // Case B: Folder (project)
  if (st.isDirectory()) {
    const files = collectJsFiles(normalized);

    if (files.length === 0) {
      return {
        ok: false,
        kind: "folder",
        root: normalized,
        files: [],
        messages: [{ level: "error", text: `No .js files found in folder: ${normalized}` }],
      };
    }

    if (hasPackageJson(normalized)) {
      messages.push({ level: "info", text: `Input: Node.js project folder (package.json found)` });
    } else {
      messages.push({ level: "warn", text: `No package.json found. Treating as a plain JS folder.` });
    }

    messages.push({ level: "info", text: `Discovered ${files.length} .js file(s).` });

    return { ok: true, kind: "folder", root: normalized, files, messages };
  }

  return {
    ok: false,
    kind: null,
    root: normalized,
    files: [],
    messages: [{ level: "error", text: `Unsupported path type: ${normalized}` }],
  };
}
