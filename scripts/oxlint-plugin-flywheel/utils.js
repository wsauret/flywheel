import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function toRepoRelative(filename) {
  return path.relative(repoRoot, path.resolve(filename)).split(path.sep).join("/");
}

export function isTestLike(filename) {
  const normalized = toRepoRelative(filename);
  return /\.test\.tsx?$/.test(normalized) || normalized.startsWith("tests/");
}

export function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

// oxlint's parser emits string literals as either `Literal` (with a string
// value) or `StringLiteral`, depending on context; normalize both to the value.
export function stringLiteralValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "StringLiteral") return node.value;
  return undefined;
}

export function getPropertyName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateIdentifier") return node.name;
  return stringLiteralValue(node);
}

export function isIdentifier(node, name) {
  return node?.type === "Identifier" && (name === undefined || node.name === name);
}

export function getCallName(node) {
  const expression = unwrapExpression(node);
  if (expression?.type === "Identifier") return expression.name;
  if (expression?.type === "MemberExpression") return getPropertyName(expression.property);
  return undefined;
}
