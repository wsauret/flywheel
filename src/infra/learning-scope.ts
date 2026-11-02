import { Schema } from "effect";

/** How far one piece of durable learning applies (ARCH-LEARNING-005). Project
 *  learning belongs to one project root; global learning follows the user
 *  across projects. Reach is not authorship and not mutation ownership: a
 *  package can be global and user-authored, or project and Flywheel-managed. */
export const LEARNING_REACHES = ["project", "global"] as const;

export type LearningScope = (typeof LEARNING_REACHES)[number];

export const LearningScopeSchema = Schema.Literals(LEARNING_REACHES);
