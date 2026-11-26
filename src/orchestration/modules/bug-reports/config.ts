import { Effect, Schema } from "effect"
import { upsertSemanticAssignment } from "../../config/config-assignment.js"
import type { ConfigReadResult } from "../../config/config-file.js"
import { CONFIG_VALUE_ABSENT, type RuntimeConfigOwner } from "../../config/runtime-config-owner.js"
import type { ModuleConfigSection } from "../../config/schema/config-section.js"

/** `automatic` is the person's answer to the crash screen's question. An
 *  absent key means the person has not answered, which sends no automatic
 *  report and lets the next crash screen ask. Installs from before the
 *  question have no key and so start unanswered; no conversion is needed. */
const BugReportsConfigSchema = Schema.Struct({
  automatic: Schema.optionalKey(Schema.Boolean.pipe(Schema.annotate({ description: "Send crash reports automatically? Absent until a crash screen asks." }))),
}).pipe(Schema.withDecodingDefaultType(Effect.succeed({})))

export const bugReportsConfigSection = {
  key: "bug_reports", schema: BugReportsConfigSchema, owner: "Bug reports",
  applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe",
} as const satisfies ModuleConfigSection<typeof BugReportsConfigSchema>

/** The stored answer as the file holds it now. A missing, refused, or unparseable file, and any value that is
 *  not a boolean, read as not answered, which sends nothing. */
function decodeAutomaticReports(read: ConfigReadResult): boolean | undefined {
  if (read.kind !== "text") return undefined
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(read.text)
  } catch {
    return undefined
  }
  const section = typeof parsed === "object" && parsed !== null && "bug_reports" in parsed ? parsed.bug_reports : undefined
  const automatic = typeof section === "object" && section !== null && "automatic" in section ? section.automatic : undefined
  return typeof automatic === "boolean" ? automatic : undefined
}

/** Reads the person's answer from the account's configuration file at each call, so an answer saved in
 *  Settings or on another surface applies to the next send, not after a debounce or a service rebuild. */
export function automaticReportsObserver(config: Pick<RuntimeConfigOwner, "useTimeObserver">): () => Promise<boolean | undefined> {
  return config.useTimeObserver(decodeAutomaticReports)
}

/** The person's answer in the account's configuration file, read as `automaticReportsObserver` reads it.
 *  `answerAutomaticReports` writes only while the question is unanswered and resolves to the
 *  answer in force afterwards, which is the earlier answer when another surface saved one first; undefined
 *  means the answer could not be saved. */
export function automaticReportsAnswer(config: Pick<RuntimeConfigOwner, "useTimeObserver" | "mutateSection">) {
  const automaticReports = automaticReportsObserver(config)
  return {
    automaticReports,
    answerAutomaticReports: async (allow: boolean): Promise<boolean | undefined> => {
      const written = await config.mutateSection(bugReportsConfigSection, CONFIG_VALUE_ABSENT, (value) => value.automatic ?? CONFIG_VALUE_ABSENT,
        (source) => upsertSemanticAssignment(source, [bugReportsConfigSection.key, "automatic"], String(allow)))
      if (written.ok) return allow
      return written.kind === "stale" ? await automaticReports() : undefined
    },
  }
}
