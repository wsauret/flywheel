import { stringLiteralValue } from "../utils.js";

const message =
  "Do not name a path under the literal `/tmp`. `bun run test` gives each test process a private TMPDIR and fails on what a test leaves there, and `/tmp` bypasses that guard. Create a real directory with `temporaryDirectories()` from tests/helpers/directories.ts, and write a fake path under a root that does not exist, such as `/scratch`. A Unix socket path that must stay under 104 bytes keeps `/tmp` with `// oxlint-disable-next-line flywheel/no-tmp-literal-path -- <reason>`.";

// A path literal is one whose whole value names `/tmp` or a path below it. A
// command or a message that only mentions `/tmp` in its middle is data, not a
// path the test can create.
const isTmpPath = (value) => value === "/tmp" || value.startsWith("/tmp/");

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow test paths under the literal /tmp root, which the test temporary-directory guard cannot see.",
    },
  },
  create(context) {
    return {
      Literal(node) {
        const value = stringLiteralValue(node);
        if (value !== undefined && isTmpPath(value)) context.report({ node, message });
      },
      StringLiteral(node) {
        if (isTmpPath(node.value)) context.report({ node, message });
      },
      TemplateLiteral(node) {
        if (isTmpPath(node.quasis[0]?.value.cooked ?? "")) context.report({ node, message });
      },
    };
  },
};
