import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { POSIX_FAILURE_STAGING } from "../../../helpers/posix-failure-staging.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Log } from "../../../../src/infra/log";
import { resolveOwnerPidPath } from "../../../../src/infra/paths";
import { bootIdentity, processStart } from "../../../../src/infra/process-container";
import { createProcessHolders, decodeHolderText, processHolders } from "../../../../src/infra/process-holder";
import { isSessionOwnerGone, removeOwnerPid, writeOwnerPid } from "../../../../src/orchestration/session/pid-lock";

const sessionId = "pid-lock-test";
/** 2^30 exceeds every platform's pid_max (Linux caps at 2^22), so the kernel
 *  reliably reports no process there. */
const DEAD_PID = 2 ** 30;
const own = processHolders.own() ?? expect.unreachable("the kernel did not give this test process its identity");
let baseDir: string;
let pidPath: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-pid-lock-"));
  pidPath = resolveOwnerPidPath(sessionId, baseDir);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("writeOwnerPid", () => {
  it("records this process's identity in a text an earlier build still reads as the pid", () => {
    writeOwnerPid(sessionId, baseDir);

    const text = fs.readFileSync(pidPath, "utf-8");
    expect(decodeHolderText(text)).toEqual({ kind: "identified", pid: process.pid, identity: own });
    expect(text).toBe(text.trim());
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(63);
    // An earlier build reads at most 64 bytes and takes the leading pid.
    // oxlint-disable-next-line unicorn/prefer-number-coercion -- the earlier build parses the leading digits only, which Number() does not
    expect(Number.parseInt(text, 10)).toBe(process.pid);
  });

  // A bare pid is the record an earlier build writes: a reader waits while
  // that pid runs and never takes the session over.
  it("records the pid alone while this process cannot read its own identity, and its identity once the read succeeds", () => {
    let failing = true;
    const holders = createProcessHolders({
      start: (pid) => (pid === process.pid && failing ? { kind: "unproven" } : processStart(pid)),
      boot: () => bootIdentity(),
    });
    const ownIdentity = spyOn(processHolders, "own").mockImplementation(() => holders.own());
    const warn = spyOn(Log.create({ service: "process-holder" }), "warn").mockImplementation(() => {});
    try {
      writeOwnerPid(sessionId, baseDir);
      expect(fs.readFileSync(pidPath, "utf-8")).toBe(String(process.pid));

      failing = false;
      writeOwnerPid(sessionId, baseDir);
      expect(decodeHolderText(fs.readFileSync(pidPath, "utf-8"))).toEqual({ kind: "identified", pid: process.pid, identity: own });
    } finally {
      ownIdentity.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("isSessionOwnerGone", () => {
  it("is gone when no owner.pid exists", () => {
    expect(isSessionOwnerGone(sessionId, baseDir)).toBe(true);
  });

  it("is not gone while this process owns the session", () => {
    writeOwnerPid(sessionId, baseDir);
    expect(isSessionOwnerGone(sessionId, baseDir)).toBe(false);
  });

  it("is gone after the record is removed", () => {
    writeOwnerPid(sessionId, baseDir);
    removeOwnerPid(sessionId, baseDir);
    expect(isSessionOwnerGone(sessionId, baseDir)).toBe(true);
  });

  it("is gone when the recorded pid now holds a process with another start stamp", () => {
    fs.writeFileSync(pidPath, [process.pid, 1, "1", ...(own.boot === undefined ? [] : [own.boot])].join(" "));
    expect(isSessionOwnerGone(sessionId, baseDir)).toBe(true);
  });

  it.skipIf(own.boot === undefined)("is gone when the record names another boot, even with this process's pid and start", () => {
    fs.writeFileSync(pidPath, `${process.pid} 1 ${own.start} ${"0".repeat(32)}`);
    expect(isSessionOwnerGone(sessionId, baseDir)).toBe(true);
  });

  it("keeps a record whose identity version this build does not know, even when its pid is free", () => {
    fs.writeFileSync(pidPath, `${DEAD_PID} 7 5 ${"a".repeat(32)}`);
    expect(isSessionOwnerGone(sessionId, baseDir)).toBe(false);
  });

  it.skipIf(!POSIX_FAILURE_STAGING)("keeps a record it cannot read, and warns once for the session", () => {
    writeOwnerPid(sessionId, baseDir);
    fs.chmodSync(pidPath, 0o000);
    const warn = spyOn(Log.create({ service: "session-pid-lock" }), "warn").mockImplementation(() => {});
    try {
      expect(isSessionOwnerGone(sessionId, baseDir)).toBe(false);
      expect(isSessionOwnerGone(sessionId, baseDir)).toBe(false);
      expect(warn.mock.calls.map(([, fields]) => fields?.code)).toEqual(["EACCES"]);
    } finally {
      warn.mockRestore();
      fs.chmodSync(pidPath, 0o600);
    }
  });

  describe("a record an earlier build wrote, a bare pid", () => {
    it("is not gone while its pid runs", () => {
      fs.writeFileSync(pidPath, String(process.pid));
      expect(isSessionOwnerGone(sessionId, baseDir)).toBe(false);
    });

    it("is gone for a pid beyond the OS pid range", () => {
      fs.writeFileSync(pidPath, String(DEAD_PID));
      expect(isSessionOwnerGone(sessionId, baseDir)).toBe(true);
    });

    it.skipIf(!POSIX_FAILURE_STAGING)("is not gone while its pid runs as another user", () => {
      // pid 1 (init or launchd) always exists and, for a test that does not
      // run as root, belongs to another user. The kernel still answers for
      // it, so the owner reads as live.
      fs.writeFileSync(pidPath, "1");
      expect(isSessionOwnerGone(sessionId, baseDir)).toBe(false);
    });
  });

  it("is gone for garbled record content", () => {
    fs.writeFileSync(pidPath, "not-a-pid");
    expect(isSessionOwnerGone(sessionId, baseDir)).toBe(true);
  });
});
