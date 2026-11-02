import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/** `src/protocol/` is the published client contract (ARCH-PROTOCOL-003), and not every
 *  client runs on Bun: the editor client hosts this protocol inside a Node
 *  extension host. A protocol module that reaches a Bun API is unusable there,
 *  and the failure is not a type error. It is a module-load throw on the first
 *  `bun:sqlite` import that the whole client falls over on.
 *
 *  The reach is easy to reintroduce and invisible in review, because it travels
 *  through one innocent-looking value import. Sourcing a module id from the
 *  registry rather than the vocabulary once pulled the file tools and their Bun
 *  bindings behind the wire schema: 247 modules where 20 belong.
 *
 *  So the closure itself is the assertion, over the whole package: every module
 *  in `src/protocol/` is an entry. The layer test reads the import graph as
 *  written (type-only included), because the layer rule is about what a file
 *  names, and the Bun test walks the value-import graph the way a bundler does,
 *  counting only imports that survive to runtime. */

const SRC = resolve(import.meta.dir, "../../../src");
const PROTOCOL = `${SRC}/protocol`;

const PROTOCOL_ENTRIES = readdirSync(PROTOCOL, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => resolve(entry.parentPath, entry.name));

/** Bun's global and its built-in module namespace. A client on another runtime
 *  has neither. */
const BUN_REACH = /\bBun\.|from\s+["']bun:/;

/** `import type {...}` is erased wholesale. `import { type A }` is not: it
 *  leaves `import {} from "m"`, which still loads the module and everything it
 *  imports. That distinction is the whole point of the walk, and oxlint's
 *  no-import-type-side-effects rule is what keeps the second form out of the
 *  tree in the first place. */
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^"';]*?from\s+["']([^"']+)["']/g;
const TYPE_ONLY = /(?:^|\n)\s*(?:import|export)\s+type\s/;

function resolveRelative(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function valueImportClosure(entries: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      if (TYPE_ONLY.test(match[0])) continue;
      const target = resolveRelative(match[1] ?? "", file);
      if (target !== null) pending.push(target);
    }
  }
  return [...seen];
}

describe("protocol package closure", () => {
  test("names no module above its layer, so the contract stays independently compilable", () => {
    const forbidden = ["workflows/", "orchestration/", "tui/", "cli/"].map((layer) => `${SRC}/${layer}`);
    const offenders: string[] = [];
    for (const file of PROTOCOL_ENTRIES) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT)) {
        const target = resolveRelative(match[1] ?? "", file);
        if (target === null) continue;
        if (forbidden.some((layer) => target.startsWith(layer))) {
          offenders.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
        }
      }
    }
    expect(offenders.toSorted()).toEqual([]);
  });

  test("reaches no Bun API, so a non-Bun client can host the protocol", () => {
    const offenders = valueImportClosure(PROTOCOL_ENTRIES)
      .filter((file) => BUN_REACH.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .toSorted();
    expect(offenders).toEqual([]);
  });

  test("a module's protocol home reaches only the generic contract: its value closure is itself plus protocol-module", () => {
    // The view carries plain data derived from session facts. Its schemas
    // must not pull orchestration types or infra helpers behind the wire.
    for (const id of ["experiments", "papercuts"]) {
      const entry = `${PROTOCOL}/modules/${id}.ts`;
      expect(valueImportClosure([entry]).map((file) => relative(SRC, file).replaceAll("\\", "/")).toSorted()).toEqual([`protocol/modules/${id}.ts`, "protocol/protocol-module.ts"]);
    }
  });

  test("keeps a reviewed foundation footprint behind every protocol entry", () => {
    // New contract modules are deliberate roots, not dependency expansion.
    // Pin their transitive foundation footprint so a new dependency or a
    // same-count substitution requires review before it reaches a Bun API.
    const roots = new Set(PROTOCOL_ENTRIES);
    expect(valueImportClosure(PROTOCOL_ENTRIES)
      .filter((file) => !roots.has(file))
      .map((file) => relative(SRC, file).replaceAll("\\", "/"))
      .toSorted()).toEqual([
        "infra/backoff.ts",
        "infra/canonical-name.ts",
        "infra/chat-input-schema.ts",
        "infra/error-message.ts",
        "infra/error-presentation.ts",
        "infra/invariant.ts",
        "infra/llm/model-id.ts",
        "infra/llm/provider-options.ts",
        "infra/llm/subscription-usage.ts",
        "infra/llm/usage-entry.ts",
        "infra/mutation-evidence-schema.ts",
        "infra/not-applied-files.ts",
        "infra/notification-episode.ts",
        "infra/output-blocks.ts",
        "infra/output/run-labels.ts",
        "infra/record.ts",
        "infra/redact-secrets.ts",
        "infra/role-settings.ts",
        "infra/session-content-schema.ts",
        // Reviewed: a client names the chat it opens with the one session id
        // allocator, which needs only the Web Crypto global.
        "infra/session-id.ts",
        "infra/session-workflow-membership.ts",
        "infra/skill-id.ts",
        "infra/summary-line.ts",
        "infra/tool-result-action.ts",
        "infra/update/version-order.ts",
        "infra/update/wrapper-directory.ts",
        "infra/with-deadline.ts",
        "infra/workflow-identifiers.ts",
        "infra/workflow-types.ts",
      ]);
  });
});
