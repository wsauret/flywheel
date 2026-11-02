import { Schema } from "effect"
import { PROTOCOL_MODULE_SESSION_DOMAINS, PROTOCOL_MODULE_WORKSPACE_DOMAINS, PROTOCOL_MODULE_WORKFLOW_DOMAINS } from "./modules.js"
import { KERNEL_SESSION_DOMAINS, KERNEL_WORKSPACE_DOMAINS, type RuntimeCursorIdentity, type RuntimeSnapshotScope } from "./runtime-ui-protocol-types.js"

// The kernel states its domain literals once, and the registry supplies every
// module domain, so no module literal is typed here by hand.
const SessionDomainSchema = Schema.Literals([...KERNEL_SESSION_DOMAINS, ...PROTOCOL_MODULE_SESSION_DOMAINS])
const WorkspaceDomainSchema = Schema.Literals([...KERNEL_WORKSPACE_DOMAINS, ...PROTOCOL_MODULE_WORKSPACE_DOMAINS])
const WorkflowDomainSchema = Schema.Literals(PROTOCOL_MODULE_WORKFLOW_DOMAINS)
const RuntimeUiDomainSchema = Schema.Union([SessionDomainSchema, WorkspaceDomainSchema, WorkflowDomainSchema])
const RuntimeSessionCursorIdentitySchema = Schema.Struct({ scope: Schema.Literal("session"), domain: SessionDomainSchema, sessionId: Schema.String })
const RuntimeWorkspaceCursorIdentitySchema = Schema.Struct({ scope: Schema.Literal("workspace"), domain: WorkspaceDomainSchema })

export const RuntimeCursorIdentitySchema = Schema.Union([RuntimeSessionCursorIdentitySchema, RuntimeWorkspaceCursorIdentitySchema, Schema.Struct({ scope: Schema.Literal("workflow"), domain: WorkflowDomainSchema, workflowId: Schema.String })]) satisfies Schema.Codec<RuntimeCursorIdentity>
export const RuntimeSnapshotScopeSchema: Schema.Codec<RuntimeSnapshotScope> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("workspace"), domain: RuntimeUiDomainSchema }),
  Schema.Struct({ kind: Schema.Literal("cursor"), cursor: RuntimeCursorIdentitySchema }),
])
