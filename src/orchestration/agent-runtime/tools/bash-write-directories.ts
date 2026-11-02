import { isAbsolute, resolve } from "node:path";
import type { ShellWriteCommand } from "./bash-write-effects.js";
import type { ShellState } from "./bash-write-state.js";
import { expandShellFields, type ShellDialect } from "./bash-write-words.js";

/** Plan a builtin's success path. A missing directory also has a failure path;
 * unsupported argv makes only directory-dependent placement unknown. */
export function directoryChange(command: ShellWriteCommand, state: ShellState, effective: ShellState, dialect: ShellDialect) {
  const unknown = { location: { cwd: null, pwd: null, stack: null }, mayFail: false };
  const args: string[] = [];
  for (const raw of command.rawArgs) {
    const fields = expandShellFields(raw, key => state.lookup(key), dialect, effective.changedIFS);
    if (!fields || fields.length !== 1 || fields[0]?.wildcard !== undefined) return unknown;
    args.push(fields[0]?.value ?? "");
  }
  if (dialect === "powershell") {
    const path = args.findIndex(arg => /^-(?:literal)?path(?::|$)/i.test(arg));
    if (path >= 0) {
      const option = args[path] ?? "";
      if (option.includes(":")) args[path] = option.slice(option.indexOf(":") + 1);
      else args.splice(path, 1);
    }
  }
  let physical = false;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") { index++; break; }
    if (arg === "-P" && command.name === "cd") physical = true;
    else if (arg === "-L" && command.name === "cd") physical = false;
    else if (arg.startsWith("-") && arg !== "-") return unknown;
    else break;
  }
  const operands = args.slice(index);
  if (operands.length > 1 || command.name !== "cd" && /^[+-]\d+$/.test(operands[0] ?? "")) return unknown;
  const stack = state.stack && [...state.stack];
  if (command.name === "popd" || command.name === "pushd" && !operands.length) {
    const next = stack?.pop();
    if (!next) return unknown;
    if (command.name === "pushd") stack?.push({ cwd: state.cwd, pwd: state.pwd });
    return { location: { ...next, stack }, mayFail: false };
  }
  const operand = operands[0];
  let value = operand === "-" ? effective.lookup("OLDPWD") : operand ?? effective.lookup("HOME");
  if (value == null) return unknown;
  // Only bash searches CDPATH. PowerShell's Set-Location, which `cd` names
  // there, reads no CDPATH in Windows PowerShell 5.1 or in PowerShell 7.
  const cdpath = effective.lookup("CDPATH");
  if (dialect === "bash" && command.name === "cd" && operand && !isAbsolute(value) && !/^\.{1,2}(?:\/|$)/.test(value)) {
    if (cdpath === null) return unknown;
    if (cdpath !== undefined) for (const entry of cdpathEntries(cdpath)) {
      const candidate = `${entry || "."}/${value}`;
      const path = state.place({ value: candidate }, dialect);
      if (path === null) return unknown;
      if (state.isDirectory(path)) { value = candidate; break; }
    }
  }
  const pwd = physical
    ? state.place({ value }, dialect)
    : isAbsolute(value) ? resolve(value) : state.pwd === null ? null : resolve(state.pwd, value);
  const cwd = pwd === null ? null : state.place({ value: pwd }, dialect);
  if (command.name === "pushd") stack?.push({ cwd: state.cwd, pwd: state.pwd });
  return { location: { cwd, pwd: cwd === null ? null : pwd, stack }, mayFail: cwd !== null && !state.isDirectory(cwd) };
}

/** The entries of CDPATH, which a colon separates. On a Windows host an entry
 *  can start with a drive, as in `C:/work`, and that colon separates nothing:
 *  split there, the entry would name `/work` on whatever drive the process
 *  runs from. */
function cdpathEntries(cdpath: string): string[] {
  const parts = cdpath.split(":");
  if (process.platform !== "win32") return parts;
  const entries: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? "";
    const rest = parts[index + 1];
    if (/^[A-Za-z]$/.test(part) && rest !== undefined && /^[\\/]/.test(rest)) {
      entries.push(`${part}:${rest}`);
      index++;
    } else entries.push(part);
  }
  return entries;
}
