import { describe, it, expect } from "bun:test";
import {
  FlywheelConfigSchema,
  CONFIG_DEFAULTS,
  loadConfig,
} from "../src/config";
import { buildWorkStepPrompt } from "../src/prompts/work/step-prompt";
import type { WorkflowStepContext } from "../src/prompts/index";

// ---------------------------------------------------------------------------
// Boundaries config schema tests
// ---------------------------------------------------------------------------

describe("FlywheelConfigSchema — boundaries section", () => {
  it("defaults to undefined when not provided", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.boundaries).toBeUndefined();
    }
  });

  it("accepts a full boundaries section with all fields", () => {
    const result = FlywheelConfigSchema.safeParse({
      boundaries: {
        port_ranges: ["3000-3100", "8080-8090"],
        off_limits_dirs: ["node_modules", ".git", "dist"],
        external_services: ["PostgreSQL on port 5432", "Redis on port 6379"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.boundaries).toBeDefined();
      expect(result.data.boundaries!.port_ranges).toEqual(["3000-3100", "8080-8090"]);
      expect(result.data.boundaries!.off_limits_dirs).toEqual(["node_modules", ".git", "dist"]);
      expect(result.data.boundaries!.external_services).toEqual([
        "PostgreSQL on port 5432",
        "Redis on port 6379",
      ]);
    }
  });

  it("accepts boundaries with only port_ranges", () => {
    const result = FlywheelConfigSchema.safeParse({
      boundaries: {
        port_ranges: ["3000-3100"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.boundaries).toBeDefined();
      expect(result.data.boundaries!.port_ranges).toEqual(["3000-3100"]);
      expect(result.data.boundaries!.off_limits_dirs).toBeUndefined();
      expect(result.data.boundaries!.external_services).toBeUndefined();
    }
  });

  it("accepts boundaries with only off_limits_dirs", () => {
    const result = FlywheelConfigSchema.safeParse({
      boundaries: {
        off_limits_dirs: ["/etc", "/var/log"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.boundaries).toBeDefined();
      expect(result.data.boundaries!.off_limits_dirs).toEqual(["/etc", "/var/log"]);
    }
  });

  it("accepts boundaries with only external_services", () => {
    const result = FlywheelConfigSchema.safeParse({
      boundaries: {
        external_services: ["Auth0 API", "Stripe payments"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.boundaries).toBeDefined();
      expect(result.data.boundaries!.external_services).toEqual(["Auth0 API", "Stripe payments"]);
    }
  });

  it("accepts empty boundaries object", () => {
    const result = FlywheelConfigSchema.safeParse({
      boundaries: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.boundaries).toBeDefined();
    }
  });

  it("rejects non-string arrays in port_ranges", () => {
    const result = FlywheelConfigSchema.safeParse({
      boundaries: {
        port_ranges: [3000, 3100],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string arrays in off_limits_dirs", () => {
    const result = FlywheelConfigSchema.safeParse({
      boundaries: {
        off_limits_dirs: [123],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string arrays in external_services", () => {
    const result = FlywheelConfigSchema.safeParse({
      boundaries: {
        external_services: [true],
      },
    });
    expect(result.success).toBe(false);
  });

  it("CONFIG_DEFAULTS does not include boundaries (optional section)", () => {
    expect(CONFIG_DEFAULTS.boundaries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Boundaries loading from TOML config
// ---------------------------------------------------------------------------

describe("loadConfig: boundaries section", () => {
  it("loads without boundaries when not specified", () => {
    const { config } = loadConfig(undefined, {});
    expect(config.boundaries).toBeUndefined();
  });

  it("does not error when config file lacks boundaries section", () => {
    // Use the existing fixture which does not have boundaries
    const { config } = loadConfig(
      `${import.meta.dir}/fixtures/flywheel.toml`,
      {},
    );
    expect(config.boundaries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Boundaries injection into worker prompts
// ---------------------------------------------------------------------------

describe("buildWorkStepPrompt — boundaries injection", () => {
  function makeCtx(overrides?: Partial<WorkflowStepContext>): WorkflowStepContext {
    return {
      planContent: "Implement feature X",
      keyDecisions: [],
      fileReferences: [],
      ...overrides,
    };
  }

  it("includes Mission Boundaries section when boundaries are configured", () => {
    const ctx = makeCtx({
      extra: {
        boundaries: {
          port_ranges: ["3000-3100"],
          off_limits_dirs: ["/etc"],
          external_services: ["PostgreSQL on port 5432"],
        },
      },
    });
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).toContain("## Mission Boundaries");
    expect(prompt).toContain("3000-3100");
    expect(prompt).toContain("/etc");
    expect(prompt).toContain("PostgreSQL on port 5432");
  });

  it("includes port ranges in boundaries section", () => {
    const ctx = makeCtx({
      extra: {
        boundaries: {
          port_ranges: ["3000-3100", "8080-8090"],
        },
      },
    });
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).toContain("## Mission Boundaries");
    expect(prompt).toContain("3000-3100");
    expect(prompt).toContain("8080-8090");
    expect(prompt).toContain("Port Ranges");
  });

  it("includes off-limits directories in boundaries section", () => {
    const ctx = makeCtx({
      extra: {
        boundaries: {
          off_limits_dirs: ["node_modules", ".git"],
        },
      },
    });
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).toContain("## Mission Boundaries");
    expect(prompt).toContain("node_modules");
    expect(prompt).toContain(".git");
    expect(prompt).toContain("Off-Limits");
  });

  it("includes external services in boundaries section", () => {
    const ctx = makeCtx({
      extra: {
        boundaries: {
          external_services: ["Auth0 API", "Redis on port 6379"],
        },
      },
    });
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).toContain("## Mission Boundaries");
    expect(prompt).toContain("Auth0 API");
    expect(prompt).toContain("Redis on port 6379");
    expect(prompt).toContain("External Services");
  });

  it("tells workers to never violate boundaries", () => {
    const ctx = makeCtx({
      extra: {
        boundaries: {
          port_ranges: ["3000-3100"],
        },
      },
    });
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).toContain("NEVER violate");
  });

  it("tells workers to return to orchestrator if blocked by boundaries", () => {
    const ctx = makeCtx({
      extra: {
        boundaries: {
          port_ranges: ["3000-3100"],
        },
      },
    });
    const prompt = buildWorkStepPrompt(ctx);

    // Should tell worker to return/escalate if blocked
    expect(prompt).toMatch(/return.*orchestrator|escalate/i);
  });

  it("does NOT include boundaries section when boundaries are not in extra", () => {
    const ctx = makeCtx({
      extra: {},
    });
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).not.toContain("Mission Boundaries");
  });

  it("does NOT include boundaries section when extra is undefined", () => {
    const ctx = makeCtx();
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).not.toContain("Mission Boundaries");
  });

  it("does NOT include boundaries section when boundaries is empty object", () => {
    const ctx = makeCtx({
      extra: {
        boundaries: {},
      },
    });
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).not.toContain("Mission Boundaries");
  });

  it("only includes subsections for configured boundary types", () => {
    // Only port_ranges configured — no off_limits_dirs or external_services sections
    const ctx = makeCtx({
      extra: {
        boundaries: {
          port_ranges: ["3000-3100"],
        },
      },
    });
    const prompt = buildWorkStepPrompt(ctx);

    expect(prompt).toContain("Port Ranges");
    expect(prompt).not.toContain("Off-Limits");
    expect(prompt).not.toContain("External Services");
  });
});
