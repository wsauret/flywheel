import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ShellWriteCommand } from "./bash-write-effects.js";
import { directoryChange } from "./bash-write-directories.js";
import { expandShellWord, placeShellPath, type ExpandedWord, type ShellDialect } from "./bash-write-words.js";

interface Directory {
  readonly cwd: string | null;
  readonly pwd: string | null;
}

interface ShellVariables {
  readonly [name: string]: string | null | undefined;
}

interface StateRecord {
  readonly locations: readonly Directory[];
  readonly env: ShellVariables;
  readonly stack: readonly Directory[] | null;
  readonly changedIFS: boolean;
  readonly changedPaths: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

interface Trap {
  readonly payload: string | null;
  readonly raw: string;
  readonly signal: string;
  readonly current: ShellState;
  readonly observed: ShellState;
}

/** One statement-state owner. Null is unknown; an absent variable is unset.
 * Trap projections retain only paths on which their registration is active. */
export class ShellState {
  private traps = new Map<string, Trap>();
  private retiredTraps = new Map<string, Trap>();
  private constructor(
    private record: StateRecord,
    private readonly directoryCache: Map<string, boolean>,
    private readonly linkCache: Map<string, string | null>,
  ) {}

  static initial(cwd: string, env: StateRecord["env"]): ShellState {
    return new ShellState({
      locations: [{ cwd, pwd: cwd }], env: { ...env, PWD: cwd }, stack: [], changedIFS: false,
      changedPaths: new Set(), directories: new Set(),
    }, new Map(), new Map());
  }

  get cwd(): string | null { return this.record.locations.every(location => location.cwd === this.record.locations[0]?.cwd) ? this.record.locations[0]?.cwd ?? null : null; }
  get pwd(): string | null { return this.record.locations.every(location => location.pwd === this.record.locations[0]?.pwd) ? this.record.locations[0]?.pwd ?? null : null; }
  get workingDirectories(): readonly (string | null)[] { return [...new Set(this.record.locations.map(location => location.cwd))]; }
  get env(): StateRecord["env"] { return this.record.env; }
  get stack(): StateRecord["stack"] { return this.record.stack; }
  get changedIFS(): boolean { return this.record.changedIFS; }
  lookup(name: string): string | null | undefined { return this.record.env[name]; }

  copy(withTraps = true): ShellState {
    const state = new ShellState(this.record, this.directoryCache, this.linkCache);
    if (withTraps) state.traps = new Map([...this.traps].map(([key, trap]) => [key, {
      ...trap, current: trap.current.copy(false), observed: trap.observed.copy(false),
    }]));
    if (withTraps) state.retiredTraps = new Map(this.retiredTraps);
    return state;
  }

  /** Apply one transfer to the live state and each active trap's branch. */
  private transfer(update: (state: ShellState) => StateRecord): void {
    this.record = update(this);
    for (const trap of this.traps.values()) {
      trap.current.record = update(trap.current);
      trap.observed.merge([trap.observed.copy(false), trap.current]);
    }
  }

  setVariable(name: string, value: string | null | undefined): void {
    this.transfer(state => ({ ...state.record, env: { ...state.env, [name]: value }, changedIFS: state.changedIFS || name === "IFS" }));
  }

  assign(raw: string, dialect: ShellDialect, expansion?: ShellState): void {
    const equal = raw.indexOf("=");
    if (equal <= 0) return;
    const name = raw.slice(0, equal);
    this.transfer(state => ({
      ...state.record,
      env: { ...state.env, [name]: expandShellWord(raw.slice(equal + 1), key => (expansion ?? state).lookup(key), dialect)?.value ?? null },
      changedIFS: state.changedIFS || name === "IFS",
    }));
  }

  clearEnvironment(): void { this.transfer(state => ({ ...state.record, env: {} })); }

  /** Input-consuming builtins replace their named variables with unknown values. */
  applyBuiltin(command: ShellWriteCommand): boolean {
    let names: readonly string[] = [];
    let value: null | undefined = null;
    if (command.name === "unset") {
      if (command.args.some(arg => /^-[^-]*f/.test(arg))) return true;
      names = command.args.filter(arg => !arg.startsWith("-"));
      value = undefined;
    } else if (command.name === "read") {
      const parsed = builtinOperands(command.args, "adinNptu");
      const array = parsed.options.get("a");
      names = array ? [array] : parsed.names.length ? parsed.names : ["REPLY"];
    } else if (command.name === "mapfile" || command.name === "readarray") {
      names = [builtinOperands(command.args, "dnOscuC").names[0] ?? "MAPFILE"];
    } else if (command.name === "getopts") names = [command.args[1] ?? ""];
    else if (command.name === "printf") {
      const name = builtinOperands(command.args, "v").options.get("v");
      if (name) names = [name];
    } else return false;
    names = names.filter(name => /^[A-Za-z_]\w*$/.test(name));
    if (!names.length) return true;
    this.transfer(state => ({
      ...state.record,
      env: { ...state.env, ...Object.fromEntries(names.map(name => [name, value])) },
      changedIFS: names.includes("IFS") ? value === null : state.changedIFS,
    }));
    return true;
  }

  relocate(cwd: string | null): void {
    this.transfer(state => ({ ...state.record, locations: [{ cwd, pwd: cwd }] }));
  }

  /** The success and failure successors share this directory transfer. */
  changeDirectory(command: ShellWriteCommand, effective: ShellState, dialect: ShellDialect): boolean {
    let mayFail = false;
    this.transfer(state => {
      const change = directoryChange(command, state, effective, dialect);
      mayFail ||= change.mayFail;
      return { ...state.record, locations: [{ cwd: change.location.cwd, pwd: change.location.pwd }], stack: change.location.stack, env: { ...state.env, PWD: change.location.pwd, OLDPWD: state.pwd } };
    });
    return mayFail;
  }

  isDirectory(path: string): boolean {
    if (this.record.directories.has(path)) return true;
    let exists = this.directoryCache.get(path);
    if (exists === undefined) {
      try { exists = statSync(path).isDirectory(); } catch { exists = false; }
      this.directoryCache.set(path, exists);
    }
    return exists;
  }

  place(word: ExpandedWord, dialect: ShellDialect, deleteEntry = false, cwd = this.cwd): string | null {
    const value = dialect === "powershell" ? word.value.replaceAll("\\", "/") : word.value;
    let prefix = isAbsolute(value) ? sep : cwd;
    if (prefix !== null && this.record.changedPaths.size) {
      const segments = value.split("/");
      if (deleteEntry && !value.endsWith("/")) segments.pop();
      for (const segment of segments) {
        if (!segment) continue;
        prefix = resolve(prefix, segment);
        if (this.record.changedPaths.has(prefix)
          || this.record.changedPaths.has(placeShellPath({ value: prefix }, cwd, dialect, false, this.linkCache) ?? "")) return null;
      }
    }
    const path = placeShellPath(word, cwd, dialect, deleteEntry, this.linkCache);
    return path !== null && [...this.record.changedPaths].some(changed => path === changed && !deleteEntry || path.startsWith(changed + sep)) ? null : path;
  }

  effect(path: string, kind: string, replacesEntries: boolean, parents = false): void {
    this.transfer(state => {
      const changedPaths = new Set(state.record.changedPaths);
      const directories = new Set(state.record.directories);
      if (replacesEntries) changedPaths.add(path);
      if (kind === "mkdir") {
        directories.add(path);
        if (parents) for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) directories.add(parent);
      }
      return { ...state.record, changedPaths, directories };
    });
  }

  absorbFilesystem(other: ShellState): void {
    if (!other.record.changedPaths.size && !other.record.directories.size) return;
    this.transfer(state => ({
      ...state.record,
      changedPaths: new Set([...state.record.changedPaths, ...other.record.changedPaths]),
      directories: new Set([...state.record.directories, ...other.record.directories]),
    }));
  }

  registerTrap(key: string, signal: string, payload: string | null, raw: string): void {
    for (const [id, trap] of this.traps) if (trap.signal === signal) {
      if (signal !== "EXIT") this.retiredTraps.set(id, trap);
      this.traps.delete(id);
    }
    if (payload === "-") return;
    this.traps.set(key, { signal, payload, raw, current: this.copy(false), observed: this.copy(false) });
  }

  pendingTraps(): readonly Trap[] { return [...this.retiredTraps.values(), ...this.traps.values()]; }

  /** Join once at a control-flow boundary, preserving trap registration paths. */
  merge(states: readonly ShellState[]): void {
    const first = states[0];
    if (!first) return;
    const same = <T>(read: (state: ShellState) => T): T | null => states.every(state => read(state) === read(first)) ? read(first) : null;
    const keys = new Set(states.flatMap(state => Object.keys(state.env)));
    const stack = first.stack;
    this.record = {
      locations: [...new Map(states.flatMap(state => state.record.locations).map(location => [JSON.stringify(location), location])).values()],
      env: Object.fromEntries([...keys].map(key => [key, same(state => state.lookup(key))])),
      stack: stack && states.every(state => state.stack?.length === stack.length)
        ? stack.map((entry, i) => ({ cwd: same(state => state.stack?.[i]?.cwd ?? null), pwd: same(state => state.stack?.[i]?.pwd ?? null) })) : null,
      changedIFS: states.some(state => state.changedIFS),
      changedPaths: new Set(states.flatMap(state => [...state.record.changedPaths])),
      directories: new Set([...first.record.directories].filter(path => states.every(state => state.record.directories.has(path)))),
    };
    const joinTraps = (read: (state: ShellState) => ReadonlyMap<string, Trap>): Map<string, Trap> => {
      const joined = new Map<string, Trap>();
      for (const state of states) for (const [key, trap] of read(state)) {
        const previous = joined.get(key);
        if (previous) {
          previous.current.merge([previous.current.copy(false), trap.current]);
          previous.observed.merge([previous.observed.copy(false), trap.observed]);
        } else joined.set(key, { ...trap, current: trap.current.copy(false), observed: trap.observed.copy(false) });
      }
      return joined;
    };
    this.traps = joinTraps(state => state.traps);
    this.retiredTraps = joinTraps(state => state.retiredTraps);
  }

  same(other: ShellState): boolean {
    return JSON.stringify(this.record, (_key, value: unknown) => value instanceof Set ? [...value].sort() : value)
      === JSON.stringify(other.record, (_key, value: unknown) => value instanceof Set ? [...value].sort() : value);
  }
}

function builtinOperands(args: readonly string[], values: string) {
  const options = new Map<string, string>();
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") { index++; break; }
    if (!arg.startsWith("-") || arg === "-") break;
    for (let offset = 1; offset < arg.length; offset++) {
      const flag = arg[offset] ?? "";
      if (!values.includes(flag)) continue;
      options.set(flag, arg.slice(offset + 1) || args[++index] || "");
      break;
    }
  }
  return { names: args.slice(index), options };
}
