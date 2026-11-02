#!/usr/bin/env bun
import { parsePairedArgs } from "./campaign-args.js";
import { runChatCampaign } from "./chat-campaign.js";

if (import.meta.main) {
  try {
    await runChatCampaign(parsePairedArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
