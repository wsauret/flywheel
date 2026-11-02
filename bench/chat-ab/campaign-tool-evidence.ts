import { Schema } from "effect";
import type { ExecutionEvidence } from "../../src/protocol/execution-evidence.js";
import { loadProviderRequestAuditFromEvents } from "../../src/orchestration/session/provider-request-audit-projection.js";
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../src/orchestration/modules.js";
import { DEVELOPMENT_MODULES } from "../../src/orchestration/development-modules.js";
import { toolRegistryFromComposition } from "../../src/orchestration/agent-runtime/tools/tool-registry.js";

const SearchSource = Schema.Struct({ source: Schema.String });
const SearchFact = Schema.Struct({
  id: Schema.String, aggregateId: Schema.String, position: Schema.Int, seq: Schema.Int,
  type: Schema.String, version: Schema.Int, timestamp: Schema.Number, actor: Schema.String,
  sessionId: Schema.String, payload: Schema.Record(Schema.String, Schema.Unknown),
});

// The subject is a source run, which installs the development modules beside
// the shipped catalog (scripts/source-cli.ts), so its requests can offer their tools.
const SOURCE_RUN_MODULES = [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES];

/** Resolve every observed request through the product audit projection. Missing
 * surfaces or descendant coverage refuse proof; module enablement is not tool exposure. */
export function campaignToolExclusionEvidence(jsonl: string, evidence: ExecutionEvidence, disabledTools: readonly string[]) {
  if (evidence.descendantDiscovery === "incomplete") throw new Error("Tool exclusion evidence has incomplete descendant discovery");
  const registry = toolRegistryFromComposition(composeFirstPartyModules(SOURCE_RUN_MODULES));
  const facts = jsonl.split("\n").filter(line => line.trim()).flatMap(line => {
    const value: unknown = JSON.parse(line);
    return Schema.decodeUnknownSync(SearchSource)(value).source === "store" ? [Schema.decodeUnknownSync(SearchFact)(value)] : [];
  });
  const requests = evidence.sessions.flatMap(session => {
    const entries = new Map(loadProviderRequestAuditFromEvents(facts.filter(fact => fact.sessionId === session.sessionId)).map(entry => [entry.requestId, entry]));
    return session.requests.map(request => {
      const surface = entries.get(request.requestId)?.toolSurface;
      if (!surface) throw new Error(`Tool surface evidence is unavailable for ${session.sessionId}/${request.requestId}`);
      const tools = surface.tools.map(tool => {
        const owner = "registrationId" in tool ? registry.get(tool.registrationId)?.tool : undefined;
        if (owner === undefined) throw new Error(`Tool registration evidence is unavailable for ${session.sessionId}/${request.requestId}/${tool.name}`);
        return owner;
      });
      return { sessionId: session.sessionId, requestId: request.requestId, tools };
    });
  });
  const violations = requests.flatMap(request => request.tools.filter(name => disabledTools.includes(name)).map(tool => ({ sessionId: request.sessionId, requestId: request.requestId, tool })));
  return { disabledTools, requests, violations };
}
