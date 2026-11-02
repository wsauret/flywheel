/** The changelog commit contract has one machine reading
 *  (scripts/commit-contract.ts): the CI gate validates with it and the release
 *  workflow composes public notes with it. These tests pin that reading to the
 *  contract the ship skill states, so a wording drift in either place is a
 *  test failure, not a malformed public changelog. */

import { describe, expect, test } from "bun:test";
import {
  classifyReleaseSurface,
  composeReleaseEvidence,
  composeReleaseNotes,
  isExemptMessage,
  parseCommitMessage,
  releaseCommitsForSurface,
  validateCommitMessage,
} from "../../../scripts/commit-contract.js";

describe("validateCommitMessage", () => {
  test("accepts every vocabulary type, with and without scope", () => {
    expect(validateCommitMessage("feat: session picker remembers the last filter")).toEqual([]);
    expect(validateCommitMessage("fix(tui): status spinner no longer flips to idle mid-turn")).toEqual([]);
    expect(validateCommitMessage("perf(events): search reads one timestamp-merged timeline")).toEqual([]);
    expect(validateCommitMessage("refactor: fold the runner pool into the session store")).toEqual([]);
    expect(validateCommitMessage("release: stage installers beside the manifest")).toEqual([]);
  });

  test("rejects a header outside the vocabulary or format", () => {
    expect(validateCommitMessage("misc fixes")).toHaveLength(1);
    expect(validateCommitMessage("feature: add a thing")).toHaveLength(1);
    expect(validateCommitMessage("feat add a thing")).toHaveLength(1);
    expect(validateCommitMessage("feat(TUI): scope must be lowercase")).toHaveLength(1);
  });

  test("rejects an uppercase subject and a trailing period, and lets a long header through", () => {
    expect(validateCommitMessage("fix: Session picker loses scroll")).toEqual(["the subject starts with an uppercase letter; the contract states lowercase imperative"]);
    expect(validateCommitMessage("fix: session picker loses scroll.")).toEqual(["the subject ends with a period; the contract states no trailing period"]);
    expect(validateCommitMessage(`feat: ${"x".repeat(80)}`)).toEqual([]);
  });

  test("requires the bang and the BREAKING CHANGE paragraph together", () => {
    expect(validateCommitMessage("feat!: sessions store facts in one sqlite file")).toHaveLength(1);
    expect(validateCommitMessage("feat: quiet change\n\nBREAKING CHANGE: old stores no longer load")).toHaveLength(1);
    expect(validateCommitMessage("feat!: sessions store facts in one sqlite file\n\nBREAKING CHANGE: delete .flywheel/state and resume from sqlite")).toEqual([]);
  });

  test("exempts the messages git writes itself", () => {
    expect(isExemptMessage("Merge branch 'main' into fix/scroll")).toBe(true);
    expect(isExemptMessage('Revert "feat: session picker remembers the last filter"')).toBe(true);
    expect(validateCommitMessage("Merge branch 'main' into fix/scroll")).toEqual([]);
  });
});

describe("parseCommitMessage", () => {
  test("reads type, scope, breaking flag, subject, and the trailers", () => {
    const parsed = parseCommitMessage(
      "feat(events)!: content-address large tool text\n\nFacts store a reference; readers hydrate at read seams.\n\nBREAKING CHANGE: stores older than v2 need one maintenance pass\n\nChangelog: sessions with large tool output use far less disk space",
    );
    expect(parsed).toEqual({
      type: "feat",
      scope: "events",
      breaking: true,
      subject: "content-address large tool text",
      changelog: "sessions with large tool output use far less disk space",
      breakingNote: "stores older than v2 need one maintenance pass",
    });
  });
});

describe("surface-specific release evidence", () => {
  const commits = [
    {
      hash: "terminal",
      message: "fix(tui): keep pending questions stable while switching tabs",
      files: ["src/tui/app.tsx", "tests/unit/tui/app.test.tsx"],
    },
    {
      hash: "extension",
      message: "feat(vscode): review all session changes from the composer",
      files: ["vscode/webview/src/command-panel.tsx"],
    },
    {
      hash: "shared",
      message: "fix(runtime): agents use Bash timeouts only for required deadlines\n\nThe model-visible Bash guidance now reserves deadlines for commands that must stop.",
      files: ["src/orchestration/agent-runtime/tools/bash-guidance.ts"],
    },
  ] as const;

  const historicalExtensionCommits = [
    {
      hash: "5814bd1798739446830958636a64331baff65907",
      message: "feat(models): mirror the TUI model browser in the editor",
      files: ["src/protocol/model-assignment.ts", "vscode/src/providers/model-commands.ts"],
    },
    {
      hash: "3da322d6a6cfae5f6430571a1891f359ae411d43",
      message: "feat(auth): connect a provider without a terminal",
      files: ["src/protocol/auth.ts", "vscode/src/providers/provider-commands.ts"],
    },
  ] as const;

  test("salvages extension-only outcomes whose old scopes were too broad", () => {
    expect(historicalExtensionCommits.map(classifyReleaseSurface)).toEqual(["vscode", "vscode"]);
    expect(releaseCommitsForSurface(historicalExtensionCommits, "terminal")).toEqual([]);
  });

  test("keeps product-scoped outcomes on their interface despite support paths", () => {
    expect(
      classifyReleaseSurface({
        hash: "mixed-terminal",
        message: "fix(tui): preserve role defaults across clients",
        files: ["src/tui/modals/model-modal.tsx", "src/orchestration/config/model-settings.ts"],
      }),
    ).toBe("terminal");
    expect(
      classifyReleaseSurface({
        hash: "mixed-extension",
        message: "fix(vscode): preserve role defaults across clients",
        files: ["vscode/webview/src/model-browser.tsx", "src/orchestration/config/model-settings.ts"],
      }),
    ).toBe("vscode");
    expect(
      classifyReleaseSurface({
        hash: "protocol",
        message: "feat(protocol): publish model assignment roles",
        files: ["src/protocol/model-assignment.ts"],
      }),
    ).toBe("shared");
  });

  test("does not let legacy wording override explicit shared or terminal scope", () => {
    expect(
      classifyReleaseSurface({
        hash: "shared-editor-word",
        message: "feat(protocol): expose editor model roles",
        files: ["src/protocol/model-assignment.ts"],
      }),
    ).toBe("shared");
    expect(
      classifyReleaseSurface({
        hash: "terminal-editor-word",
        message: "fix(tui): explain editor connections in the terminal",
        files: ["src/tui/modals/status-modal.tsx"],
      }),
    ).toBe("terminal");
  });

  test("keeps each interface out of the other interface's changelog", () => {
    expect(releaseCommitsForSurface(commits, "terminal").map((commit) => commit.hash)).toEqual(["terminal", "shared"]);
    expect(releaseCommitsForSurface(commits, "vscode").map((commit) => commit.hash)).toEqual(["extension", "shared"]);
  });

  test("gives the rewrite model scope, rationale, and changed paths", () => {
    const evidence = composeReleaseEvidence([commits[2]]);
    expect(evidence).toContain("Surface: shared");
    expect(evidence).toContain("Scope: runtime");
    expect(evidence).toContain("The model-visible Bash guidance now reserves deadlines");
    expect(evidence).toContain("src/orchestration/agent-runtime/tools/bash-guidance.ts");
  });

  test("keeps Git attribution trailers out of model evidence", () => {
    const evidence = composeReleaseEvidence([
      {
        hash: "shared",
        message: "fix(runtime): preserve session state\n\nKeep one durable owner.\n\nCo-Authored-By: Example Person <person@example.com>",
        files: ["src/orchestration/session/store.ts"],
      },
    ]);
    expect(evidence).toContain("Keep one durable owner.");
    expect(evidence).not.toContain("Co-Authored-By");
  });
});

describe("composeReleaseNotes", () => {
  test("groups published types under their sections and prefers the Changelog trailer", () => {
    const notes = composeReleaseNotes([
      "feat(events): content-address large tool text\n\nChangelog: sessions with large tool output use far less disk space",
      "fix: status spinner no longer flips to idle mid-turn",
      "perf: transcript scroll stays smooth on giant workflows",
      "refactor: fold the runner pool into the session store",
      "test: widen the foreground-deadline windows",
    ]);
    expect(notes).toBe(
      [
        "## Added",
        "",
        "- Sessions with large tool output use far less disk space",
        "",
        "## Fixed",
        "",
        "- Status spinner no longer flips to idle mid-turn",
        "",
        "## Performance",
        "",
        "- Transcript scroll stays smooth on giant workflows",
      ].join("\n"),
    );
  });

  test("lists a breaking commit under Breaking changes with its stated consequence", () => {
    const notes = composeReleaseNotes(["chore!: drop the v1 store format\n\nBREAKING CHANGE: run flywheel events maintain before upgrading"]);
    expect(notes).toBe("## Breaking changes\n\n- Run flywheel events maintain before upgrading");
  });

  test("states plainly when no commit publishes", () => {
    expect(composeReleaseNotes(["docs: rewrite the session layout guide", "not a contract message at all"])).toBe("No user-facing changes in this release.");
  });
});
