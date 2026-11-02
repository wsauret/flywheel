export type RuntimePlatform = typeof process.platform;

/** Runtime-owned managed command scripts and output spools share this namespace. */
export const BACKGROUND_COMMAND_FILE_PREFIX = "flywheel-agent-bg-";
export const FOREGROUND_COMMAND_FILE_PREFIX = "flywheel-foreground-";

export function isWindows(platform: RuntimePlatform): boolean {
  return platform === "win32";
}

function buildBashScript(command: string, trace: boolean): string {
  const lines: string[] = [];
  if (trace) lines.push("exec 9>&2");
  lines.push("exec 2>&1");
  // BASH_XTRACEFD needs bash >= 4.1. Older bash (macOS system /bin/bash is
  // 3.2) ignores it and writes xtrace to fd 2, which the line above merges
  // into recorded stdout; there trace degrades to off instead of corrupting
  // the recorded output.
  if (trace) lines.push('case "$BASH_VERSION" in [1-3].*|4.0*) ;; *) BASH_XTRACEFD=9; set -x;; esac');
  lines.push(command.trimEnd());
  return lines.join("\n");
}

/** Windows PowerShell 5.1 writes `>`, `>>`, `Out-File`, and `Tee-Object`
 *  output as UTF-16LE, so `echo text > file` succeeded and left a file that no
 *  UTF-8 reader could read, where bash writes the same command as UTF-8.
 *  5.1 has no BOM-less UTF-8 value, so this gives UTF-8 with a BOM there;
 *  PowerShell 7 reads `utf8` as UTF-8 without a BOM. */
const POWERSHELL_PREAMBLE = [
  "$ErrorActionPreference = 'Continue'",
  "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
] as const;

function buildPowerShellScript(command: string): string {
  const body = command.trimEnd();
  return [
    ...POWERSHELL_PREAMBLE,
    "& {",
    body,
    "} *>&1",
    "$success = $?",
    "$nativeExitCode = $global:LASTEXITCODE",
    "if ($nativeExitCode -ne $null) { exit $nativeExitCode }",
    "if ($success) { exit 0 }",
    "exit 1",
  ].join("\n");
}

export function buildShellScript(command: string, platform: RuntimePlatform, trace: boolean): string {
  return isWindows(platform) ? buildPowerShellScript(command) : buildBashScript(command, trace);
}

export function scriptExtension(platform: RuntimePlatform): "ps1" | "sh" {
  return isWindows(platform) ? "ps1" : "sh";
}

export function shellInvocation(platform: RuntimePlatform, scriptPath: string): string[] {
  return isWindows(platform)
    ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
    : ["bash", scriptPath];
}

/** Builds the inline shell command used by persistent execution. The platform branch stays in the shell authority so callers cannot accidentally force Bash on Windows. */
export function shellCommandInvocation(platform: RuntimePlatform, command: string): string[] {
  return isWindows(platform)
    ? ["powershell.exe", "-NoProfile", "-Command", buildShellScript(command, platform, false)]
    : ["bash", "-lc", command];
}

export function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The spool owns the OS standard handles, not only PowerShell records, so
 *  raw writes and inherited child output remain captured after handover.
 *  Auto-flush keeps the log readable while the command runs or is terminated.
 *  Explicit exit preserves the native program's status under `-File`.
 *
 *  `SetStdHandle` is bound in memory through Reflection.Emit, not compiled
 *  with `Add-Type`: Windows PowerShell 5.1 compiles through csc.exe into a
 *  `%TEMP%` folder that only a clean process exit removes, so every command
 *  that a person or the runtime ended left an empty folder behind. The log is
 *  opened inheritable, so native children receive the handle. */
function buildPowerShellBackgroundScript(command: string, logPath: string): string {
  const body = command.trimEnd();
  return [
    ...POWERSHELL_PREAMBLE,
    "$flywheelImport = [System.Runtime.InteropServices.DllImportAttribute]",
    "$flywheelType = [System.Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([System.Reflection.AssemblyName]::new('FlywheelStreams'), 'Run').DefineDynamicModule('FlywheelStreams').DefineType('FlywheelStreams', 'Public, Abstract, Sealed')",
    "$flywheelType.DefineMethod('SetStdHandle', 'Public, Static, PinvokeImpl', [bool], [type[]]@([int], [IntPtr])).SetCustomAttribute([System.Reflection.Emit.CustomAttributeBuilder]::new($flywheelImport.GetConstructor([type[]]@([string])), [object[]]@('kernel32.dll'), [System.Reflection.FieldInfo[]]@($flywheelImport.GetField('SetLastError')), [object[]]@($true)))",
    "$flywheelStreams = $flywheelType.CreateType()",
    `$flywheelFile = [System.IO.File]::Open(${quotePowerShell(logPath)}, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read -bor [System.IO.FileShare]::Inheritable)`,
    "try {",
    "$flywheelHandle = $flywheelFile.SafeFileHandle.DangerousGetHandle()",
    "if (-not $flywheelStreams::SetStdHandle(-11, $flywheelHandle)) { throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
    "if (-not $flywheelStreams::SetStdHandle(-12, $flywheelHandle)) { throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
    // FileStream caches its position and rejects writes after a native child
    // advances the shared handle. ConsoleStream writes without that cache.
    "$flywheelLog = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), [System.Text.UTF8Encoding]::new($false))",
    "$flywheelLog.AutoFlush = $true",
    "try {",
    "[Console]::SetOut($flywheelLog)",
    "[Console]::SetError($flywheelLog)",
    "& {",
    body,
    "} *>&1 | ForEach-Object { $flywheelLog.WriteLine([string]$_) }",
    "$success = $?",
    "$nativeExitCode = $global:LASTEXITCODE",
    "} catch {",
    "$flywheelLog.WriteLine([string]$_)",
    "$success = $false",
    "$nativeExitCode = $null",
    "} finally {",
    "$flywheelLog.Dispose()",
    "}",
    "} finally {",
    "$flywheelFile.Dispose()",
    "}",
    "if ($nativeExitCode -ne $null) { exit $nativeExitCode }",
    "if ($success) { exit 0 }",
    "exit 1",
  ].join("\n");
}

export function quoteBashSingle(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The POSIX log is created first in a subshell with a private umask, so it
 *  is readable only by this account; the redirect then keeps that mode, and
 *  the command runs under its own umask. */
export function buildBackgroundScript(command: string, logPath: string, platform: RuntimePlatform): string {
  if (isWindows(platform)) return buildPowerShellBackgroundScript(command, logPath);
  const log = quoteBashSingle(logPath);
  return [`(umask 077 && : >${log})`, `exec >${log} 2>&1`, command.trimEnd()].join("\n");
}

export function buildBunShim(execPath: string, platform: RuntimePlatform): string {
  return isWindows(platform)
    ? `@echo off\r\nset BUN_BE_BUN=1\r\n"${execPath}" %*\r\n`
    : `#!/bin/sh\nexec env BUN_BE_BUN=1 "${execPath}" "$@"\n`;
}
