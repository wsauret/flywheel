import { Result, Schema } from "effect";
import { EFFORT_VALUES, EffortSchema, TierConfigSchema } from "../../infra/workflow-types.js";
import { validateRoleIds, WORKFLOW_AGENT_ROLE_ID } from "./roles.js";
import type { FlywheelConfig } from "./schema.js";
import { canonicalRoleId } from "./retired-config-names.js";
import { canonicalModelId } from "../../infra/llm/model-id.js";

type DeepPartial<T> = { -readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

type ProfileRoles = FlywheelConfig["profiles"][string]["roles"];
type ConfigOverrides = DeepPartial<FlywheelConfig> & { roles?: DeepPartial<ProfileRoles> };
type MutableRoleConfig = NonNullable<NonNullable<ConfigOverrides["roles"]>[string]>;

type EnvSetter = (envKey: string, val: string, config: ConfigOverrides) => string | undefined;

function ensure<K extends keyof ConfigOverrides>(
  config: ConfigOverrides,
  key: K,
  create: () => NonNullable<ConfigOverrides[K]>,
): NonNullable<ConfigOverrides[K]> {
  const existing = config[key];
  if (existing) return existing;
  const created = create();
  config[key] = created;
  return created;
}

function ensureRole(config: ConfigOverrides, roleId: string): MutableRoleConfig {
  const roles = ensure(config, "roles", () => ({}));
  const existing = roles[roleId];
  if (existing) return existing;
  const created: MutableRoleConfig = {};
  roles[roleId] = created;
  return created;
}

interface EnvOverrideParseResult {
  overrides: ConfigOverrides;
  /** The complete role table that `FLYWHEEL_ROLES` states, as authored. */
  roleTable?: { [roleId: string]: unknown };
  errors: string[];
}

function setString(set: (config: ConfigOverrides, value: string) => void): EnvSetter {
  return (_envKey, val, config) => {
    set(config, val);
    return undefined;
  };
}

function setInt(set: (config: ConfigOverrides, value: number) => void): EnvSetter {
  return (envKey, val, config) => {
    if (!/^-?\d+$/.test(val)) return `${envKey} must be an integer`;
    const parsed = Number(val);
    // Every budget/queue/threshold env maps to a non-negative config field, so a
    // negative belongs to no valid setting. Reject it at the boundary with the
    // variable named, not deep in a downstream "Invalid configuration" schema error.
    if (parsed < 0) return `${envKey} must be a non-negative integer`;
    set(config, parsed);
    return undefined;
  };
}

function setEffort(set: (config: ConfigOverrides, value: NonNullable<ProfileRoles[string]["effort"]>) => void): EnvSetter {
  return (envKey, val, config) => {
    const parsed = Schema.decodeUnknownResult(EffortSchema)(val);
    if (Result.isFailure(parsed)) return `${envKey} must be one of ${EFFORT_VALUES.join(", ")}`;
    set(config, parsed.success);
    return undefined;
  };
}

/** Strict boolean env parsing: only these forms are documented, so anything
 *  else is a typo the user hears about rather than a value silently read as
 *  false. */
const BOOLEAN_VALUES: ReadonlyMap<string, boolean> = new Map([["1", true], ["0", false], ["true", true], ["false", false]]);

function setBoolean(set: (config: ConfigOverrides, value: boolean) => void): EnvSetter {
  return (envKey, val, config) => {
    const parsed = BOOLEAN_VALUES.get(val);
    if (parsed === undefined) return `${envKey} must be one of ${[...BOOLEAN_VALUES.keys()].join(", ")}`;
    set(config, parsed);
    return undefined;
  };
}

type EnvSetters = { readonly [K in string]: EnvSetter };

const ENV_MAP = {
  FLYWHEEL_CHAT_MODEL: setString((c, val) => { ensureRole(c, "chat").model = val }),
  FLYWHEEL_CHAT_EFFORT: setEffort((c, val) => { ensureRole(c, "chat").effort = val }),
  // Retired spellings of the Workflow Agent variables, set before the current
  // ones so the current spelling wins when both are set. Remove after
  // 2027-04-30.
  FLYWHEEL_STEP_AGENT_MODEL: setString((c, val) => { ensureRole(c, WORKFLOW_AGENT_ROLE_ID).model = val }),
  FLYWHEEL_WORKER_MODEL: setString((c, val) => { ensureRole(c, WORKFLOW_AGENT_ROLE_ID).model = val }),
  FLYWHEEL_STEP_AGENT_EFFORT: setEffort((c, val) => { ensureRole(c, WORKFLOW_AGENT_ROLE_ID).effort = val }),
  FLYWHEEL_WORKER_EFFORT: setEffort((c, val) => { ensureRole(c, WORKFLOW_AGENT_ROLE_ID).effort = val }),
  FLYWHEEL_WORKFLOW_AGENT_MODEL: setString((c, val) => { ensureRole(c, WORKFLOW_AGENT_ROLE_ID).model = val }),
  FLYWHEEL_WORKFLOW_AGENT_EFFORT: setEffort((c, val) => { ensureRole(c, WORKFLOW_AGENT_ROLE_ID).effort = val }),
  FLYWHEEL_BUDGET_MAX_INVOCATIONS: setInt((c, val) => { ensure(c, "budget", () => ({})).max_invocations = val }),
  FLYWHEEL_BUDGET_MAX_TOKENS: setInt((c, val) => { ensure(c, "budget", () => ({})).max_tokens = val }),
  FLYWHEEL_BUDGET_MAX_WALL_CLOCK_MINUTES: setInt((c, val) => { ensure(c, "budget", () => ({})).max_wall_clock_minutes = val }),
  // Retired spellings of FLYWHEEL_WORKFLOW_MAX_ATTEMPTS, set before it so the
  // current spelling wins when both are set. Remove after 2027-04-30.
  FLYWHEEL_QUEUE_MAX_STEPS: setInt((c, val) => { ensure(c, "workflow", () => ({})).max_attempts = val }),
  FLYWHEEL_WORKFLOW_MAX_STEPS: setInt((c, val) => { ensure(c, "workflow", () => ({})).max_attempts = val }),
  FLYWHEEL_WORKFLOW_MAX_ATTEMPTS: setInt((c, val) => { ensure(c, "workflow", () => ({})).max_attempts = val }),
  FLYWHEEL_PROACTIVE_COMPACTION_THRESHOLD: setInt((c, val) => { c.proactive_compaction_threshold = val }),
  // Named for what the user turns off, stored as what the runtime reads.
  // A variable named for disabling only ever disables. A falsy value leaves
  // the durable setting alone instead of re-enabling an install the user
  // deliberately turned off, which is the direction that replaces a binary
  // without asking.
  FLYWHEEL_DISABLE_AUTOUPDATE: setBoolean((c, val) => { if (val) ensure(c, "updates", () => ({})).auto_install = false }),
} satisfies EnvSetters;

const RoleTableSchema = Schema.Record(Schema.String, TierConfigSchema);

/** `FLYWHEEL_ROLES` holds one JSON object of role id to `{ model, effort,
 *  provider_options }`, each key optional. It is the complete role table of
 *  selected profile for this process, and a role it does not name takes the shipped default. A benchmark
 *  sets it so a variant's models depend neither on the operator's settings
 *  nor on a write to them; nothing writes it to the file. */
function parseRoleTable(value: string): { roleTable: { [roleId: string]: unknown } } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { error: "FLYWHEEL_ROLES must be a JSON object" };
  }
  const decoded = Schema.decodeUnknownResult(RoleTableSchema, { onExcessProperty: "error" })(parsed);
  if (Result.isFailure(decoded)) {
    return { error: "FLYWHEEL_ROLES must map role ids to objects with only model, effort, and provider_options" };
  }
  const unknown = validateRoleIds(Object.keys(decoded.success));
  if (unknown.length > 0) return { error: `FLYWHEEL_ROLES names unknown role id(s): ${unknown.join(", ")}` };
  return { roleTable: decoded.success };
}

export function applyEnvOverrides(env: { [K in string]: string | undefined }): EnvOverrideParseResult {
  const overrides: ConfigOverrides = {};
  const errors: string[] = [];
  for (const [envKey, setter] of Object.entries(ENV_MAP)) {
    const val = env[envKey];
    if (val !== undefined && val !== "") {
      const error = setter(envKey, val, overrides);
      if (error) errors.push(error);
    }
  }
  const roles = env.FLYWHEEL_ROLES;
  if (roles === undefined || roles === "") return { overrides, errors };
  const table = parseRoleTable(roles);
  if ("error" in table) return { overrides, errors: [...errors, table.error] };
  return { overrides, roleTable: table.roleTable, errors };
}

/** Apply process-only role policy after choosing the profile. No environment value is persisted. */
export function profileRoleSettings(roles: ProfileRoles = {}, env: { [key: string]: string | undefined } = process.env): ProfileRoles {
  const parsed = applyEnvOverrides(env);
  if (parsed.errors.length > 0) throw new Error(`Invalid environment overrides: ${parsed.errors.join(", ")}`);
  const canonical = (table: { [key: string]: unknown }) => Object.fromEntries(Object.entries(table)
    .filter(([id]) => id === canonicalRoleId(id) || !Object.hasOwn(table, canonicalRoleId(id)))
    .map(([id, value]) => [canonicalRoleId(id), value]));
  const base = { ...(parsed.roleTable === undefined ? roles : Schema.decodeUnknownSync(RoleTableSchema)(canonical(parsed.roleTable))) };
  for (const [id, value] of Object.entries(parsed.overrides.roles ?? {})) {
    const roleId = canonicalRoleId(id);
    base[roleId] = { ...base[roleId], ...value };
  }
  return Object.fromEntries(Object.entries(base).map(([id, role]) => [id, {
    ...role, ...(role.model === undefined ? {} : { model: canonicalModelId(role.model) }),
  }]));
}
