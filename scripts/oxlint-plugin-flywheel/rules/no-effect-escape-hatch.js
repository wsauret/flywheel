import { getPropertyName, isIdentifier, isTestLike, unwrapExpression } from "../utils.js";

// dieMessage/orDieWith are removed in effect@4 and owned by no-unsupported-effect-api;
// the survivors die/orDie are the escape hatches this rule guards against.
const escapeHatches = new Set(["die", "orDie"]);

const message =
  "Do not collapse Effect failures with die/orDie escape hatches. Keep typed errors in the Effect error channel; at a true runtime edge use a narrow suppression that explains the boundary.";

const isEffectEscapeHatch = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression") return false;
  if (!isIdentifier(unwrapExpression(expression.object), "Effect")) return false;
  return escapeHatches.has(getPropertyName(expression.property));
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect die/orDie escape hatches outside test code.",
    },
  },
  create(context) {
    if (isTestLike(context.filename)) return {};

    return {
      MemberExpression(node) {
        if (isEffectEscapeHatch(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};
