import fs from "fs";
import path from "path";

export function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function isJsFile(p) {
  return path.extname(p).toLowerCase() === ".js";
}

export function hasPackageJson(dir) {
  try {
    return fs.existsSync(path.join(dir, "package.json"));
  } catch {
    return false;
  }
}
