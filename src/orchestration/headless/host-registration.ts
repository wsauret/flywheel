import { headlessModuleIds, type ModuleId } from "../modules.js";

/** Optional capabilities available to the direct headless host. */
export const HEADLESS_MODULE_CEILING: readonly ModuleId[] = Object.freeze(headlessModuleIds());
