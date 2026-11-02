type ModuleAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: string };

type ModuleContribution<Contributions extends object> = {
  readonly [Domain in keyof Contributions]: {
    readonly domain: Domain;
    readonly id: string;
    readonly value: Contributions[Domain];
  };
}[keyof Contributions];

/** A contribution as composition emits it: the declaration plus the id of the
 *  module that owns it. Descriptors do not state the owner; composition does. */
type ComposedContribution<Contributions extends object> = ModuleContribution<Contributions> & { readonly module: string };

type ModuleObserver<Observers extends object> = {
  readonly [Seam in keyof Observers]: {
    readonly seam: Seam;
    readonly observer: Observers[Seam];
  };
}[keyof Observers];

type ModuleTransformer<Transformers extends object> = {
  readonly [Seam in keyof Transformers]: {
    readonly seam: Seam;
    readonly id: string;
    readonly order: number;
    readonly transformer: Transformers[Seam];
  };
}[keyof Transformers];

type ModuleGateDeclaration<Gates extends object> = {
  readonly [Seam in keyof Gates]: {
    readonly seam: Seam;
    readonly gate: Gates[Seam];
  };
}[keyof Gates];

/** A statically registered capability and all declarations it contributes.
 * Owner layers define the concrete value and hook maps. Infra only defines
 * composition structure and does not import those values upward. */
export interface ModuleDescriptor<Contributions extends object, Observers extends object, Transformers extends object, Gates extends object> {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly availability: ModuleAvailability;
  /** Declares that enabled module work can outlive its initiating foreground turn. */
  readonly producesBackgroundWork?: boolean;
  readonly contributions: readonly ModuleContribution<Contributions>[];
  readonly observers: readonly ModuleObserver<Observers>[];
  readonly transformers: readonly ModuleTransformer<Transformers>[];
  readonly gates: readonly ModuleGateDeclaration<Gates>[];
}

export interface ModuleCompositionOptions<Contributions extends object> {
  readonly disabledModuleIds?: readonly string[];
  readonly warnWhenEmpty?: readonly (keyof Contributions)[];
}

export interface ModuleComposition<Contributions extends object, Observers extends object, Transformers extends object, Gates extends object> {
  readonly enabledModuleIds: readonly string[];
  /** Every installed module that declares background work, enabled or not:
   *  a request explains a withheld background surface by naming them all. */
  readonly backgroundWorkProducerIds: readonly string[];
  /** Complete declarations for reading retained state, including disabled
   *  modules, each with the module that declares it. */
  readonly installedContributions: readonly ComposedContribution<Contributions>[];
  readonly contributions: readonly ComposedContribution<Contributions>[];
  readonly observers: readonly ModuleObserver<Observers>[];
  readonly transformers: readonly ModuleTransformer<Transformers>[];
  readonly gates: readonly ModuleGateDeclaration<Gates>[];
  readonly warnings: readonly string[];
}

/** Validates and composes a static module catalog. Catalog order has no
 * meaning. Contribution identity is scoped to its domain, transformer order
 * is explicit, and one gate may own each seam. */
export function composeModules<Contributions extends object, Observers extends object, Transformers extends object, Gates extends object>(
  modules: readonly ModuleDescriptor<Contributions, Observers, Transformers, Gates>[],
  options: ModuleCompositionOptions<Contributions> = {},
): ModuleComposition<Contributions, Observers, Transformers, Gates> {
  const modulesById = new Map<string, ModuleDescriptor<Contributions, Observers, Transformers, Gates>>();
  for (const module of modules) {
    if (modulesById.has(module.id)) throw new Error(`Duplicate capability module id: ${module.id}`);
    modulesById.set(module.id, module);
  }

  for (const module of modulesById.values()) {
    for (const dependency of module.dependencies) {
      if (!modulesById.has(dependency)) throw new Error(`${module.id} requires unknown module ${dependency}`);
    }
  }
  validateDependencyDag([...modulesById.values()].sort((left, right) => left.id.localeCompare(right.id)), modulesById);

  const installedContributions = modules
    .flatMap((module) => module.contributions.map((contribution): ComposedContribution<Contributions> => ({ ...contribution, module: module.id })))
    .toSorted(compareDeclarations);
  const contributionIds = new Set<string>();
  for (const contribution of installedContributions) {
    const key = `${String(contribution.domain)}\u0000${contribution.id}`;
    if (contributionIds.has(key)) throw new Error(`Duplicate ${String(contribution.domain)} contribution id: ${contribution.id}`);
    contributionIds.add(key);
  }

  const transformerIds = new Set<string>();
  for (const transformer of modules.flatMap((module) => module.transformers)) {
    const key = `${String(transformer.seam)}\u0000${transformer.id}`;
    if (transformerIds.has(key)) throw new Error(`Duplicate transformer for seam ${String(transformer.seam)} and id: ${transformer.id}`);
    transformerIds.add(key);
  }

  const gateSeams = new Set<string>();
  for (const gate of modules.flatMap((module) => module.gates)) {
    const seam = String(gate.seam);
    if (gateSeams.has(seam)) throw new Error(`Duplicate gate for seam: ${seam}`);
    gateSeams.add(seam);
  }

  const disabled = new Set(options.disabledModuleIds);
  for (const id of disabled) {
    if (!modulesById.has(id)) throw new Error(`Unknown disabled capability module id: ${id}`);
  }
  // A module whose dependency is off or unavailable is off too, and comes back with it, so
  // turning a base off never makes a selection invalid and never loses the
  // person's choice for a dependent module (ARCH-STRUCTURE-025).
  const enabledIds = new Set([...modulesById.values()].filter((module) => module.availability.kind === "available" && !disabled.has(module.id)).map((module) => module.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of enabledIds) {
      if (modulesById.get(id)?.dependencies.some((dependency) => !enabledIds.has(dependency))) {
        enabledIds.delete(id);
        changed = true;
      }
    }
  }
  const enabled = [...modulesById.values()].filter((module) => enabledIds.has(module.id)).sort((left, right) => left.id.localeCompare(right.id));

  const contributions = installedContributions.filter((contribution) => enabledIds.has(contribution.module));
  const gates = enabled.flatMap((module) => module.gates).toSorted((left, right) => String(left.seam).localeCompare(String(right.seam)));
  const observers = enabled.flatMap((module) => module.observers).toSorted((left, right) => String(left.seam).localeCompare(String(right.seam)));
  const transformers = enabled.flatMap((module) => module.transformers).toSorted((left, right) => left.order - right.order || String(left.seam).localeCompare(String(right.seam)) || left.id.localeCompare(right.id));
  const warnings = [...(options.warnWhenEmpty ?? [])]
    .filter((domain) => !contributions.some((contribution) => contribution.domain === domain))
    .map((domain) => `No ${String(domain)} contributions are enabled`)
    .sort();

  const backgroundWorkProducerIds = [...modulesById.values()].filter((module) => module.producesBackgroundWork === true).map((module) => module.id).toSorted();
  return { enabledModuleIds: enabled.map((module) => module.id), backgroundWorkProducerIds, installedContributions, contributions, observers, transformers, gates, warnings };
}

function compareDeclarations(left: { readonly domain: PropertyKey; readonly id: string }, right: { readonly domain: PropertyKey; readonly id: string }): number {
  return String(left.domain).localeCompare(String(right.domain)) || left.id.localeCompare(right.id);
}

function validateDependencyDag<Contributions extends object, Observers extends object, Transformers extends object, Gates extends object>(
  modules: readonly ModuleDescriptor<Contributions, Observers, Transformers, Gates>[],
  modulesById: ReadonlyMap<string, ModuleDescriptor<Contributions, Observers, Transformers, Gates>>,
): void {
  const visited = new Set<string>();
  const path: string[] = [];
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      throw new Error(`Capability module dependency cycle: ${[...path.slice(start), id].join(" -> ")}`);
    }
    visiting.add(id);
    path.push(id);
    const module = modulesById.get(id);
    if (module) for (const dependency of module.dependencies.toSorted()) visit(dependency);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const module of modules) visit(module.id);
}

/** The process's module catalog, installed at most once and read many times.
 *
 *  The catalog is a value of the composition root, not of the registry that
 *  lists the shipped modules: a source run adds modules a release never
 *  contains, and Bun's bundler keeps a statically imported catalog even behind
 *  a build-time constant, so the only way to keep those modules out of a
 *  release is for the release's entry never to name them. The entry installs a
 *  loader rather than the modules themselves so that installing costs nothing
 *  until the first composition reads the catalog. A second install, or an
 *  install after any read, throws: every composition in the process must see
 *  one catalog. */
export interface ModuleCatalogSlot<Module> {
  install(load: () => readonly Module[]): void;
  /** The registry publishes its sole immutable shipped tuple once. Publishing
   * does not read the catalog or prevent a source entry installing an override. */
  publish(modules: readonly Module[]): void;
  /** The selected catalog, loaded once on first read. Undefined means no
   * registry or source-entry loader has initialized this realm. */
  installed(): readonly Module[] | undefined;
}

export function createModuleCatalogSlot<Module>(): ModuleCatalogSlot<Module> {
  let load: (() => readonly Module[]) | undefined;
  let catalog: readonly Module[] | undefined;
  let shipped: readonly Module[] | undefined;
  let read = false;
  return {
    install: (loader) => {
      if (load) throw new Error("The module catalog is already installed");
      if (read) throw new Error("The module catalog was read before it was installed");
      load = loader;
    },
    publish: (modules) => {
      if (shipped) throw new Error("The shipped module catalog is already published");
      if (read && !load) throw new Error("The module catalog was read before the registry published it");
      shipped = Object.freeze(modules);
    },
    installed: () => {
      read = true;
      if (load && !catalog) catalog = Object.freeze(load());
      return catalog ?? shipped;
    },
  };
}
