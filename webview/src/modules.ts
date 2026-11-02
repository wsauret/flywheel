import { subscriptionUsageWeb } from "./modules/subscription-usage/index.js"
import { experimentsWeb } from "./modules/experiments/index.js"
import { mcpWeb } from "./modules/mcp/index.js"
import { projectNotificationsWeb } from "./modules/project-notifications/index.js"
import { remoteWeb } from "./modules/remote/index.js"
import { sideQuestionWeb } from "./modules/side-question/index.js"
import type { WebModule } from "./web-module.js"
import { workflowsWeb } from "./modules/workflows/index.js"
import { bugReportsWeb } from "./modules/bug-reports/index.js"

/** The web client's module registry. The app renders strips and resolves
 *  surfaces from this list alone, so a module's web presence is its home under
 *  `modules/<id>/` plus this one line. */
export const WEB_MODULES = [bugReportsWeb, experimentsWeb, mcpWeb, projectNotificationsWeb, subscriptionUsageWeb, remoteWeb, sideQuestionWeb, workflowsWeb] as const satisfies readonly WebModule[]
