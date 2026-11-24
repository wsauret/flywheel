import { describe, expect, test } from "bun:test"

import { GATE_HOOK_DEADLINE_MS, GATE_HOOK_TIMEOUT_SECONDS } from "../../../../../src/infra/antigravity-gate-hook.js"
import { executableRoleCommand } from "../../../../../src/infra/cli-subprocess.js"
import { EXECUTABLE_ROLES } from "../../../../../src/infra/executable-roles.js"
import { gateHookHandler } from "../../../../../src/orchestration/modules/provider-google-antigravity/hook-command.js"

describe("gate hook handler", () => {
  test("runs the running executable's gate role with the address and gate id after it", () => {
    const handler = gateHookHandler({ address: "/run/fw-agy-501/gate.sock", loginGateId: "gate-1" })

    const explicit = gateHookHandler({ address: "/run/fw-agy-501/gate.sock", loginGateId: "gate-1", entry: executableRoleCommand(EXECUTABLE_ROLES.antigravityGate) })
    expect(handler).toEqual({ type: "command", command: explicit.command, timeout: GATE_HOOK_TIMEOUT_SECONDS })
    expect(handler.command).toStartWith(process.execPath)
    expect(handler.command).toEndWith(`${EXECUTABLE_ROLES.antigravityGate} /run/fw-agy-501/gate.sock gate-1`)
  })

  // A killed hook lets the step proceed, so the client must print terminate
  // before the engine's timeout, also after a cold start of the executable,
  // which took 1.9 s for the first call of a new compiled binary.
  test("the client deadline ends inside the hook timeout with room to start", () => {
    const startMarginMs = 3_000
    expect(GATE_HOOK_DEADLINE_MS + startMarginMs).toBeLessThan(GATE_HOOK_TIMEOUT_SECONDS * 1_000)
  })

  // A scratch probe ran this exact string through `sh -c` and received the
  // argument vector back unchanged; unit tests launch no shell.
  test("the POSIX form single-quotes words with shell syntax and escapes their quotes", () => {
    const { command } = gateHookHandler({
      address: "/scratch/it's a dir/gate $HOME `x` \"q\".sock",
      loginGateId: "gate-1",
      entry: ["/opt/it's a dir/print argv", EXECUTABLE_ROLES.antigravityGate],
      platform: "darwin",
    })

    expect(command).toBe("'/opt/it'\\''s a dir/print argv' --internal-role=antigravity-gate '/scratch/it'\\''s a dir/gate $HOME `x` \"q\".sock' gate-1")
  })

  test("the Windows form quotes only the words that need it", () => {
    const { command } = gateHookHandler({
      address: String.raw`\\.\pipe\fw-agy-1000`,
      loginGateId: "gate-1",
      entry: [String.raw`C:\Users\Ada Lovelace\AppData\Local\flywheel\flywheel.exe`, EXECUTABLE_ROLES.antigravityGate],
      platform: "win32",
    })

    expect(command).toBe(String.raw`"C:\Users\Ada Lovelace\AppData\Local\flywheel\flywheel.exe" --internal-role=antigravity-gate \\.\pipe\fw-agy-1000 gate-1`)
  })

  // agy 1.5.14 on Windows started a hook from the folder `P 100% x!y` with
  // its argument vector intact.
  test("the Windows form carries a lone percent sign and exclamation mark", () => {
    const { command } = gateHookHandler({
      address: String.raw`\\.\pipe\fw-agy-1000`,
      loginGateId: "gate-1",
      entry: [String.raw`C:\P 100% x!y\flywheel.exe`, EXECUTABLE_ROLES.antigravityGate],
      platform: "win32",
    })

    expect(command).toBe(String.raw`"C:\P 100% x!y\flywheel.exe" --internal-role=antigravity-gate \\.\pipe\fw-agy-1000 gate-1`)
  })

  test.each([
    ["a variable reference", String.raw`C:\Users\%USERNAME%\flywheel.exe`],
    ["a delayed variable reference", String.raw`C:\Users\!USERNAME!\flywheel.exe`],
    ["a double quote", String.raw`C:\Users\a"b\flywheel.exe`],
  ])("the Windows form refuses %s, which cmd.exe changes", (_name, executable) => {
    expect(() => gateHookHandler({
      address: String.raw`\\.\pipe\fw-agy-1000`,
      loginGateId: "gate-1",
      entry: [executable, EXECUTABLE_ROLES.antigravityGate],
      platform: "win32",
    })).toThrow("cannot carry")
  })

  test("the Windows form refuses percent signs of two words that pair into a variable reference", () => {
    expect(() => gateHookHandler({
      address: String.raw`\\.\pipe\fw-agy-%x`,
      loginGateId: "y%",
      entry: [String.raw`C:\flywheel\flywheel.exe`, EXECUTABLE_ROLES.antigravityGate],
      platform: "win32",
    })).toThrow("cmd.exe expands")
  })
})
