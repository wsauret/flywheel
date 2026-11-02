import { stringLiteralValue } from "../utils.js";

const message =
  "Do not declare a SCREAMING_SNAKE constant whose value is its own name as a string; use the literal directly or a typed enum.";

// Biome's noShoutyConstants flags `const FOO = "FOO"` -- a screaming-snake binding
// whose string value is identical to its name. Such a constant is pure indirection:
// the literal already documents itself. We match the same shape by syntax.
const isScreamingSnake = (name) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(name);

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow SCREAMING_SNAKE constants whose value equals their own name.",
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id?.type !== "Identifier") return;
        const name = node.id.name;
        if (!isScreamingSnake(name)) return;
        if (stringLiteralValue(node.init) !== name) return;
        context.report({ node, message });
      },
    };
  },
};
