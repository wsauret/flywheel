import { describe, expect, test } from "bun:test"
import { parseReleaseVersion } from "../../../../src/infra/update/version-order.js"
import { readReleaseSummary, releaseNoticeMessage, type ReleaseNotesFetch } from "../../../../src/orchestration/update/release-notes-summary.js"

const body = "A summary.\n\n## Added\n\n- Feature one\n- Feature two\n  - Nested detail\n\n## Fixed\n\n- Fix one\n\n## Changed\n\n- Change one\n\n## Performance\n\n- Faster\n\n## Breaking\n\n- Breaking change"

describe("release notes summary", () => {
  test.each([
    [undefined, "Updated to v0.1.2."],
    [{ features: 0, fixes: 0, other: 0 }, "Updated to v0.1.2."],
    [{ features: 1, fixes: 0, other: 0 }, "Updated to v0.1.2. Got 1 feature."],
    [{ features: 0, fixes: 1, other: 1 }, "Updated to v0.1.2. Got 1 fix and 1 other change."],
    [{ features: 1, fixes: 2, other: 0 }, "Updated to v0.1.2. Got 1 feature and 2 fixes."],
    [{ features: 15, fixes: 37, other: 7 }, "Updated to v0.1.2. Got 15 features, 37 fixes, and 7 other changes."],
  ])("formats the running release with counts %j", (counts, expected) => {
    expect(releaseNoticeMessage("0.1.2", counts)).toBe(expected)
  })

  test("pages and sums top-level bullets by category for every release in the acknowledged-to-running range", async () => {
    const pages: string[] = []
    const fetchPage: ReleaseNotesFetch = async (input) => {
      pages.push(String(input))
      const entries = pages.length === 1
        ? Array.from({ length: 100 }, (_, index) => release(`v2.0.${100 - index}`))
        : [release("v0.1.2"), release("v0.1.1"), release("v0.1.0", null)]
      return Response.json(entries)
    }
    expect(await readReleaseSummary({
      repository: "owner/project",
      acknowledged: parseReleaseVersion("0.1.0")!,
      running: parseReleaseVersion("0.1.2")!,
      fetch: fetchPage,
      signal: new AbortController().signal,
    })).toEqual({ counts: { features: 4, fixes: 2, other: 6 }, releases: 2 })
    expect(pages).toEqual([
      "https://api.github.com/repos/owner/project/releases?per_page=100&page=1",
      "https://api.github.com/repos/owner/project/releases?per_page=100&page=2",
    ])
  })

  test.each([
    [() => Response.json({ message: "rate limited" }, { status: 403 }), "http-403"],
    [() => Response.json([{ tag_name: "v0.1.1" }]), undefined],
    [() => Response.json([release("v0.1.1", null)]), "release-body-missing"],
    [() => Response.json([release("v0.1.1", "not notes")]), "release-body-unreadable"],
    [() => Response.json([release("v0.1.0")]), "running-release-missing"],
  ])("rejects unreadable release data", async (respond, error) => {
    await expect(readReleaseSummary({
      repository: "owner/project",
      acknowledged: parseReleaseVersion("0.1.0")!,
      running: parseReleaseVersion("0.1.1")!,
      fetch: async () => respond(),
      signal: new AbortController().signal,
    })).rejects.toThrow(error)
  })
})

function release(tag_name: string, notes: string | null = body) {
  return { tag_name, body: notes, draft: false, prerelease: false }
}
