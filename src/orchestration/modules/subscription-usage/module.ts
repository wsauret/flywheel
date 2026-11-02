import { USAGE_COMMAND, USAGE_COMMAND_NAME, USAGE_SURFACE, USAGE_STATS_COMMAND, USAGE_STATS_COMMAND_NAME, USAGE_STATS_SURFACE, subscriptionUsageProtocol } from "../../../protocol/modules/subscription-usage.js"
import { DEFAULT_USAGE_ALERT_THRESHOLDS, subscriptionUsageConfigSection } from "./config.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import { createSubscriptionUsageProtocol } from "./protocol.js"
import { createSubscriptionUsageService, subscriptionUsageService } from "./service.js"

/** Optional usage inspection consumes the provider contributions. Provider
 *  admission and request accounting retain their kernel authorities. */
export const subscriptionUsageModule = {
  id: "subscription-usage",
  dependencies: [],
  availability: { kind: "available" },
  service: { handle: subscriptionUsageService, create: createSubscriptionUsageService },
  protocol: moduleProtocol({ contract: subscriptionUsageProtocol, create: createSubscriptionUsageProtocol }),
  contributions: [
    { domain: "config", id: subscriptionUsageConfigSection.key, value: subscriptionUsageConfigSection },
    { domain: "commands", id: USAGE_COMMAND, value: { id: USAGE_COMMAND, title: USAGE_COMMAND_NAME, description: "View subscription usage and request spend", aliases: [], menu: { group: "top", rank: 10 }, opens: USAGE_SURFACE } },
    { domain: "commands", id: USAGE_STATS_COMMAND, value: { id: USAGE_STATS_COMMAND, title: USAGE_STATS_COMMAND_NAME, description: "View session statistics", aliases: [], menu: { group: "top", rank: 130 }, opens: USAGE_STATS_SURFACE } },
    { domain: "settings", id: "subscription-usage", value: { control: "binary", group: "Model & spend", label: "Usage", description: "Inspect subscription allowances and request spend" } },
    { domain: "settings", id: "subscription-usage-alert-thresholds", value: { control: "config-number-list", section: subscriptionUsageConfigSection.key, key: "alert_thresholds", defaultValue: DEFAULT_USAGE_ALERT_THRESHOLDS, suffix: "%", group: "Model & spend", label: "Usage alert thresholds", description: "Ascending usage percentages for alerts. Empty disables alerts.", min: 1, max: 100 } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
