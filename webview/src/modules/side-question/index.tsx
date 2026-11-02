import { lazy } from "solid-js"
import { SIDE_QUESTION_SURFACE } from "../../../../src/protocol/modules/side-question.js"
import type { WebModule } from "../../web-module.js"

export const sideQuestionWeb = {
  id: "side-question",
  surfaces: [{ id: SIDE_QUESTION_SURFACE, sheet: lazy(async () => ({ default: (await import("./sheet.js")).SideQuestionSheet })) }],
} as const satisfies WebModule
