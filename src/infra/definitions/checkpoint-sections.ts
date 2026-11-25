/** The fixed sections of a conversation checkpoint, in the order the checkpoint renders them. Each id is the stored
 *  key and the `section` argument of the checkpoint tools; each title is what a person and an agent read. */
export const CHECKPOINT_SECTIONS = ["designIntent", "decisions", "currentState", "openQuestions", "nextStep", "relevantSkills", "references", "workingNotes"] as const;
export type CheckpointSection = typeof CHECKPOINT_SECTIONS[number];

export const CHECKPOINT_SECTION_TITLES = {
  designIntent: "Design intent",
  decisions: "Decisions",
  currentState: "Current state",
  openQuestions: "Open questions",
  nextStep: "Next step",
  relevantSkills: "Relevant skills",
  references: "References",
  workingNotes: "Working notes",
} as const satisfies { readonly [Section in CheckpointSection]: string };
