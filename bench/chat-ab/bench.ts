#!/usr/bin/env bun
import { parseArgs } from "./campaign-args.js";
import { runChatCampaign } from "./chat-campaign.js";

if (import.meta.main) {
  try {
    await runChatCampaign(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
