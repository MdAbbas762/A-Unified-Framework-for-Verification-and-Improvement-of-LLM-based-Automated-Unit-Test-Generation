import { parse } from "@babel/parser";

// It Converts JavaScript source code string into an AST
export function parseSource(code) {
  return parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });
}