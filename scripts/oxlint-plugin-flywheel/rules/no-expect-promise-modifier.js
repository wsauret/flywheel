const message =
  "Do not wait on a promise with `expect(promise).rejects` or `.resolves`. Bun waits for the promise in a nested event loop, and that loop delivers no further read of a pipe this process already reads: a child's stdout, a Bun IPC channel, or a Windows named pipe on Windows, and a Worker or MessagePort message on every platform. A promise that waits on such a read never settles, and the test hangs past its own timeout. Await the promise plainly, then assert: `expect(await promise.catch((error: unknown) => error)).toHaveProperty(\"message\", expect.stringContaining(\"...\"))`, or `expect(await promise).toEqual(...)`. Prefer `toHaveProperty` to `toMatchObject` with an asymmetric matcher, which in Bun writes the matcher into the error it checks.";

const MODIFIERS = new Set(["rejects", "resolves"]);

const propertyName = (node) => (node.computed ? (node.property.type === "Literal" ? node.property.value : undefined) : node.property.name);

/** Whether `node` is `expect(...)`, also behind `.not`. */
function isExpectCall(node) {
  if (node.type === "MemberExpression" && propertyName(node) === "not") return isExpectCall(node.object);
  return node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "expect";
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `expect(promise).rejects` and `.resolves`, whose nested event loop stops delivering pipe and message reads, in the test tiers that run real processes.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (MODIFIERS.has(propertyName(node)) && isExpectCall(node.object)) context.report({ node: node.property, message });
      },
    };
  },
};
