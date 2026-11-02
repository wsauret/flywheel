import { afterEach, describe, expect, it } from "bun:test";
import { join, resolve, win32 } from "node:path";

import { bootstrapInstallerUrl, installedLauncherPath, updateRepository } from "../../../src/protocol/installation";
import { OFFICIAL_RELEASE_REPOSITORY } from "../../../scripts/release-contract";

describe("the bootstrap installer address", () => {
  it("names the shell installer of the latest release on Unix", () => {
    expect(bootstrapInstallerUrl("darwin", OFFICIAL_RELEASE_REPOSITORY)).toBe("https://github.com/wsauret/flywheel/releases/latest/download/install.sh");
    expect(bootstrapInstallerUrl("linux", OFFICIAL_RELEASE_REPOSITORY)).toBe("https://github.com/wsauret/flywheel/releases/latest/download/install.sh");
  });

  it("names the PowerShell installer on Windows", () => {
    expect(bootstrapInstallerUrl("win32", OFFICIAL_RELEASE_REPOSITORY)).toBe("https://github.com/wsauret/flywheel/releases/latest/download/install.ps1");
  });

  it("follows a repository override the way the installers do", () => {
    expect(bootstrapInstallerUrl("linux", "someone/fork")).toBe("https://github.com/someone/fork/releases/latest/download/install.sh");
  });
});

describe("the update repository", () => {
  // A built binary has FLYWHEEL_UPDATE_REPOSITORY compiled in; a source run reads it from the environment.
  const saved = { FLYWHEEL_REPO: process.env.FLYWHEEL_REPO, FLYWHEEL_UPDATE_REPOSITORY: process.env.FLYWHEEL_UPDATE_REPOSITORY };
  const set = (name: keyof typeof saved, value: string | undefined) => { if (value === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = value; };
  afterEach(() => { set("FLYWHEEL_REPO", saved.FLYWHEEL_REPO); set("FLYWHEEL_UPDATE_REPOSITORY", saved.FLYWHEEL_UPDATE_REPOSITORY); });

  it("is none for a build that compiled in none, so it never updates", () => {
    set("FLYWHEEL_REPO", undefined);
    for (const compiled of [undefined, ""]) {
      set("FLYWHEEL_UPDATE_REPOSITORY", compiled);
      expect(updateRepository()).toBeUndefined();
    }
  });

  it("is the compiled repository, and FLYWHEEL_REPO overrides it", () => {
    set("FLYWHEEL_REPO", undefined);
    set("FLYWHEEL_UPDATE_REPOSITORY", "someone/fork");
    expect(updateRepository()).toBe("someone/fork");
    set("FLYWHEEL_REPO", "someone/other");
    expect(updateRepository()).toBe("someone/other");
  });
});

describe("the installed launcher", () => {
  it("is the wrapper in the account's local bin directory on Unix", () => {
    expect(installedLauncherPath("darwin", {}, "/home/a")).toBe(join("/home/a", ".local", "bin", "flywheel"));
  });

  it("is the wrapper in FLYWHEEL_INSTALL_DIR when the installer was told one", () => {
    const installDirectory = resolve("/opt/fw/bin");
    expect(installedLauncherPath("linux", { FLYWHEEL_INSTALL_DIR: installDirectory }, "/home/a")).toBe(join(installDirectory, "flywheel"));
  });

  it("treats an empty FLYWHEEL_INSTALL_DIR as unset, as the installers do", () => {
    expect(installedLauncherPath("linux", { FLYWHEEL_INSTALL_DIR: "" }, "/home/a")).toBe(join("/home/a", ".local", "bin", "flywheel"));
    expect(installedLauncherPath("win32", { FLYWHEEL_INSTALL_DIR: "", LOCALAPPDATA: String.raw`C:\Users\a\AppData\Local` }, String.raw`C:\Users\a`))
      .toBe(String.raw`C:\Users\a\AppData\Local\Flywheel\bin\flywheel.exe`);
  });

  it("is the launcher under LOCALAPPDATA on Windows", () => {
    expect(installedLauncherPath("win32", { LOCALAPPDATA: String.raw`C:\Users\a\AppData\Local` }, String.raw`C:\Users\a`))
      .toBe(String.raw`C:\Users\a\AppData\Local\Flywheel\bin\flywheel.exe`);
  });

  it("falls back to the account home on Windows when LOCALAPPDATA is unset", () => {
    const localAppData = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      expect(installedLauncherPath("win32", {}, String.raw`C:\Users\a`)).toBe(win32.join(String.raw`C:\Users\a`, ".flywheel", "bin", "flywheel.exe"));
    } finally {
      if (localAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = localAppData;
    }
  });

  it("is the launcher in FLYWHEEL_INSTALL_DIR on Windows", () => {
    expect(installedLauncherPath("win32", { FLYWHEEL_INSTALL_DIR: String.raw`D:\tools\flywheel`, LOCALAPPDATA: String.raw`C:\L` }, String.raw`C:\Users\a`))
      .toBe(String.raw`D:\tools\flywheel\flywheel.exe`);
  });
});
