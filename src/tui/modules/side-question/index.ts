import { SIDE_QUESTION_SURFACE } from "../../../protocol/modules/side-question.js"
import type { TuiModule } from "../../tui-module.js"

export const sideQuestionTui = {
  id: "side-question",
  surfaces: [{
    id: SIDE_QUESTION_SURFACE,
    loadController: async () => (await import("./surface.js")).createSideQuestionSurface,
  }],
} as const satisfies TuiModule
