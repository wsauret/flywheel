import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { compileOutput } from "../../../../src/workflows/output-contract/compile.js";
import type { OutputObject } from "../../../../src/workflows/output-contract/grammar.js";
import type { CommandRun, PayloadOf, StepPayload } from "../../../../src/workflows/output-contract/types.js";

/** True only when the two types are identical. */
type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false;

function assertType<Check extends true>(): Check | undefined {
  return undefined;
}

const reviewContract = {
  commands: { min: 1 },
  fields: {
    verdict: { type: "enum", values: ["pass", "fail"], description: "The verdict." },
    reason: { type: "string", nullable: true, description: "Why." },
    score: { type: "number", optional: true, description: "A score." },
    report: { type: "path", description: "The report." },
    findings: {
      type: "list",
      description: "Findings.",
      of: {
        type: "variant",
        tag: "kind",
        cases: {
          bug: { file: { type: "path", description: "The file." } },
          style: { note: { type: "string", description: "The note." }, blocking: { type: "boolean", description: "Blocks?" } },
        },
      },
    },
    meta: { type: "object", optional: true, description: "Meta.", fields: { tags: { type: "list", of: { type: "string" }, description: "Tags." } } },
  },
} as const satisfies OutputObject;

type ReviewPayload = PayloadOf<typeof reviewContract>;

describe("PayloadOf", () => {
  test("maps a TS-literal contract to its payload type", () => {
    assertType<Equal<ReviewPayload, {
      readonly summary: string;
      readonly files_modified?: readonly string[];
      readonly commands_run: readonly CommandRun[];
      readonly verdict: "pass" | "fail";
      readonly reason: string | null;
      readonly report: string;
      readonly findings: readonly (
        | { readonly kind: "bug"; readonly file: string }
        | { readonly kind: "style"; readonly note: string; readonly blocking: boolean }
      )[];
      readonly score?: number;
      readonly meta?: { readonly tags: readonly string[] };
    }>>();
    assertType<Equal<CommandRun, {
      readonly toolUseId: string;
      readonly exitCode: number;
      readonly observation: string;
      readonly command: string;
      readonly cwd?: string;
      readonly changedAfter?: readonly string[];
    }>>();
    expect(true).toBe(true);
  });

  test("gives the envelope alone to an absent contract, and summary plus fields to a file contract", () => {
    const absent = {} as const satisfies OutputObject;
    assertType<Equal<PayloadOf<typeof absent>, { readonly summary: string; readonly files_modified?: readonly string[]; readonly commands_run?: readonly CommandRun[] }>>();
    const fileContract = { submit: "file", fields: { phases: { type: "list", of: { type: "string" }, description: "Phases." } } } as const satisfies OutputObject;
    assertType<Equal<PayloadOf<typeof fileContract>, { readonly summary: string; readonly phases: readonly string[] }>>();
    assertType<Equal<PayloadOf<OutputObject>, StepPayload>>();
    expect(true).toBe(true);
  });

  test("the compiled schema decodes to PayloadOf with no cast at the use site", () => {
    const compiled = compileOutput(reviewContract);
    const payload = Schema.decodeUnknownSync(compiled.schema)({
      summary: "Reviewed.",
      commands_run: [{ toolUseId: "toolu_1", exitCode: 0, observation: "ok", command: "bun test" }],
      verdict: "fail",
      reason: null,
      report: "docs/review.md",
      findings: [{ kind: "style", note: "rename", blocking: false }],
    });
    assertType<Equal<typeof payload, ReviewPayload>>();
    const blocking = payload.findings.flatMap((finding) => (finding.kind === "style" ? [finding.blocking] : []));
    expect(payload.verdict).toBe("fail");
    expect(blocking).toEqual([false]);
  });
});
