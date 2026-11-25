import { Schema } from "effect"

// Provenance for one audited Raindrop bookmark, as the retired Raindrop audit
// recorded it in its inspiration completion facts. Flywheel no longer runs the
// audit; this schema stays so that recorded facts still decode. The shape is
// discriminated on how the source is reopened: an article by URL, a GitHub
// source by local clone plus commit.

/** The clone root that the audit required for GitHub sources. */
const INSPIRATION_CLONE_ROOT = "inspiration/raindrop"

const BOOKMARK_ID = /^[0-9]+$/
const COMMIT_SHA = /^[0-9a-f]{40}$/

// Raindrop URLs are external input, so the check is on the scheme and the
// authority, not on reachability: only http(s), and never embedded credentials.
function isSafeHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === ""
}

function isSafeClonePath(value: string): boolean {
  const segments = value.split("/")
  return value.startsWith(`${INSPIRATION_CLONE_ROOT}/`)
    && segments.length > 2
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

const bookmarkIdSchema = Schema.String.check(
  Schema.makeFilter((value) => BOOKMARK_ID.test(value) || "bookmark_id must be the numeric Raindrop bookmark id"),
)

const sourceUrlSchema = Schema.String.check(
  Schema.makeFilter((value) => isSafeHttpUrl(value) || "source_url must be an http(s) URL without embedded credentials"),
)

const localCloneSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    isSafeClonePath(value) || `local_clone must be a workspace-relative path below ${INSPIRATION_CLONE_ROOT}/`
  ),
)

const sourceCommitSchema = Schema.String.check(
  Schema.makeFilter((value) => COMMIT_SHA.test(value) || "source_commit must be the full 40-char lowercase hex commit"),
)

export const inspirationProvenanceSchema = Schema.Union([
  Schema.Struct({
    source_type: Schema.Literal("article"),
    bookmark_id: bookmarkIdSchema,
    source_url: sourceUrlSchema,
  }),
  Schema.Struct({
    source_type: Schema.Literal("github"),
    bookmark_id: bookmarkIdSchema,
    source_url: sourceUrlSchema,
    local_clone: localCloneSchema,
    source_commit: sourceCommitSchema,
  }),
])
