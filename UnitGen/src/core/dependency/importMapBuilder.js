import traverseModule from "@babel/traverse";
import { parseSource } from "../parser/parseFile.js";

const traverse = traverseModule.default;

// It Scans the whole file and returns: localName -> moduleName
export function buildImportMap(code) {
    const ast = parseSource(code);

    // local identifier -> module string (e.g. axios -> "axios")
    const importMap = {};

    traverse(ast, {
        // Handles: import ... from "module"
        ImportDeclaration(path) {
            const moduleName = path.node.source.value; // e.g. "axios"

            for (const spec of path.node.specifiers) {
                // import axios from "axios"
                if (spec.type === "ImportDefaultSpecifier") {
                    importMap[spec.local.name] = moduleName;
                }

                // import { readFileSync } from "fs"
                if (spec.type === "ImportSpecifier") {
                    importMap[spec.local.name] = moduleName;
                }

                // import * as path from "path"
                if (spec.type === "ImportNamespaceSpecifier") {
                    importMap[spec.local.name] = moduleName;
                }
            }
        },

        // Handles: const x = require("module") and const {a} = require("module")
        VariableDeclarator(path) {
            const init = path.node.init;

            // Must be require("something")
            if (
                !init ||
                init.type !== "CallExpression" ||
                init.callee.type !== "Identifier" ||
                init.callee.name !== "require" ||
                init.arguments.length !== 1 ||
                init.arguments[0].type !== "StringLiteral"
            ) {
                return;
            }

            const moduleName = init.arguments[0].value; // e.g. "fs"
            const id = path.node.id;

            // const axios = require("axios")
            if (id.type === "Identifier") {
                importMap[id.name] = moduleName;
            }

            // const { readFileSync } = require("fs")
            if (id.type === "ObjectPattern") {
                for (const prop of id.properties) {
                    // handles: { readFileSync } or { readFileSync: rfs }
                    if (prop.type === "ObjectProperty") {
                        if (prop.value.type === "Identifier") {
                            importMap[prop.value.name] = moduleName;
                        }
                    }
                }
            }
        },
    });

    return importMap;
}
