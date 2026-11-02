import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { findUnsafeCasts } from "../../../scripts/check-safety-comments.js";

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true });
});

async function check(source: string, extension = ".ts"): Promise<{ kind: string; line: number }[]> {
  const file = path.join(os.tmpdir(), `flywheel-safety-${crypto.randomUUID()}${extension}`);
  fs.writeFileSync(file, source);
  tempFiles.push(file);
  return (await findUnsafeCasts(file)).map(({ kind, line }) => ({ kind, line }));
}

describe("check-safety-comments", () => {
  it("flags every disallowed assertion form", async () => {
    expect(await check([
      "const a = value as Value;",
      "const b = value!;",
      "const c = <Value>value;",
    ].join("\n"))).toEqual([
      { kind: "as", line: 1 },
      { kind: "non-null", line: 2 },
      { kind: "angle-cast", line: 3 },
    ]);
  });

  it("ignores allowed syntax that resembles assertions", async () => {
    expect(await check([
      "const a = value as const;",
      "const b = value satisfies Value;",
      "const c = !value;",
      "const d = value != other;",
    ].join("\n"))).toEqual([]);
  });

  it("honors leading and trailing SAFETY comments on nodes and statements", async () => {
    expect(await check([
      "// SAFETY: boundary validation proves the shape.",
      "const a = value as Value;",
      "",
      "const b = value!; // SAFETY: collection length was checked.",
      "",
      "// SAFETY: discriminant narrows the nested expression.",
      "const c = wrap(value as Value);",
    ].join("\n"))).toEqual([]);
  });

  it("parses assertions inside TSX without confusing JSX", async () => {
    expect(await check([
      "const view = <box>{value as Value}</box>;",
      "// SAFETY: the ref callback receives a TextRenderable.",
      "const safe = <text ref={(node) => use(node as TextRenderable)} />;",
    ].join("\n"), ".tsx")).toEqual([{ kind: "as", line: 1 }]);
  });
});
