// src/core/assertion/utils/valueExtractor.js

import * as t from "@babel/types";

/* ======================================================
   MAIN VALUE EXTRACTOR FROM AST NODE
====================================================== */

export function extractValue(node) {
  if (!node) return undefined;

  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;

  if (t.isBigIntLiteral?.(node)) {
    return { __type: "bigint", value: String(node.value) };
  }

  if (t.isRegExpLiteral?.(node)) {
    return {
      __type: "regexp",
      pattern: node.pattern,
      flags: node.flags || "",
    };
  }

  if (t.isUnaryExpression(node)) {
    const val = extractValue(node.argument);

    if (typeof val === "number") {
      if (node.operator === "-") return -val;
      if (node.operator === "+") return +val;
    }

    if (typeof val === "boolean" && node.operator === "!") {
      return !val;
    }

    return { __type: "dynamic", reason: "unary-expression" };
  }

  if (t.isTemplateLiteral(node)) {
    if (node.expressions.length === 0) {
      return node.quasis.map((q) => q.value.cooked || "").join("");
    }

    return { __type: "dynamic", reason: "template-expression" };
  }

  if (t.isArrayExpression(node)) {
    return node.elements.map((el) =>
      el ? extractValue(el) : { __type: "hole" }
    );
  }

  if (t.isObjectExpression(node)) {
    const obj = {};

    for (const prop of node.properties) {
      if (t.isSpreadElement(prop)) {
        return { __type: "dynamic", reason: "object-spread" };
      }

      if (!t.isObjectProperty(prop)) continue;

      if (prop.computed) {
        return { __type: "dynamic", reason: "computed-object-key" };
      }

      const key = getObjectKey(prop.key);
      const value = extractValue(prop.value);

      obj[key] = value;
    }

    return obj;
  }

  if (t.isIdentifier(node)) {
    if (node.name === "undefined") return undefined;
    if (node.name === "NaN") return Number.NaN;
    if (node.name === "Infinity") return Infinity;

    return { __type: "identifier", name: node.name };
  }

  if (t.isMemberExpression(node)) {
    return {
      __type: "dynamic",
      reason: "member-expression",
    };
  }

  if (
    t.isCallExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isFunctionExpression(node) ||
    t.isNewExpression(node) ||
    t.isConditionalExpression(node) ||
    t.isBinaryExpression(node) ||
    t.isLogicalExpression(node)
  ) {
    return { __type: "dynamic", reason: node.type };
  }

  return { __type: "unknown", nodeType: node.type };
}

export const extractValueFromNode = extractValue;

/* ======================================================
   HELPER — OBJECT KEY EXTRACTOR
====================================================== */

function getObjectKey(keyNode) {
  if (t.isIdentifier(keyNode)) return keyNode.name;
  if (t.isStringLiteral(keyNode)) return keyNode.value;
  if (t.isNumericLiteral(keyNode)) return String(keyNode.value);

  return "unknown";
}

/* ======================================================
   VALUE TYPE CHECKS
====================================================== */

export function isPrimitive(val) {
  return (
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "boolean" ||
    val === null
  );
}

export function isObject(val) {
  return (
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val) &&
    !val.__type
  );
}

export function isArray(val) {
  return Array.isArray(val);
}

export function isDynamic(val) {
  return val && val.__type === "dynamic";
}

export function isIdentifier(val) {
  return val && val.__type === "identifier";
}

export function isMetadataValue(val) {
  return Boolean(val && typeof val === "object" && val.__type);
}

/* ======================================================
   SAFE NODE BUILDER
====================================================== */

export function valueToNode(value) {
  if (value === undefined) return t.identifier("undefined");

  if (typeof value === "string") return t.stringLiteral(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return t.identifier("NaN");
    if (value === Infinity) return t.identifier("Infinity");
    if (value === -Infinity) {
      return t.unaryExpression("-", t.identifier("Infinity"));
    }

    return t.numericLiteral(value);
  }

  if (typeof value === "boolean") return t.booleanLiteral(value);
  if (value === null) return t.nullLiteral();

  if (Array.isArray(value)) {
    return t.arrayExpression(
      value.map((v) => {
        if (v && v.__type === "hole") return null;
        return valueToNode(v);
      })
    );
  }

  if (value && typeof value === "object" && value.__type) {
    if (value.__type === "bigint") {
      return t.bigIntLiteral(String(value.value));
    }

    if (value.__type === "regexp") {
      return t.regExpLiteral(value.pattern || "", value.flags || "");
    }

    if (value.__type === "identifier" && value.name) {
      return t.identifier(value.name);
    }

    return t.identifier("undefined");
  }

  if (typeof value === "object") {
    const props = Object.entries(value).map(([key, val]) => {
      const keyNode = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
        ? t.identifier(key)
        : t.stringLiteral(key);

      return t.objectProperty(keyNode, valueToNode(val));
    });

    return t.objectExpression(props);
  }

  return t.identifier("undefined");
}