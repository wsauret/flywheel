import { isTestLike } from "../utils.js";

const suppressionPattern = /\b(?:eslint|oxlint)-disable(?:-next-line|-line)?\b/;
const reasonPattern = /\s--\s+\S/;
const message =
  "Lint suppressions must stay on one line and include `-- <reason>` so the exceptional invariant remains inspectable.";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require an inline reason on every production lint suppression.",
    },
  },
  create(context) {
    if (isTestLike(context.filename)) return {};

    return {
      Program(node) {
        for (const comment of node.comments) {
          if (!suppressionPattern.test(comment.value)) continue;
          if (!comment.value.includes("\n") && reasonPattern.test(comment.value)) continue;
          context.report({ node: comment, message });
        }
      },
    };
  },
};
