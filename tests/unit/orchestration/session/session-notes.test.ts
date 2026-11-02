import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConversationResources } from "../../../../src/orchestration/session/conversation-resources.js";
import { deleteSessionArtifacts, deleteWorkflowArtifacts } from "../../../../src/orchestration/session/session-artifacts.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

describe("session notes", () => {
  const temporaryDirectory = temporaryDirectories();

  it("derives an isolated notes directory from the durable conversation identity", () => {
    expect(resolveConversationResources("/sessions/s1", "conversation:Ä/One")).toEqual({
      scratchDir: join("/sessions/s1", "scratch"),
      notesDirectory: join("/sessions/s1", "scratch", "notes", "636f6e766572736174696f6e3ac3842f4f6e65"),
    });
  });

  it("uses the review key instead of the source conversation and keeps scratch without a notes key", () => {
    expect(resolveConversationResources("/sessions/s1", "source", "review")).toEqual({
      scratchDir: join("/sessions/s1", "scratch"),
      notesDirectory: join("/sessions/s1", "scratch", "notes", "726576696577"),
    });
    expect(resolveConversationResources("/sessions/s1")).toEqual({ scratchDir: join("/sessions/s1", "scratch") });
    expect(resolveConversationResources(undefined, "source", "review")).toEqual({});
  });

  it("keeps imported notes at their exact old path until workflow deletion", () => {
    const root = temporaryDirectory("imported-notes-");
    const old = join(root, ".flywheel", "sessions", "old");
    const member = join(root, ".flywheel", "sessions", "member");
    const imported = resolveConversationResources(member, "new-key", undefined, { workflowId: "old", conversationId: "original-key" });
    const original = resolveConversationResources(old, "original-key");
    expect(imported).toEqual(original);
    mkdirSync(imported.notesDirectory!, { recursive: true });
    const checkpoint = join(imported.notesDirectory!, "checkpoint.md");
    writeFileSync(checkpoint, "retained");
    deleteSessionArtifacts("member", root);
    expect(existsSync(checkpoint)).toBe(true);
    deleteWorkflowArtifacts("old", root);
    expect(existsSync(checkpoint)).toBe(false);
  });

  it("removes every note only when the owning session is deleted", () => {
    const projectRoot = temporaryDirectory("flywheel-session-notes-");
    const parentDir = join(projectRoot, ".flywheel", "sessions", "parent");
    const childDir = join(projectRoot, ".flywheel", "sessions", "child");
    const parentNotes = resolveConversationResources(parentDir, "conversation:parent").notesDirectory!;
    const childNotes = resolveConversationResources(childDir, "conversation:child").notesDirectory!;
    mkdirSync(parentNotes, { recursive: true });
    mkdirSync(childNotes, { recursive: true });
    writeFileSync(join(parentNotes, "parent.md"), "parent");
    writeFileSync(join(childNotes, "child.md"), "child");

    deleteSessionArtifacts("child", projectRoot);
    expect(existsSync(parentNotes)).toBe(true);
    expect(existsSync(childNotes)).toBe(false);

    deleteSessionArtifacts("parent", projectRoot);
    expect(existsSync(parentNotes)).toBe(false);
  });
});
