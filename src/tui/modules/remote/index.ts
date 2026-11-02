import { REMOTE_SURFACE } from "../../../protocol/modules/remote.js"
import type { TuiModule } from "../../tui-module.js"

export const remoteTui: TuiModule = {
  id: "remote",
  surfaces: [{ id: REMOTE_SURFACE, loadController: async () => (await import("./surface.js")).createRemoteSurface }],
}
