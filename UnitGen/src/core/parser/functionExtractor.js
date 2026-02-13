/* 
This module does three things:
1) Parses code into AST (via parseSource)
2) Traverses the AST and captures functions
3) Detects exports (basic) and marks exported functions
*/

import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";
import { parseSource } from "./parseFile.js";

const traverse = traverseModule.default;
const generate = generatorModule.default;


// Extracts testable functions from JS source code
export function extractFunctions(code) {
    const ast = parseSource(code);
    const functions = [];

    traverse(ast, {
        FunctionDeclaration(path) {
            const name = path.node.id?.name ?? "anonymous_function";
            functions.push(buildFunctionRecord(path, name, "FunctionDeclaration"));
        },

        VariableDeclarator(path) {
            // Detect: const foo = (a,b) => {} or const foo = function(a,b) {}
            const id = path.node.id;
            const init = path.node.init;

            if (!id || id.type !== "Identifier" || !init) return;

            const isArrow = init.type === "ArrowFunctionExpression";
            const isFuncExpr = init.type === "FunctionExpression";

            if (isArrow || isFuncExpr) {
                const name = id.name;
                const kind = isArrow ? "ArrowFunction" : "FunctionExpression";
                functions.push(buildFunctionRecord(path.get("init"), name, kind));
            }
        },
    });

    // Mark exports (basic)
    markExports(ast, functions);

    return functions;
}

function buildFunctionRecord(path, name, kind) {
    const node = path.node;

    return {
        name,
        kind,
        params: node.params.map((p) => (p.type === "Identifier" ? p.name : "unknown")),
        loc: node.loc ? { start: node.loc.start.line, end: node.loc.end.line } : null,
        code: generate(node).code,
        exported: false,
    };
}

function markExports(ast, functions) {
    const exportedNames = new Set();

    traverse(ast, {
        ExportNamedDeclaration(path) {
            const decl = path.node.declaration;
            if (decl?.type === "FunctionDeclaration" && decl.id?.name) {
                exportedNames.add(decl.id.name);
            }
        },

        ExportDefaultDeclaration(path) {
            const decl = path.node.declaration;
            if (decl?.type === "FunctionDeclaration" && decl.id?.name) {
                exportedNames.add(decl.id.name);
            }
        },

        AssignmentExpression(path) {
            const left = path.node.left;

            if (
                left.type === "MemberExpression" &&
                left.object.type === "Identifier" &&
                left.object.name === "exports" &&
                left.property.type === "Identifier"
            ) {
                exportedNames.add(left.property.name);
            }
        },
    });

    for (const fn of functions) {
        if (exportedNames.has(fn.name)) fn.exported = true;
    }
}