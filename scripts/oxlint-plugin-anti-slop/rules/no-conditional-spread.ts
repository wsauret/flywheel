import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

function unwrapParentheses(node: ESTree.Expression): ESTree.Expression {
  let current = node;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

// Flywheel narrows the fork's rule to `&&` spreads, whose falsy operand
// silently spreads as nothing. A ternary such as
// `...(x === undefined ? {} : { x })` names both outcomes and is Flywheel's
// standard way to omit an optional key, and `...(extra || {})` and
// `...(list ?? [])` name their fallback, so they stay allowed.
function isAndSpread(node: ESTree.Expression): boolean {
  const expression = unwrapParentheses(node);
  return expression.type === "LogicalExpression" && expression.operator === "&&";
}

/** Ban spreading `&&` expressions such as `...(flag && { a })` in every spread position. */
export const noConditionalSpreadRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow spreading `&&` expressions. Spread a ternary that names both outcomes, or build the value explicitly.",
    },
    messages: {
      avoid:
        "An `&&` spread hides which values or properties are present, and it spreads a falsy operand as nothing. Spread a ternary such as `...(x === undefined ? {} : { x })`, or build the value in separate statements.",
    },
  },
  createOnce(context) {
    return {
      SpreadElement(node) {
        if (isAndSpread(node.argument)) {
          context.report({ node, messageId: "avoid" });
        }
      },
      JSXSpreadAttribute(node) {
        if (isAndSpread(node.argument)) {
          context.report({ node, messageId: "avoid" });
        }
      },
    };
  },
});
