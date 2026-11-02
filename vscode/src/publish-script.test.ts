import { describe, expect, test } from "bun:test"
import {
  marketplacePublishCommand,
  marketplaceVersionPublished,
  parseExtensionIdentity,
  parseVsixIdentity,
  publicationMode,
  recoverMarketplaceTag,
  publishMarketplaceAndTag,
} from "../scripts/publish.js"

describe("Marketplace publication", () => {
  test("rejects versions that can escape the artifact directory", () => {
    expect(() => parseExtensionIdentity({ name: "flywheel", publisher: "flywheel-core-team", version: "../../other" })).toThrow(
      "package.json version must be strict semantic versioning",
    )
  })

  test("reads a universal identity from the packaged manifest", () => {
    expect(
      parseVsixIdentity('<PackageManifest><Identity Language="en-US" Id="flywheel" Version="0.0.1" Publisher="flywheel-core-team" /></PackageManifest>'),
    ).toEqual({ name: "flywheel", publisher: "flywheel-core-team", version: "0.0.1", target: undefined })
  })

  test("reads the target a platform package names, so it is never published as the universal one", () => {
    expect(
      parseVsixIdentity(
        '<PackageManifest><Identity Language="en-US" Id="flywheel" Version="0.0.1" Publisher="flywheel-core-team" TargetPlatform="linux-x64"/></PackageManifest>',
      ),
    ).toEqual({ name: "flywheel", publisher: "flywheel-core-team", version: "0.0.1", target: "linux-x64" })
  })

  test("dry-run and recovery never enter normal publication", () => {
    expect(publicationMode(["--dry-run"], "test")).toBe("dry-run")
    expect(publicationMode(["--recover-tag"], "test")).toBe("recover-tag")
    expect(() => publicationMode([], "test")).toThrow("publication is disabled in the test environment")
    expect(() => publicationMode(["--other"], undefined)).toThrow("unknown argument(s): --other")
    expect(() => publicationMode(["--dry-run", "--recover-tag"], undefined)).toThrow("state only one publication mode")
  })

  test("passes the extension notes as the Marketplace changelog", () => {
    expect(marketplacePublishCommand("/release-notes.md", "flywheel-0.0.1.vsix")).toEqual([
      "bunx",
      "@vscode/vsce",
      "publish",
      "--changelog-path",
      "/release-notes.md",
      "--packagePath",
      "flywheel-0.0.1.vsix",
    ])
  })

  test("recognizes only the requested published Marketplace version", () => {
    const listing = JSON.stringify({ versions: [{ version: "0.0.1" }, { version: "0.0.2" }] })
    expect(marketplaceVersionPublished(listing, "0.0.2")).toBe(true)
    expect(marketplaceVersionPublished(listing, "0.0.3")).toBe(false)
    expect(marketplaceVersionPublished("not json", "0.0.2")).toBe(false)
  })

  test("recovery refuses a tag from another source commit before Marketplace lookup", () => {
    const calls: string[] = []
    const failure = recoverMarketplaceTag(
      { name: "flywheel", publisher: "flywheel-core-team", version: "0.0.2" },
      "vscode-v0.0.2",
      {
        marketplace: () => {
          calls.push("marketplace")
          return { exitCode: 0, stdout: JSON.stringify({ versions: [{ version: "0.0.2" }] }), stderr: "" }
        },
        git: (arguments_) => {
          calls.push(`git ${arguments_.join(" ")}`)
          const stdout = arguments_[1] === "HEAD" ? "head" : "other"
          return { exitCode: 0, stdout, stderr: "" }
        },
      },
    )
    expect(failure).toContain("does not name the current source commit")
    expect(calls).toEqual(["git rev-parse vscode-v0.0.2^{commit}", "git rev-parse HEAD"])
  })

  test("recovery refuses an unpublished Marketplace version without pushing", () => {
    const calls: string[] = []
    const failure = recoverMarketplaceTag(
      { name: "flywheel", publisher: "flywheel-core-team", version: "0.0.2" },
      "vscode-v0.0.2",
      {
        marketplace: () => {
          calls.push("marketplace")
          return { exitCode: 0, stdout: JSON.stringify({ versions: [{ version: "0.0.1" }] }), stderr: "" }
        },
        git: (arguments_) => {
          calls.push(`git ${arguments_.join(" ")}`)
          return { exitCode: 0, stdout: "head", stderr: "" }
        },
      },
    )
    expect(failure).toContain("is not published")
    expect(calls).toEqual(["git rev-parse vscode-v0.0.2^{commit}", "git rev-parse HEAD", "marketplace"])
  })

  test("recovery verifies source and Marketplace before pushing", () => {
    const calls: string[] = []
    const failure = recoverMarketplaceTag(
      { name: "flywheel", publisher: "flywheel-core-team", version: "0.0.2" },
      "vscode-v0.0.2",
      {
        marketplace: () => {
          calls.push("marketplace")
          return { exitCode: 0, stdout: JSON.stringify({ versions: [{ version: "0.0.2" }] }), stderr: "" }
        },
        git: (arguments_) => {
          calls.push(`git ${arguments_.join(" ")}`)
          return { exitCode: 0, stdout: "head", stderr: "" }
        },
      },
    )
    expect(failure).toBeUndefined()
    expect(calls).toEqual([
      "git rev-parse vscode-v0.0.2^{commit}",
      "git rev-parse HEAD",
      "marketplace",
      "git push origin vscode-v0.0.2",
    ])
  })

  test("removes the staged tag when Marketplace publication fails", () => {
    const calls: string[] = []
    const failure = publishMarketplaceAndTag(["publish"], "vscode-v0.0.2", {
      marketplace: () => {
        calls.push("marketplace")
        return { exitCode: 1, stdout: "", stderr: "rejected" }
      },
      git: (arguments_) => {
        calls.push(`git ${arguments_.join(" ")}`)
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    expect(failure).toContain("Marketplace publication failed")
    expect(calls).toEqual(["git tag vscode-v0.0.2", "marketplace", "git tag -d vscode-v0.0.2"])
  })

  test("stages, publishes, then pushes the extension tag in order", () => {
    const calls: string[] = []
    const failure = publishMarketplaceAndTag(["publish"], "vscode-v0.0.2", {
      marketplace: () => {
        calls.push("marketplace")
        return { exitCode: 0, stdout: "", stderr: "" }
      },
      git: (arguments_) => {
        calls.push(`git ${arguments_.join(" ")}`)
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    expect(failure).toBeUndefined()
    expect(calls).toEqual(["git tag vscode-v0.0.2", "marketplace", "git push origin vscode-v0.0.2"])
  })

  test("does not publish when the local tag cannot be staged", () => {
    let marketplaceCalled = false
    const failure = publishMarketplaceAndTag(["publish"], "vscode-v0.0.2", {
      marketplace: () => {
        marketplaceCalled = true
        return { exitCode: 0, stdout: "", stderr: "" }
      },
      git: () => ({ exitCode: 1, stdout: "", stderr: "tag failed" }),
    })
    expect(failure).toContain("could not be created before publication")
    expect(marketplaceCalled).toBe(false)
  })
})
