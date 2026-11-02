import { describe, expect, it } from "bun:test";

import { benchmarkDisplay } from "../../../../src/infra/tools/displays/benchmark.js";
import type { ToolPresentationResolution } from "../../../../src/infra/tools/types.js";

/** The row a turn renders for one benchmark call, from the tool input exactly as
 *  the tool schema documents it: `{ model, effort }` seats and a camelCase
 *  `resultId`. */
function present(input: { [key: string]: unknown }): ToolPresentationResolution {
  const resolve = benchmarkDisplay.getPresentation;
  if (!resolve) throw new Error("the benchmark display resolves no presentation");
  return resolve(input, "/project");
}

describe("benchmark tool display", () => {
  it("names the persona and every seat of a run", () => {
    expect(present({
      action: "run",
      persona: "explorer",
      variants: [{ model: "gpt-6-astra", effort: "medium" }, { model: "claude-opus-5", effort: "high" }],
      repeats: 1,
      dryRun: false,
    })).toEqual({ name: "Benchmark", detail: "explorer: gpt-6-astra@medium vs claude-opus-5@high" });
  });

  it("names the persona alone while the seats are still streaming in", () => {
    expect(present({ action: "run", persona: "explorer" })).toEqual({ name: "Benchmark", detail: "explorer" });
    expect(present({ action: "run" })).toBe("input_not_ready");
  });

  it("names the material run parameters: repeats above one and a dry run", () => {
    expect(present({
      action: "run",
      persona: "implementer",
      variants: [{ model: "gpt-6-luna", effort: "max" }],
      repeats: 3,
      dryRun: true,
    })).toEqual({ name: "Benchmark", detail: "implementer: gpt-6-luna@max x3 (dry run)" });
  });

  it("names the results directory a resume continues, and whether it is a dry run", () => {
    expect(present({ action: "resume", resultId: "explorer-2026-08-08T04-50-28-280Z", dryRun: false }))
      .toEqual({ name: "Resume Benchmark", detail: "explorer-2026-08-08T04-50-28-280Z" });
    expect(present({ action: "resume", resultId: "explorer-2026-08-08T04-50-28-280Z", dryRun: true }))
      .toEqual({ name: "Resume Benchmark", detail: "explorer-2026-08-08T04-50-28-280Z (dry run)" });
    expect(present({ action: "resume", dryRun: false })).toBe("input_not_ready");
  });
});
