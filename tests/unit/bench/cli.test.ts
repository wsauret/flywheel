import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { main as personaMain, parseArgs as parsePersonaArgs } from "../../../bench/ab-persona/bench.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { testCapabilityModules } from "../../helpers/provider-authority.js";

const RESULTS_DIR = resolve("/scratch/results/explorer-run");

describe("persona benchmark CLI", () => {
  it("names the results directory for resume and rescore, and refuses both at once", () => {
    expect(parsePersonaArgs(["--resume", RESULTS_DIR])).toMatchObject({ operation: "resume", resultsDir: RESULTS_DIR });
    expect(parsePersonaArgs(["--rescore", RESULTS_DIR])).toMatchObject({ operation: "rescore", resultsDir: RESULTS_DIR });
    expect(() => parsePersonaArgs(["--resume", "/scratch/a", "--rescore", "/scratch/b"])).toThrow("cannot be used together");
    expect(parsePersonaArgs(["--auth-profile", "Personal", "--tasks", "native-a,native-b", "--persona-dir", "/scratch/personas", "--results-root", "/scratch/results"]))
      .toMatchObject({ profile: "Personal", taskIds: ["native-a", "native-b"], personaDir: resolve("/scratch/personas"), resultsRoot: resolve("/scratch/results") });
    expect(() => parsePersonaArgs(["--profile", "Personal"])).toThrow("--auth-profile");
    expect(() => parsePersonaArgs(["--task", "native-a"])).toThrow("--tasks");
  });
  it("constructs and disposes its runtime before a dry-run provider preflight", async () => {
    let created = 0;
    let disposed = 0;
    await expect(personaMain(
      ["--persona", "explorer", "--variant", "gpt-6-astra:medium", "--variant", "gpt-6-luna:xhigh", "--auth-profile", "Personal", "--dry-run"],
      async (_root, _stored, profile) => {
        expect(profile).toBe("Personal");
        created++;
        return Object.assign(Object.create(null), {
          deps: { definitions: repoDefinitions(), moduleSelection: testCapabilityModules, captureProviderConnection: async () => { throw new Error("provider preflight reached"); } },
          profileId: "profile-1", usageAuthority: { profileId: "profile-1", authorityIncarnation: "incarnation-1" }, background: {},
          [Symbol.asyncDispose]: async () => { disposed++; },
        });
      },
    )).rejects.toThrow("provider preflight reached");
    expect(created).toBe(1);
    expect(disposed).toBe(1);
  });
  it("refuses unknown tasks for each persona before runtime creation", async () => {
    let created = 0;
    const runtime = async () => { created++; throw new Error("must not create runtime"); };
    await expect(personaMain(["--persona", "implementer", "--tasks", "not-a-registered-task", "--dry-run"], runtime)).rejects.toThrow("Unknown task ID");
    await expect(personaMain(["--persona", "explorer", "--tasks", "anything", "--dry-run"], runtime)).rejects.toThrow("Unknown task ID");
    expect(created).toBe(0);
  });
});
