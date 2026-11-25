import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeGitDirectory, readGitMetadata } from "../../../../src/infra/platform/git-metadata.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const tempDir = temporaryDirectories();

describe("decodeGitDirectory", () => {
  it("resolves a gitdir pointer against the directory that holds the entry", () => {
    const entry = resolve("/scratch", "worktree", ".git");

    expect(decodeGitDirectory(entry, "gitdir: ../main/.git/worktrees/feature\n")).toBe(resolve("/scratch", "main", ".git", "worktrees", "feature"));
    expect(decodeGitDirectory(entry, "gitdir: /scratch/elsewhere/.git\n")).toBe(resolve("/scratch", "elsewhere", ".git"));
  });

  it("returns undefined for a malformed pointer", () => {
    const entry = resolve("/scratch", "worktree", ".git");

    expect(decodeGitDirectory(entry, "")).toBeUndefined();
    expect(decodeGitDirectory(entry, "gitdir:   \n")).toBeUndefined();
    expect(decodeGitDirectory(entry, "not a pointer\n")).toBeUndefined();
  });
});

describe("readGitMetadata", () => {
  it("returns undefined when the entry does not exist", () => {
    expect(readGitMetadata(join(tempDir("flywheel-git-metadata-"), ".git"))).toBeUndefined();
  });

  it("uses a .git directory as both the Git directory and the common directory", () => {
    const gitDir = join(tempDir("flywheel-git-metadata-"), ".git");
    mkdirSync(gitDir);

    expect(readGitMetadata(gitDir)).toEqual({ gitDir, commonDir: gitDir });
  });

  it("follows the gitdir pointer in a .git file", () => {
    const root = tempDir("flywheel-git-metadata-");
    const gitDir = join(root, "main", ".git");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(join(root, "linked"));
    const entry = join(root, "linked", ".git");
    writeFileSync(entry, "gitdir: ../main/.git\n");

    expect(readGitMetadata(entry)).toEqual({ gitDir, commonDir: gitDir });
  });

  it("returns undefined when a .git file holds a malformed pointer", () => {
    const entry = join(tempDir("flywheel-git-metadata-"), ".git");
    writeFileSync(entry, "not a pointer\n");

    expect(readGitMetadata(entry)).toBeUndefined();
  });

  it("resolves the commondir file against the per-worktree Git directory", () => {
    const root = tempDir("flywheel-git-metadata-");
    const commonDir = join(root, "main", ".git");
    const gitDir = join(commonDir, "worktrees", "linked");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    mkdirSync(join(root, "linked"));
    const entry = join(root, "linked", ".git");
    writeFileSync(entry, `gitdir: ${gitDir}\n`);

    expect(readGitMetadata(entry)).toEqual({ gitDir, commonDir });
  });

  it("treats an empty commondir file as no common directory", () => {
    const gitDir = join(tempDir("flywheel-git-metadata-"), ".git");
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, "commondir"), "\n");

    expect(readGitMetadata(gitDir)).toEqual({ gitDir, commonDir: gitDir });
  });
});
