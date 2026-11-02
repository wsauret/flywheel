import type { TuiModule } from "../../tui-module.js"
import { DASHBOARD_SURFACE, ExperimentStrip } from "./strip.js"

export const experimentsTui = {
  id: "experiments",
  strip: ExperimentStrip,
  surfaces: [{
    id: DASHBOARD_SURFACE,
    title: "Experiment",
    width: 120,
    controls: ["↑↓ j/k scroll · pageup/pagedown u/d page · g/G top/bottom · esc/q close"],
    load: async () => (await import("./dashboard-modal.js")).ExperimentDashboardModal,
  }],
} as const satisfies TuiModule
