import { describe, it, expect, mock, beforeEach } from "bun:test"
import { isProcessAlive } from "../src/worker/tree-kill"

// ---------------------------------------------------------------------------
// isProcessAlive()
// ---------------------------------------------------------------------------

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it("returns false for a non-existent PID", () => {
    // PID 99999999 is extremely unlikely to exist
    expect(isProcessAlive(99999999)).toBe(false)
  })

  it("returns false for PID 0 on most systems or handles edge case", () => {
    // PID 0 is the kernel scheduler — kill(0, 0) checks the current process group
    // The behavior varies, but it should not throw
    const result = isProcessAlive(0)
    expect(typeof result).toBe("boolean")
  })
})

// ---------------------------------------------------------------------------
// treeKillWithEscalation()
// ---------------------------------------------------------------------------

describe("treeKillWithEscalation", () => {
  it("kills a real child process with SIGTERM (no escalation needed)", async () => {
    // Spawn a simple sleep process
    const child = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    })

    const pid = child.pid
    expect(isProcessAlive(pid)).toBe(true)

    // Import dynamically to avoid module-level side effects
    const { treeKillWithEscalation } = await import("../src/worker/tree-kill")

    await treeKillWithEscalation(pid, { graceMs: 2000, pollMs: 20 })

    // Process should be dead now
    expect(isProcessAlive(pid)).toBe(false)
  })

  it("handles already-dead process gracefully", async () => {
    const child = Bun.spawn(["true"], {
      stdout: "ignore",
      stderr: "ignore",
    })

    // Wait for it to finish
    await child.exited

    const { treeKillWithEscalation } = await import("../src/worker/tree-kill")

    // Should not throw even though process is already dead
    await treeKillWithEscalation(child.pid, { graceMs: 100, pollMs: 10 })
  })

  it("escalates to SIGKILL for a stubborn process (trap SIGTERM)", async () => {
    // Spawn a process that traps SIGTERM and ignores it
    const child = Bun.spawn(
      ["bash", "-c", "trap '' SIGTERM; sleep 60"],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    )

    const pid = child.pid

    // Give the trap a moment to install
    await new Promise((r) => setTimeout(r, 200))
    expect(isProcessAlive(pid)).toBe(true)

    const { treeKillWithEscalation } = await import("../src/worker/tree-kill")

    await treeKillWithEscalation(pid, { graceMs: 300, pollMs: 20 })

    // Process should be dead after SIGKILL escalation
    expect(isProcessAlive(pid)).toBe(false)
  })

  it("process that dies immediately needs no escalation (fast path)", async () => {
    // Spawn a process that exits on SIGTERM (default behavior)
    const child = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    })

    const pid = child.pid
    expect(isProcessAlive(pid)).toBe(true)

    const { treeKillWithEscalation } = await import("../src/worker/tree-kill")

    const start = Date.now()
    await treeKillWithEscalation(pid, { graceMs: 5000, pollMs: 10 })
    const elapsed = Date.now() - start

    // Should complete well before the grace period since sleep respects SIGTERM
    expect(elapsed).toBeLessThan(3000)
    expect(isProcessAlive(pid)).toBe(false)
  })
})
