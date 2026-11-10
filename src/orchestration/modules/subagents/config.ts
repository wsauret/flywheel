import { Effect, Schema } from "effect"
import { configSection, type ModuleConfigSection } from "../../config/config-section.js"

const SubagentsConfigSchema = Schema.Struct({
  disabled_types: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
    Schema.annotate({ description: "Turn off agent types. An entry is `general` or an agent role id: `explorer`, `implementer`, `ship`, `advisor`, `reviewer`, one reviewer role such as `reviewer-security`, or the role of an installed persona. `reviewer` turns off every reviewer role. Every type is on unless this list names it, and an entry that names no installed type changes nothing. For example, `disabled_types = [\"advisor\", \"reviewer\", \"ship\"]` keeps only the general agent, the explorer, and the implementer. While every type is off, agents are offered no subagent tool." }),
  ),
}).pipe(Schema.withDecodingDefaultType(Effect.succeed({ disabled_types: [] })))

/** The agent types a person turned off (PI-CAP-022). It applies as the module selection does: each request reads it
 *  (`next-request`), and an admission reads it again (`use-time-revalidate`). An entry that names no installed type
 *  matches nothing: the installed types differ per project, so the list cannot be checked against one catalog. */
export const subagentsConfigSection = {
  key: "subagents",
  schema: SubagentsConfigSchema,
  owner: "Subagents",
  applications: [{ mode: "next-request", path: [] }, { mode: "use-time-revalidate", path: [] }],
  protocolExposure: "ui-safe",
  requestCapture: (value: unknown) => Schema.decodeUnknownSync(SubagentsConfigSchema)(value),
} as const satisfies ModuleConfigSection<typeof SubagentsConfigSchema>

/** The agent types that `config` turns off: a decoded configuration, or the module sections of a request capture. */
export function disabledTypesOf(config: { readonly [section: string]: unknown }): readonly string[] {
  return configSection(config, subagentsConfigSection).disabled_types
}
