/** The roles a model can be assigned to, as the client needs them.
 *
 *  Flywheel does not run one model. It assigns a model and an effort per role:
 *  the chat that answers you, an agent of a workflow, the reviewer, the
 *  explorer, the implementer, the advisor, and the background learner. Each
 *  brief can add more. A client showing a single model picker is
 *  showing one seat out of many.
 *
 *  The registry that owns this lives behind imports that reach Bun, so a client
 *  cannot read it directly and must be told. That is the same reason the module
 *  vocabulary is published rather than imported. */
export interface RuntimeModelRole {
  readonly id: string
  readonly label: string
  /** Which section this belongs under. Agents includes the Workflow role,
   *  workflow brief seats, and named personas. */
  readonly group: "core" | "agents" | "background"
  /** Position within its group, so every client orders them the same way. */
  readonly order: number
  /** One user-facing line explaining what this role does. */
  readonly description: string
}

export interface RuntimeModelRolesResult {
  readonly roles: readonly RuntimeModelRole[]
}
