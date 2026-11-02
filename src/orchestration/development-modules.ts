import { developmentModule } from "./modules/development/module.js"

/** The modules a source run installs beside the shipped catalog. Only the
 *  source entry (`scripts/source-cli.ts`) and repository scripts import this
 *  file; `src/cli/index.ts` never does, so a release bundle never contains
 *  these modules or the definitions they carry. */
export const DEVELOPMENT_MODULES = [developmentModule] as const
