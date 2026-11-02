import { getPropertyName, isIdentifier } from "../utils.js";

// effect@4.0.0-beta.84 dropped or renamed these v3 members. The replacements are
// audited against node_modules/effect/dist/Effect.d.ts: each banned name is absent
// there and each suggested name is present. Re-audit when the effect version bumps.
const unsupported = new Map([
  [
    "async",
    "Effect.async was renamed; use Effect.callback for callback/promise adapters in effect@4.",
  ],
  ["zipRight", "Effect.zipRight is gone in effect@4; use Effect.andThen or Effect.gen sequencing."],
  ["zipLeft", "Effect.zipLeft is gone in effect@4; use Effect.tap or Effect.gen sequencing."],
  ["timeoutFail", "Effect.timeoutFail is gone in effect@4; use Effect.timeoutOrElse."],
  ["orDieWith", "Effect.orDieWith is gone in effect@4; map the error then use Effect.orDie."],
  ["dieMessage", "Effect.dieMessage is gone in effect@4; use Effect.die(new Error(message))."],
]);

const message = (name) => unsupported.get(name);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect members that no longer exist in effect@4.0.0-beta.84.",
    },
  },
  // No import-source guard: it matches any `Effect.<member>` access by syntax. Scoping
  // the rule to the Effect-owned dirs in oxlint.config.ts keeps it from firing on an
  // unrelated local binding named `Effect` outside the Effect surface.
  create(context) {
    return {
      MemberExpression(node) {
        if (!isIdentifier(node.object, "Effect")) return;
        const property = getPropertyName(node.property);
        if (!unsupported.has(property)) return;
        context.report({ node, message: message(property) });
      },
    };
  },
};
