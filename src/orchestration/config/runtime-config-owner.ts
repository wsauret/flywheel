import { deepFreeze } from "../../infra/deep-freeze.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { createOrderedLane } from "../../infra/ordered-lane.js";
import type { FlywheelConfig } from "./schema.js";
import { CONFIG_DEFAULTS } from "./schema.js";
import { ConfigPublicationError, heldConfigIdentity, publishedConfigIdentity, readConfigAt, watchConfigFile, withConfigOwnership, type ConfigFileLocation, type ConfigReadResult, type ConfigWatchOptions } from "./config-file.js";
import { ConfigLoadError, decodeCanonicalConfigText, type ConfigDiagnostic } from "./loader.js";
import type { ModuleConfigSection } from "./config-section.js";
import { configSection } from "./config-section.js";
import type { Schema } from "effect";
import { installedModuleConfigSettings, installedProviderSettings } from "../modules.js";
import { PERSISTED_SETTING_DEFINITIONS, PROJECT_SHOW_BUILD_DEFAULT, profileBooleanSettingDefinition, settingDefinitions, type ApplicationMode, type PersistedSettingDefinition, type ProfileBooleanSettingId, type SettingApplication, type SettingDefinition, type SettingDefinitionId } from "./setting-definitions.js";
import { ConfigWriteError, patchDefinedSetting, patchProfileBoolean, patchProfileProviderSetting, patchProjectShowBuild } from "./writer.js";
import { hasRetiredConfigTables, retireConfigTables } from "./retired-config-tables.js";

export const CONFIG_VALUE_ABSENT = Symbol("config-value-absent");
const log = Log.create({ service: "runtime-config" });
interface ConfigTree { readonly [key: string]: ConfigTreeValue }
type ConfigTreeValue = null | string | number | boolean | readonly ConfigTreeValue[] | ConfigTree;
type ConfigExpectedValue = ConfigTreeValue | typeof CONFIG_VALUE_ABSENT;
type RuntimeConfigStatus =
  | { readonly kind: "valid" }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed"; readonly fallback: "defaults" | "last-valid"; readonly message: string }
  | { readonly kind: "disposed" };

export interface RuntimeConfigSnapshot {
  readonly revision: number;
  readonly config: Readonly<FlywheelConfig>;
  readonly warnings: readonly string[];
  readonly diagnostics: readonly ConfigDiagnostic[];
  readonly sourceIdentity: string;
  readonly status: RuntimeConfigStatus;
}

type ConfigSubscriberOutcome =
  | { readonly kind: "settled" }
  | { readonly kind: "committed-but-degraded"; readonly errors: readonly string[] };
export type ConfigMutationResult =
  | { readonly ok: true; readonly snapshot: RuntimeConfigSnapshot; readonly subscriberOutcome: ConfigSubscriberOutcome; readonly durabilityWarning?: string }
  | { readonly ok: false; readonly kind: "stale" | "disposed" | "lock-failed" | "parse-or-decode-failed" | "write-not-applied" | "write-outcome-unknown"; readonly error: ConfigWriteError };

type Subscriber = (snapshot: RuntimeConfigSnapshot) => void | Promise<void>;
type UseTimeDecoder<T> = (read: ConfigReadResult) => T;
type UseTimeDecision<T, R> = (value: T) => R;
interface DecodedConfig { readonly config: FlywheelConfig; readonly warnings: string[]; readonly diagnostics: readonly ConfigDiagnostic[] }
interface ChangedDefinition { readonly id: string; readonly applications: readonly SettingApplication[] }
interface ConfigPublication { readonly snapshot: RuntimeConfigSnapshot; readonly settlement: Promise<ConfigSubscriberOutcome> }
interface SubscriberWaiter { readonly resolve: () => void; readonly reject: (error: unknown) => void }
interface SubscriberInvocation { readonly snapshot: RuntimeConfigSnapshot; readonly waiters: SubscriberWaiter[] }
interface SubscriberLane { active: Promise<void> | undefined; pending: SubscriberInvocation | undefined }
type StagedMutation =
  | { readonly result: Extract<ConfigMutationResult, { readonly ok: false }> }
  | { readonly publication: RuntimeConfigSnapshot; readonly durabilityWarning: string | undefined; readonly settlement: Promise<ConfigSubscriberOutcome> };

export interface RuntimeConfigOwnerOptions extends ConfigFileLocation {
  readonly watch?: boolean;
  readonly watchOptions?: ConfigWatchOptions;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly watchFile?: typeof watchConfigFile;
  readonly withOwnership?: typeof withConfigOwnership;
}

export interface RuntimeConfigOwner {
  snapshot(): RuntimeConfigSnapshot;
  refresh(): Promise<RuntimeConfigSnapshot>;
  /** Runs `subscriber` after a publication that changed the named setting, or
   *  the module config section a module owns, and waits for it when the
   *  setting applies live or replaces a resource. Removing the last registration
   *  cancels queued invocations and waits for the active callback. */
  subscribe(setting: SettingDefinitionId | ModuleConfigSection, subscriber: Subscriber): () => Promise<void>;
  /** Observe every publication, with the same removal contract as `subscribe`. */
  subscribeAll(subscriber: Subscriber): () => Promise<void>;
  mutate(settingId: string, expected: ConfigExpectedValue, value: string | number | boolean | readonly (string | number)[]): Promise<ConfigMutationResult>;
  /** Reset common Settings and the selected profile's provider settings in one
   *  validated commit. A changed reset target refuses the entire write.
   *  Disabled module sections and host-owned runtime policies remain untouched. */
  resetSettings(profileId: string): Promise<ConfigMutationResult>;
  /** Writes one declared, UI-safe module setting in its retained section. */
  mutateModuleSetting(section: ModuleConfigSection, key: string, expected: boolean | readonly number[], value: boolean | readonly number[], defaultValue: boolean | readonly number[]): Promise<ConfigMutationResult>;
  /** Compare selected JSON-compatible semantics from a freshly decoded section under ownership.
   * Patch synchronously using that same section and source. Validate before publication and await section subscribers.
   * Stale or invalid edits publish nothing; publication and subscriber outcomes retain their normal mutation meanings. */
  mutateSection<S extends Schema.Top & Schema.Decoder<unknown, never>>(section: ModuleConfigSection<S>, expected: ConfigExpectedValue, select: (value: S["Type"]) => ConfigExpectedValue, patch: (source: string, value: S["Type"]) => string): Promise<ConfigMutationResult>;
  mutateProfileBoolean(settingId: ProfileBooleanSettingId, profileId: string, expected: boolean, value: boolean): Promise<ConfigMutationResult>;
  /** Writes one project's Show build flag, keyed by canonical project root.
   *  An unauthored flag is compared as off. */
  mutateProjectShowBuild(projectRoot: string, expected: boolean, value: boolean): Promise<ConfigMutationResult>;
  /** Writes one provider-scoped numeric setting. `defaultValue` is what an
   *  unauthored key is compared as, so a caller's expectation states the
   *  value in force rather than the file's silence. */
  mutateProfileProviderSetting(profileId: string, providerId: string, key: string, expected: number, value: number, defaultValue: number): Promise<ConfigMutationResult>;
  /** Re-read one safety field and make its decision in the config ownership
   *  window. `decode` receives the read outcome, so a refused or unreadable
   *  file is a decision input rather than an exception. */
  revalidateUseTime<T, R>(decode: UseTimeDecoder<T>, decide: UseTimeDecision<T, R>): Promise<R>;
  /** An observer of one safety field for decisions that change nothing, such
   *  as capability admission. Each call is one observation, and it is the
   *  decision's linearization point.
   *
   *  A call reads the file in the config ownership window, as
   *  `revalidateUseTime` does, unless the published file is still the file
   *  that this observer's last ownership read observed. Then it returns the
   *  value that read decoded and takes no ownership. Taking ownership writes a
   *  lock record and removes it, each synced to disk on the calling thread, so
   *  an unchanged file costs one `lstat` instead. A missing file is always read
   *  under ownership, because on Windows a replacement in progress also reads
   *  as missing, and so is a file whose last read was refused. The observer keeps only the decoded value, never the file
   *  text, which can hold credentials. */
  useTimeObserver<T>(decode: UseTimeDecoder<T>): () => Promise<T>;
  dispose(): Promise<void>;
}

/** Initialize from committed config bytes before exposing a snapshot or arming the watcher. */
export async function createRuntimeConfigOwner(options: RuntimeConfigOwnerOptions): Promise<RuntimeConfigOwner> {
  let disposed = false;
  const publicationLane = createOrderedLane();
  const subscribers = new Map<string, Set<Subscriber>>();
  const snapshotSubscribers = new Set<Subscriber>();
  const subscriberLanes = new Map<Subscriber, SubscriberLane>();
  const ownedInvocations = new Set<Promise<void>>();
  let current = await publicationLane.run(async () => snapshotFromRead(options, await readCurrentConfig(options), undefined));

  const invokeSubscriber = (subscriber: Subscriber, lane: SubscriberLane, invocation: SubscriberInvocation): void => {
    const active = Promise.resolve().then(() => subscriber(invocation.snapshot)).then(
      () => { for (const waiter of invocation.waiters) waiter.resolve(); },
      (error) => { for (const waiter of invocation.waiters) waiter.reject(error); },
    ).then(() => {
      lane.active = undefined;
      const pending = lane.pending;
      lane.pending = undefined;
      if (pending !== undefined) invokeSubscriber(subscriber, lane, pending);
    });
    lane.active = active;
    ownedInvocations.add(active);
    void active.finally(() => { ownedInvocations.delete(active); });
  };

  const scheduleSubscriber = (subscriber: Subscriber, snapshot: RuntimeConfigSnapshot): Promise<void> => {
    const waiter = Promise.withResolvers<void>();
    const lane = subscriberLanes.get(subscriber) ?? { active: undefined, pending: undefined };
    subscriberLanes.set(subscriber, lane);
    if (lane.active === undefined) invokeSubscriber(subscriber, lane, { snapshot, waiters: [waiter] });
    else if (lane.pending === undefined) lane.pending = { snapshot, waiters: [waiter] };
    else {
      lane.pending.waiters.push(waiter);
      lane.pending = { snapshot, waiters: lane.pending.waiters };
    }
    return waiter.promise;
  };

  const unsubscribe = async (subscriber: Subscriber): Promise<void> => {
    const lane = subscriberLanes.get(subscriber);
    const pending = lane?.pending;
    if (lane && pending) {
      lane.pending = undefined;
      for (const waiter of pending.waiters) waiter.reject(new Error("Runtime config subscriber was removed before settlement"));
    }
    await lane?.active;
    if (subscriberLanes.get(subscriber) === lane && lane?.active === undefined && lane?.pending === undefined
      && !snapshotSubscribers.has(subscriber) && ![...subscribers.values()].some((entries) => entries.has(subscriber))) {
      subscriberLanes.delete(subscriber);
    }
  };

  const notifySnapshotSubscribers = (snapshot: RuntimeConfigSnapshot): void => {
    for (const subscriber of snapshotSubscribers) {
      void scheduleSubscriber(subscriber, snapshot).catch(() => {
        log.error("runtime-config-subscriber-failed", { code: "runtime-config-subscriber-failed" });
      });
    }
  };

  const notify = (snapshot: RuntimeConfigSnapshot, changes: readonly ChangedDefinition[]): Promise<ConfigSubscriberOutcome> => {
    const invocations = new Map<Subscriber, boolean>();
    for (const { id, applications } of changes) {
      for (const subscriber of subscribers.get(id) ?? []) {
        invocations.set(subscriber, invocations.get(subscriber) === true || applications.some(({ mode }) => waitsForSubscriber(mode)));
      }
    }
    const waiting: Promise<void>[] = [];
    for (const [subscriber, wait] of invocations) {
      const result = scheduleSubscriber(subscriber, snapshot);
      if (wait) waiting.push(result);
      else void result.catch(() => { log.error("runtime-config-subscriber-failed", { code: "runtime-config-subscriber-failed" }); });
    }
    return Promise.allSettled(waiting).then((results) => {
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed === 0) return { kind: "settled" };
      log.error("runtime-config-subscriber-failed", { code: "runtime-config-subscriber-failed", count: failed });
      return { kind: "committed-but-degraded", errors: Array.from({ length: failed }, () => "subscriber-failed") };
    });
  };

  const publishFromDisk = async (): Promise<ConfigPublication> => {
    if (disposed) return { snapshot: current, settlement: Promise.resolve({ kind: "settled" }) };
    const next = snapshotFromRead(options, await readCurrentConfig(options), current);
    if (samePublication(current, next)) return { snapshot: current, settlement: Promise.resolve({ kind: "settled" }) };
    const previous = current;
    current = next;
    notifySnapshotSubscribers(next);
    return { snapshot: next, settlement: notify(next, changedDefinitions(previous.config, next.config)) };
  };

  const refresh = async (): Promise<RuntimeConfigSnapshot> => {
    const publication = await publicationLane.run(async () => publishFromDisk());
    await publication.settlement;
    return publication.snapshot;
  };

  const watcher = options.watch === false ? undefined : (options.watchFile ?? watchConfigFile)(options, () => { void refresh(); }, options.watchOptions);

  const mutateConfig = async (
    expected: ConfigExpectedValue,
    actualValue: (source: string) => ConfigExpectedValue,
    patch: (source: string) => string,
  ): Promise<ConfigMutationResult> => {
    const staged = await publicationLane.run<StagedMutation>(async () => {
      if (disposed) return { result: failure("disposed", "Runtime config owner is disposed") };
      let publication: RuntimeConfigSnapshot | undefined;
      let durabilityWarning: string | undefined;
      let mutationFailure: Extract<ConfigMutationResult, { readonly ok: false }> | undefined;
      try {
        await (options.withOwnership ?? withConfigOwnership)(options, (ownership) => {
          let nextText: string;
          let decoded: DecodedConfig;
          try {
            const read = retireConfigTables(ownership, (text) => { decodePatchedText(text, options); }, options);
            if (read.kind === "failure") throw new ConfigWriteError("Config file was refused or unreadable");
            const source = read.kind === "text" ? read.text : "";
            if (!expectedMatches(actualValue(source), expected)) {
              mutationFailure = failure("stale", "Expected configuration values are stale");
              return;
            }
            nextText = patch(source);
            decoded = decodePatchedText(nextText, options);
          } catch (error) {
            mutationFailure = failure("parse-or-decode-failed", errorMessage(error));
            return;
          }
          try {
            const durability = ownership.write(nextText);
            durabilityWarning = durability === undefined ? undefined : errorMessage(durability);
            if (durabilityWarning !== undefined) log.error("runtime-config-directory-sync-failed", { code: "runtime-config-directory-sync-failed", reason: "publication-verification-or-durability" });
          } catch (error) {
            mutationFailure = failure(error instanceof ConfigPublicationError && error.outcome === "unknown" ? "write-outcome-unknown" : "write-not-applied", errorMessage(error));
            return;
          }
          publication = freezeSnapshot({ revision: current.revision + 1, config: decoded.config, warnings: durabilityWarning === undefined ? decoded.warnings : [...decoded.warnings, "Config saved but publication verification or durability could not be confirmed."], diagnostics: decoded.diagnostics, sourceIdentity: sourceIdentity(nextText), status: { kind: "valid" } });
        });
      } catch (error) {
        return { result: failure("lock-failed", errorMessage(error)) };
      }
      if (mutationFailure !== undefined) return { result: mutationFailure };
      if (publication === undefined) return { result: failure("lock-failed", "Config ownership completed without running the mutation") };
      const previous = current;
      current = publication;
      notifySnapshotSubscribers(publication);
      return { publication, durabilityWarning, settlement: notify(publication, changedDefinitions(previous.config, publication.config)) };
    });
    if ("result" in staged) return staged.result;
    const subscriberOutcome = await staged.settlement;
    return staged.durabilityWarning === undefined
      ? { ok: true, snapshot: staged.publication, subscriberOutcome }
      : { ok: true, snapshot: staged.publication, subscriberOutcome, durabilityWarning: staged.durabilityWarning };
  };

  return {
    snapshot: () => current,

    refresh,
    subscribe: (setting, subscriber) => {
      const settingId = typeof setting === "string" ? setting : setting.key;
      definitionForSubscription(settingId);
      const entries = subscribers.get(settingId) ?? new Set<Subscriber>();
      entries.add(subscriber);
      subscribers.set(settingId, entries);
      return async () => {
        entries.delete(subscriber);
        if (![...subscribers.values()].some((subscribersForSetting) => subscribersForSetting.has(subscriber)) && !snapshotSubscribers.has(subscriber)) await unsubscribe(subscriber);
      };
    },
    subscribeAll: (subscriber) => {
      snapshotSubscribers.add(subscriber);
      return async () => {
        snapshotSubscribers.delete(subscriber);
        if (![...subscribers.values()].some((subscribersForSetting) => subscribersForSetting.has(subscriber))) await unsubscribe(subscriber);
      };
    },
    resetSettings: async (profileId) => {
      const definitions = PERSISTED_SETTING_DEFINITIONS.flatMap((definition) => definition.reset === undefined ? [] : [{ ...definition, reset: definition.reset }]);
      const moduleSettings = installedModuleConfigSettings().filter(({ moduleId }) => current.config.modules.includes(moduleId));
      const providerSettings = installedProviderSettings();
      const expectation = (config: Readonly<FlywheelConfig>): string => JSON.stringify({
        modules: config.modules,
        settings: definitions.map((definition) => valueAt(config, definition.path)),
        moduleSettings: moduleSettings.map(({ setting }) => {
          const value = valueAt(config, [setting.section, setting.key]);
          return value === CONFIG_VALUE_ABSENT ? setting.defaultValue : value;
        }),
        providerSettings: providerSettings.map((setting) => config.profiles[profileId]?.providers[setting.providerId]?.[setting.key] ?? setting.defaultValue),
      });
      return mutateConfig(
        expectation(current.config),
        (source) => expectation(decodeText(source, options).config),
        (source) => {
          let next = source;
          for (const definition of definitions) next = patchDefinedSetting(next, definition, definition.reset);
          for (const { setting } of moduleSettings) next = patchDefinedSetting(next, { path: [setting.section, setting.key] }, setting.defaultValue);
          for (const setting of providerSettings) next = patchProfileProviderSetting(next, profileId, setting.providerId, setting.key, setting.defaultValue);
          return next;
        },
      );
    },
    mutate: async (settingId, expected, value) => {
      let definition: PersistedSettingDefinition;
      try {
        definition = definitionFor(settingId);
      } catch (error) {
        return failure("parse-or-decode-failed", errorMessage(error));
      }
      return mutateConfig(
        expected,
        (source) => expected === CONFIG_VALUE_ABSENT
          ? valueAt(parseTable(source), definition.path)
          : valueAt(decodeText(source, options).config, decodedPath(definition.path)),
        (source) => patchDefinedSetting(source, definition, value),
      );
    },
    mutateModuleSetting: async (section, key, expected, value, defaultValue) => mutateConfig(
      expected,
      (source) => {
        const authored = valueAt(parseTable(source), [section.key, key]);
        return authored === CONFIG_VALUE_ABSENT ? defaultValue : authored;
      },
      (source) => patchDefinedSetting(source, { path: [section.key, key] }, value),
    ),
    mutateSection: async (section, expected, select, patch) => {
      let selected: ReturnType<typeof configSection<typeof section.schema>>;
      return mutateConfig(
        expected,
        (source) => {
          selected = configSection(decodeText(source, options).config, section);
          return select(selected);
        },
        (source) => patch(source, selected),
      );
    },
    mutateProfileBoolean: async (settingId, profileId, expected, value) => {
      const definition = profileBooleanSettingDefinition(settingId);
      return mutateConfig(
        expected,
        (source) => {
          const authored = valueAt(parseTable(source), ["profiles", profileId, definition.key]);
          return authored === CONFIG_VALUE_ABSENT ? definition.defaultValue : authored;
        },
        (source) => patchProfileBoolean(source, profileId, definition, value),
      );
    },
    mutateProjectShowBuild: async (projectRoot, expected, value) => mutateConfig(
      expected,
      (source) => {
        const authored = valueAt(parseTable(source), ["projects", projectRoot, "show_build"]);
        return authored === CONFIG_VALUE_ABSENT ? PROJECT_SHOW_BUILD_DEFAULT : authored;
      },
      (source) => patchProjectShowBuild(source, projectRoot, value),
    ),
    mutateProfileProviderSetting: async (profileId, providerId, key, expected, value, defaultValue) => mutateConfig(
      expected,
      (source) => {
        const authored = valueAt(parseTable(source), ["profiles", profileId, "providers", providerId, key]);
        // The retired spelling `false` reads as off, the way the schema decodes it.
        return authored === CONFIG_VALUE_ABSENT ? defaultValue : authored === false ? 0 : authored;
      },
      (source) => patchProfileProviderSetting(source, profileId, providerId, key, value),
    ),
    revalidateUseTime: async (decode, decide) => await publicationLane.run(async () => (options.withOwnership ?? withConfigOwnership)(options, (ownership) => decide(decode(retireConfigTables(ownership, (text) => { decodePatchedText(text, options); }, options))))),
    useTimeObserver: (decode) => {
      // The value the last ownership read decoded, and the identity of the
      // published file it read. The identity is taken before the read, so a
      // file that changes during the read is kept under its old identity and
      // is read again at the next observation. The identity an observation
      // compares is the one the config watch holds: a change by another
      // process is seen after its watch event, and at the latest at the
      // watch's next revalidation, one second later. Without a confirmed
      // watch, and on Windows, each observation examines the file. A write
      // in this process is seen by the next observation. A refused read is never kept:
      // a refusal can be transient (a sharing violation, EMFILE), and keeping
      // it would hold the decision on stale state until the file changes.
      let owned: { readonly identity: string; readonly value: ReturnType<typeof decode> } | undefined;
      return async () => {
        const identity = heldConfigIdentity(options);
        if (identity !== "" && identity === owned?.identity) return owned.value;
        return await publicationLane.run(async () => (options.withOwnership ?? withConfigOwnership)(options, (ownership) => {
          const held = publishedConfigIdentity(options);
          const read = retireConfigTables(ownership, (text) => { decodePatchedText(text, options); }, options);
          const value = decode(read);
          owned = held === "" || read.kind === "failure" ? undefined : { identity: held, value };
          return value;
        }));
      };
    },
    dispose: async () => {
      await publicationLane.run(async () => {
        if (disposed) return;
        disposed = true;
        watcher?.dispose();
        current = freezeSnapshot({ ...current, revision: current.revision + 1, status: { kind: "disposed" } });
        notifySnapshotSubscribers(current);
      });
      while (ownedInvocations.size > 0) await Promise.allSettled(ownedInvocations);
      subscribers.clear();
      snapshotSubscribers.clear();
      subscriberLanes.clear();
    },
  };
}

async function readCurrentConfig(options: RuntimeConfigOwnerOptions): Promise<ConfigReadResult> {
  const read = readConfigAt(options);
  if (read.kind !== "text" || !hasRetiredConfigTables(read.text)) return read;
  try {
    return await (options.withOwnership ?? withConfigOwnership)(options, (ownership) => retireConfigTables(ownership, (text) => { decodePatchedText(text, options); }, options));
  } catch {
    return { kind: "failure", code: "refused-or-unreadable" };
  }
}

function snapshotFromRead(options: RuntimeConfigOwnerOptions, read: ConfigReadResult, previous: RuntimeConfigSnapshot | undefined): RuntimeConfigSnapshot {
  const revision = previous === undefined ? 0 : previous.revision + 1;
  if (read.kind === "missing") {
    const decoded = decodeText("", options);
    return freezeSnapshot({ revision, config: decoded.config, warnings: decoded.warnings, diagnostics: decoded.diagnostics, sourceIdentity: "missing", status: { kind: "missing" } });
  }
  if (read.kind === "failure") {
    log.warn("runtime-config-read-malformed", { code: "runtime-config-read-malformed" });
    return freezeSnapshot({ revision, config: previous?.config ?? CONFIG_DEFAULTS, warnings: previous?.warnings ?? [], diagnostics: [{ kind: "document", reason: "unreadable" }], sourceIdentity: `failure:${read.code}`, status: { kind: "malformed", fallback: malformedFallback(previous), message: "Config file was refused or unreadable." } });
  }
  try {
    const decoded = decodeText(read.text, options);
    const config = decoded.moduleError === undefined ? decoded.config : {
      ...decoded.config,
      modules: previous?.config.modules ?? CONFIG_DEFAULTS.modules,
      require_workflow_confirmation: previous?.config.require_workflow_confirmation ?? CONFIG_DEFAULTS.require_workflow_confirmation,
    };
    return freezeSnapshot({ revision, config, warnings: decoded.warnings, diagnostics: decoded.diagnostics, sourceIdentity: sourceIdentity(read.text), status: { kind: "valid" } });
  } catch (error) {
    log.warn("runtime-config-read-malformed", { code: "runtime-config-read-malformed" });
    const diagnostics: readonly ConfigDiagnostic[] = error instanceof ConfigLoadError && error.diagnostics.length > 0
      ? error.diagnostics
      : [{ kind: "document", reason: "unmapped-setting" }];
    return freezeSnapshot({ revision, config: previous?.config ?? CONFIG_DEFAULTS, warnings: previous?.warnings ?? [], diagnostics, sourceIdentity: sourceIdentity(read.text), status: { kind: "malformed", fallback: malformedFallback(previous), message: "Config text is malformed." } });
  }
}

function malformedFallback(previous: RuntimeConfigSnapshot | undefined): "defaults" | "last-valid" {
  if (previous?.status.kind === "valid") return "last-valid";
  if (previous?.status.kind === "malformed" && previous.status.fallback === "last-valid") return "last-valid";
  return "defaults";
}

function decodeText(text: string, options: RuntimeConfigOwnerOptions): ReturnType<typeof decodeCanonicalConfigText> {
  return decodeCanonicalConfigText(text, options.env ?? process.env, options.userDataRoot);
}

function parseTable(text: string): ConfigTree {
  const parsed: unknown = text.length === 0 ? {} : Bun.TOML.parse(text);
  const value = configTreeValue(parsed);
  if (!isConfigTree(value)) throw new ConfigWriteError("Config file is not a table");
  return value;
}

function definitionFor(id: string): PersistedSettingDefinition {
  const definition = PERSISTED_SETTING_DEFINITIONS.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new ConfigWriteError(`Unknown persisted setting: ${id}`);
  return definition;
}

function definitionForSubscription(id: string): SettingDefinition {
  const definition = settingDefinitions().find((candidate) => candidate.id === id);
  if (definition === undefined) throw new ConfigWriteError(`Unknown config setting: ${id}`);
  return definition;
}

function valueAt(root: unknown, path: readonly string[]): ConfigExpectedValue {
  let current = configTreeValue(root);
  for (const segment of path) {
    if (!isConfigTree(current) || !(segment in current)) return CONFIG_VALUE_ABSENT;
    const child = current[segment];
    if (child === undefined) return CONFIG_VALUE_ABSENT;
    current = child;
  }
  return current;
}

function configTreeValue(value: unknown): ConfigTreeValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(configTreeValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, configTreeValue(child)]));
  throw new ConfigWriteError("Config value has an unsupported type");
}

function isConfigTree(value: ConfigTreeValue): value is ConfigTree {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedMatches(actual: ConfigExpectedValue, expected: ConfigExpectedValue): boolean {
  if (actual === CONFIG_VALUE_ABSENT || expected === CONFIG_VALUE_ABSENT) return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function decodePatchedText(text: string, options: RuntimeConfigOwnerOptions): DecodedConfig {
  const decoded = decodeText(text, options);
  if (decoded.moduleError !== undefined) throw new ConfigLoadError(decoded.moduleError, "VALIDATION", decoded.diagnostics);
  return { config: decoded.config, warnings: decoded.warnings, diagnostics: decoded.diagnostics };
}

function changedDefinitions(previous: Readonly<FlywheelConfig>, next: Readonly<FlywheelConfig>): ChangedDefinition[] {
  return settingDefinitions().flatMap((definition) => {
    const rootPath = definition.kind === "retained-section" ? [definition.key] : decodedPath(definition.path);
    const applications = definition.applications.filter(({ path }) => JSON.stringify(valueAt(previous, [...rootPath, ...path])) !== JSON.stringify(valueAt(next, [...rootPath, ...path])));
    return applications.length === 0 ? [] : [{ id: definition.id, applications }];
  });
}

function decodedPath(path: readonly string[]): readonly string[] {
  return path[0] === "disabled_modules" ? ["modules"] : path;
}

function waitsForSubscriber(mode: ApplicationMode): boolean {
  return mode === "live" || mode === "replace-resource";
}

function sourceIdentity(text: string): string {
  return `${text.length}:${Bun.hash(text).toString(16)}`;
}

function samePublication(left: RuntimeConfigSnapshot, right: RuntimeConfigSnapshot): boolean {
  return left.sourceIdentity === right.sourceIdentity && JSON.stringify(left.status) === JSON.stringify(right.status) && JSON.stringify(left.warnings) === JSON.stringify(right.warnings) && JSON.stringify(left.diagnostics) === JSON.stringify(right.diagnostics);
}


function freezeSnapshot(snapshot: RuntimeConfigSnapshot): RuntimeConfigSnapshot {
  return Object.freeze({ ...snapshot, config: deepFreeze(structuredClone(snapshot.config)), warnings: Object.freeze([...snapshot.warnings]), diagnostics: Object.freeze(snapshot.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic, ...(diagnostic.kind === "setting" ? { path: Object.freeze([...diagnostic.path]) } : {}) }))), status: Object.freeze({ ...snapshot.status }) });
}

function failure(kind: Extract<ConfigMutationResult, { readonly ok: false }>["kind"], message: string): Extract<ConfigMutationResult, { readonly ok: false }> {
  return { ok: false, kind, error: new ConfigWriteError(message) };
}
