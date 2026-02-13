/*
Returns "builtin" if moduleName is a Node.js built-in module, else "external".
Examples:
- "fs"   -> builtin
- "path" -> builtin
- "axios"-> external
*/

import { builtinModules } from "node:module";

export function classifyModule(moduleName) {
    // Node may represent builtins as "fs" and also as "node:fs"
    const normalized = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName;

    if (builtinModules.includes(normalized)) return "builtin";

    return "external";
}
