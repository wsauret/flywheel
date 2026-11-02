/** What `flywheel update` tells an operator, and when it fails.
 *
 *  The command's whole user-visible surface is one line per outcome and an
 *  exit code, so that mapping is tested directly. The wiring it does not own -
 *  the lease, the check, the policy, the installer - belongs to the
 *  coordinator and is proved there. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StartupDirectories } from "../../../src/infra/directory-authorities.js";
import type { LauncherContext, LauncherScope } from "../../../src/infra/process-supervisor.js";
import { runUpdate, updateReport } from "../../../src/cli/update.js";

const originalLog = console.log;
const originalError = console.error;
let out: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  out = [];
  errors = [];
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  process.exitCode = undefined;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = 0;
});

const directories: StartupDirectories = { userDataRoot: "/nowhere/.flywheel", accountHome: "/nowhere", projectRoot: "/nowhere", executionCwd: "/nowhere" };

/** A launcher that refuses to launch. An argument-parsing run must answer
 *  before it ever needs one. */
const refusingScope: LauncherScope = {
  spawnOwned: () => Promise.reject(new Error("a unit test never launches a process")),
  adoptOwned: () => Promise.reject(new Error("a unit test never adopts a command")),
  open: () => refusingScope,
  close: () => Promise.resolve({ settled: true }),
};
const launcher: LauncherContext = {
  scope: refusingScope,
  guardian: {
    openGeneration: () => Promise.reject(new Error("a unit test never opens a guardian generation")),
    pid: () => Promise.reject(new Error("a unit test never starts a guardian")),
  },
  startGuardian: () => Promise.reject(new Error("a unit test never starts a guardian")),
};

describe("the update command's arguments", () => {
  test("prints its own usage for --help and installs nothing", async () => {
    await runUpdate(["--help"], directories, launcher);

    expect(out.join("\n")).toContain("Usage: flywheel update");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("its help states that a manual run does not bypass the durable control", async () => {
    await runUpdate(["--help"], directories, launcher);

    expect(out.join("\n")).toContain("does not bypass the durable update control");
    expect(out.join("\n")).toContain("while automatic updates are off");
  });

  test("refuses an argument it does not take, and says what it takes", async () => {
    await runUpdate(["--force"], directories, launcher);

    expect(errors.join("\n")).toContain("Unknown update argument: --force");
    expect(errors.join("\n")).toContain("Usage: flywheel update");
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

describe("what one run reports", () => {
  test("an installed release names the version and says a restart is needed", () => {
    expect(updateReport({ kind: "installed", version: "1.5.0" }, "1.4.0")).toEqual({
      message: "Flywheel 1.5.0 is installed. Restart Flywheel to use it.",
      failed: false,
    });
  });

  test("a build that is already newest names the version it is running", () => {
    expect(updateReport({ kind: "current" }, "1.4.0")).toEqual({ message: "Flywheel 1.4.0 is the newest release.", failed: false });
  });

  test("an available release that was not installed says so without claiming an install", () => {
    expect(updateReport({ kind: "available", version: "1.5.0" }, "1.4.0")).toEqual({
      message: "Flywheel 1.5.0 is available, and was not installed.",
      failed: false,
    });
  });

  test("a disabled policy is reported as guidance, not as a failure", () => {
    const report = updateReport({ kind: "policy-blocked", version: "1.5.0" }, "1.4.0");

    expect(report.failed).toBe(false);
    expect(report.message).toContain("Flywheel 1.5.0 is available");
    expect(report.message).toContain("Automatic updates are off");
    expect(report.message).toContain("nothing was downloaded");
  });

  test("a release a rollback refused is reported as the reason nothing was installed, not as a failure", () => {
    const report = updateReport({ kind: "refused", version: "1.5.0" }, "1.4.0");

    expect(report).toEqual({
      message: "Flywheel 1.5.0 is available, but it was rolled back on this account because it could not start its account service or could not open any project here, so it is not installed again. A newer release installs normally.",
      failed: false,
    });
  });

  test("another claimant of the account is an ordinary outcome", () => {
    expect(updateReport({ kind: "busy" }, "1.4.0")).toEqual({
      message: "Another Flywheel process is updating this account. Try again shortly.",
      failed: false,
    });
  });

  test("a recent account-wide check is an ordinary outcome", () => {
    expect(updateReport({ kind: "fresh" }, "1.4.0").failed).toBe(false);
  });

  test("a failed run carries the reason and fails the command", () => {
    expect(updateReport({ kind: "failed", reason: "the release metadata request answered 503" }, "1.4.0")).toEqual({
      message: "The update could not be completed: the release metadata request answered 503",
      failed: true,
    });
  });

  test("a cancelled run fails the command", () => {
    expect(updateReport({ kind: "cancelled" }, "1.4.0").failed).toBe(true);
  });
});
