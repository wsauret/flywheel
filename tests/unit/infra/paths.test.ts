import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { accountAuthDir, accountHubOrigin, accountHubPort, accountServeDir, accountServeRecordPath, accountServeSocketPath, accountServeStartLockPath, accountServeTokenPath, authDir, availabilityAuthorityDbFile, configurationReferenceFile, globalConfigFile, projectWebPort, projectWebTokenPath, requireAuthProfileDisplayName, requireAuthProfileName, resolveOwnerPidPath, toFileUri } from "../../../src/infra/paths";

describe("availabilityAuthorityDbFile", () => {
  // Every account-global path derives from the startup-selected data root, so
  // the test states one root instead of redirecting the process environment.
  const userDataRoot = path.join(path.resolve("/scratch/flywheel-paths-test-home"), ".flywheel");

  it("resolves a protocol-versioned file in the same global directory as the config file", () => {
    expect(availabilityAuthorityDbFile(userDataRoot, 4)).toBe(path.join(userDataRoot, "availability-authority-v4.sqlite"));
    expect(path.dirname(availabilityAuthorityDbFile(userDataRoot, 4))).toBe(path.dirname(globalConfigFile(userDataRoot)));
  });

  it("places the generated configuration reference beside the global config", () => {
    expect(configurationReferenceFile(userDataRoot)).toBe(path.join(userDataRoot, "configuration.md"));
  });
});

describe("auth profile paths", () => {
  const userDataRoot = path.join(path.resolve("/scratch/flywheel-paths-test-home"), ".flywheel");

  it("keeps account credentials separate from validated profile credentials", () => {
    expect(accountAuthDir(userDataRoot)).toBe(path.join(userDataRoot, "auth"));
    expect(authDir(userDataRoot, "work")).toBe(path.join(userDataRoot, "auth", "profiles", "work"));
  });

  it.each(["", " ", "\t", ".", "..", "a/b", "a\\b", "a\0b", "a\nb", "a\u007fb", "a\u0085b"])("rejects invalid profile name %j", (name) => {
    expect(() => requireAuthProfileName(name)).toThrow();
  });

  it("accepts printable display names that are not valid directory ids", () => {
    expect(requireAuthProfileDisplayName("Work / Personal")).toBe("Work / Personal");
    expect(() => requireAuthProfileDisplayName("bad\nname")).toThrow();
  });
});

describe("resolveOwnerPidPath", () => {
  it("resolves the pid lock under .flywheel/sessions/<sessionId>/", () => {
    const baseDir = "/work";
    const sessionId = "abc123";
    const resolved = resolveOwnerPidPath(sessionId, baseDir);
    expect(resolved).toBe(path.resolve(baseDir, ".flywheel/sessions/abc123/owner.pid"));
  });

});

describe("toFileUri", () => {
  it("escapes file URI characters through the platform URL implementation", () => {
    // What this proves is the escaping, not the drive a POSIX literal lands on:
    // "/scratch" resolves onto the current drive on Windows.
    const uri = toFileUri("file with spaces.txt", path.resolve("/scratch/flywheel uri test"));
    expect(uri.startsWith("file:///")).toBe(true);
    expect(uri).toContain("flywheel%20uri%20test/file%20with%20spaces.txt");
  });
});

describe("account serving paths", () => {
  const userDataRoot = path.join(path.resolve("/scratch/flywheel-paths-test-home"), ".flywheel");

  it("places the installed lane's fixed POSIX rendezvous and private records in the directory it always had", () => {
    const directory = accountServeDir(userDataRoot, "installed");
    expect(directory).toBe(path.join(userDataRoot, "serve"));
    expect(accountServeSocketPath(userDataRoot, "installed", "linux")).toBe(path.join(directory, "serve.sock"));
    expect(accountServeRecordPath(userDataRoot, "installed")).toBe(path.join(directory, "serve.json"));
    expect(accountServeTokenPath(userDataRoot, "installed")).toBe(path.join(directory, "serve.token"));
    expect(accountServeStartLockPath(userDataRoot, "installed")).toBe(path.join(directory, "serve.start.lock"));
  });

  it("gives the dev lane a sibling directory so a dev serve never shares a rendezvous with the installed service", () => {
    const directory = accountServeDir(userDataRoot, "dev");
    expect(directory).toBe(path.join(userDataRoot, "serve-dev"));
    expect(accountServeSocketPath(userDataRoot, "dev", "linux")).toBe(path.join(directory, "serve.sock"));
    expect(accountServeRecordPath(userDataRoot, "dev")).toBe(path.join(directory, "serve.json"));
    expect(accountServeTokenPath(userDataRoot, "dev")).toBe(path.join(directory, "serve.token"));
    expect(accountServeStartLockPath(userDataRoot, "dev")).toBe(path.join(directory, "serve.start.lock"));
  });

  it("uses an account digest and the lane for the Windows named pipe", () => {
    const first = accountServeSocketPath(userDataRoot, "installed", "win32");
    expect(first).toMatch(/^\\\\\.\\pipe\\flywheel-serve-[0-9a-f]{16}$/);
    expect(accountServeSocketPath(`${userDataRoot}-other`, "installed", "win32")).not.toBe(first);
    expect(accountServeSocketPath(userDataRoot, "dev", "win32")).toMatch(/^\\\\\.\\pipe\\flywheel-serve-dev-[0-9a-f]{16}$/);
  });

  it("keeps a project's browser token with the project, whichever lane serves it", () => {
    expect(projectWebTokenPath(userDataRoot, "/work/alpha")).toStartWith(path.join(userDataRoot, "serve") + path.sep);
  });

  it("gives each lane its own fixed hub port, both outside the project web port range", () => {
    expect(accountHubPort("installed")).toBe(41_000);
    expect(accountHubPort("dev")).toBe(40_999);
    expect(accountHubOrigin("installed")).toBe("http://127.0.0.1:41000");
    expect(accountHubOrigin("dev")).toBe("http://127.0.0.1:40999");
    expect(projectWebPort("/work/alpha")).toBeGreaterThan(accountHubPort("installed"));
  });

  it("gives two known projects that prefer one port two ports, in registration order", () => {
    // These two roots prefer the same port.
    const [alpha, beta] = ["/work/alpha", "/work/beta2336"];
    expect(projectWebPort(beta)).toBe(projectWebPort(alpha));
    expect(projectWebPort(alpha, [alpha, beta])).toBe(projectWebPort(alpha));
    expect(projectWebPort(beta, [alpha, beta])).toBe(projectWebPort(alpha) + 1);
    expect(projectWebPort(beta, [alpha])).toBe(projectWebPort(alpha) + 1);
    expect(projectWebPort(alpha, [beta, alpha])).toBe(projectWebPort(alpha) + 1);
  });
});
