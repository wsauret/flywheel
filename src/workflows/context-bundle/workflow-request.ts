import type { WorkflowMessageAddress } from "./context-facts.js";
import type { ContextAddendum, WorkflowRequest } from "./context.js";

/** The tier rule that every reader of addenda follows (ARCH-AGENCY-016). */
const ADDENDUM_TIER_RULE = "Each addition is direction unless it has a \"Design intent\" heading. Direction never overrides the Design intent above. Follow direction, and record a deviation when evidence contradicts it. Within one tier, later text applies where it conflicts with earlier text.";

function addressText(address: WorkflowMessageAddress): string {
  switch (address._tag) {
    case "workflow": return "the workflow";
    case "item": return `item "${address.key}"`;
    case "agent": return `agent "${address.definitionId}"`;
  }
}

/** Who sent an addendum, and the agent that read it or the items and
 *  agents that its sender addressed. */
function addendumHeading(addendum: ContextAddendum): string {
  const sender = addendum.source.kind === "parent" ? `the parent "${addendum.source.name}"` : "the person";
  return "readBy" in addendum
    ? `From ${sender}, read by agent "${addendum.readBy.agentName}":`
    : `From ${sender}, addressed to ${addendum.addressedTo.map(addressText).join(" and ")}:`;
}

function renderAddendum(addendum: ContextAddendum, index: number): string {
  return [
    `${index + 1}. ${addendumHeading(addendum)}`,
    addendum.text,
    ...(addendum.personWords === undefined ? [] : [`The person said: ${addendum.personWords}`]),
    ...(addendum.attachmentCount === undefined ? [] : ["This message had attachments that later agents do not receive."]),
  ].join("\n");
}

/** Render the run's per-agent request: the original request verbatim, the structured
 *  launch input as JSON when the launch passed one, then each addendum in
 *  recorded order under the tier rule. A request with no input and no
 *  addenda renders as the original bytes, so a workflow that recorded
 *  neither reads exactly what an earlier build gave it. An external agent
 *  receives this text as `workflow.userRequest`. The inherited intent belongs
 *  to the workflow-shared system tier, not this private request. */
export function renderWorkflowRequest(request: WorkflowRequest): string {
  return [
    request.original,
    ...(request.input === undefined ? [] : ["### Workflow input", `\`\`\`json\n${JSON.stringify(request.input, null, 2)}\n\`\`\``]),
    ...(request.addenda.length === 0 ? [] : ["### Added since launch", ADDENDUM_TIER_RULE, ...request.addenda.map(renderAddendum)]),
  ].join("\n\n");
}

/** The framing of the request in the prompt of an agent. The request
 *  reaches every agent, so its scope and its design intent bind the agent
 *  (PI-AGENT-029). But the launching chat wrote it to start the workflow, so an
 *  agent that took it as its task would redo the whole run, or launch the
 *  workflow again. The agent's own brief and declared inputs are its task. */
const REQUEST_FRAMING = "The request in the next section started this workflow. It is background for your brief, not your task. Your task is the instructions of your brief, with the inputs that this message gives. Do only that part of the work: do not do the work of other agents, and do not start a workflow for the request. Keep your work within the scope and the limits that the request states. A \"Design intent\" section in it is fixed, and your work must agree with it.";

/** An addendum is direction that the agent follows, not background. */
const ADDENDA_FRAMING = "Each addition under \"Added since launch\" is direction for your brief, as the rule there states.";

/** Render the request part of an agent's context bundle: the framing in its
 *  own section, then the request under `## User Request`. The framing stays
 *  out of the request section, so the text under that heading is the
 *  request alone, and an agent that copies the original request verbatim
 *  copies no framing. */
export function renderWorkflowRequestSection(request: WorkflowRequest): string {
  const framing = request.addenda.length === 0 ? REQUEST_FRAMING : `${REQUEST_FRAMING} ${ADDENDA_FRAMING}`;
  return ["## How To Use The User Request", framing, "## User Request", renderWorkflowRequest(request)].join("\n\n");
}
