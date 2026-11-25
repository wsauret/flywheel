export const IMPLEMENT_QUALITY_RUBRIC = "Prefer the smallest correct change. Penalize speculative abstraction, helpers with one caller, unnecessary comments that restate code, defensive checks on internal data, parallel state copies, and churn unrelated to the plan. Reward matching the existing file conventions and honest naming. Functional correctness is judged elsewhere; if one diff is plainly broken, say so, but focus on engineering quality.";

const RESEARCH_PAIR_CRITERIA = [
  "Judge factual grounding, especially whether claims have accurate file:line citations.",
  "Judge completeness against the question.",
  "Judge concision: reward direct synthesis and penalize irrelevant detail.",
  "Do not infer model identity from writing style. Allow a tie only when quality is genuinely equal.",
].join(" ");

export function buildResearchPairJudgePrompt(taskPrompt: string, summaryA: string, summaryB: string): string {
  return [
    "You are a meticulous staff engineer comparing two research summaries produced for the same codebase question.",
    RESEARCH_PAIR_CRITERIA,
    "",
    "## Question",
    taskPrompt,
    "",
    "## SUMMARY A",
    summaryA,
    "",
    "## SUMMARY B",
    summaryB,
    "",
    "Respond with only one JSON object on one line:",
    `{"winner":"A"|"B"|"tie","rationale":"At most two concise sentences naming the deciding difference."}`,
  ].join("\n");
}
