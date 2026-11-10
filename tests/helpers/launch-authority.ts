import { ToolActionSchema } from "../../src/infra/workflow-types.js";
import type { LaunchingSessionAuthority } from "../../src/orchestration/workflow-host/path-workflow.js";

/** The authority of a launching session that planned every tool and may
 *  dispatch every listed persona. A test that does not judge authority
 *  launches with it. */
export function fullAuthority(personas: readonly string[] = []): LaunchingSessionAuthority {
  return { toolActions: new Set(ToolActionSchema.literals), personas: new Set(personas), unavailable: new Map() };
}
