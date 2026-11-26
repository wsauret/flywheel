import { Schema } from "effect"

import type { RuntimeModelRolesResult } from "./model-role-protocol-types.js"

/** The assignable roles, on the wire.
 *
 *  Declared beside its types rather than in the shared schema file, which the
 *  size limit is right to push back on: a protocol whose every shape lives in
 *  one file stops being readable long before it stops compiling. */
export const RuntimeModelRolesResultSchema: Schema.Codec<RuntimeModelRolesResult> = Schema.Struct({
  roles: Schema.Array(Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    group: Schema.Literals(["core", "agents", "background"]),
    order: Schema.Number,
    description: Schema.String,
  })),
})
