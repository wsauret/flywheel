import { errorMessage } from "../infra/error-message.js";
import type { AccountDirectories } from "../infra/directory-authorities.js";
import { ownedCommandRunner } from "../infra/owned-command.js";
import type { LauncherScope } from "../infra/process-supervisor.js";
import {
  fontInstallSummary,
  fontStatusSummary,
  getFontStatus,
  installBundledFont,
} from "../orchestration/font-installer.js";
import { updateFontTipDismissed } from "../orchestration/config/writer.js";

const USAGE = `Usage: flywheel font <command>

Commands:
  status     Show Monaspace Argon install status
  install    Install bundled Monaspace Argon fonts for this user
  dismiss    Hide the Flywheel font tip
  reset      Show the Flywheel font tip again`;

export async function runFont(args: string[], directories: AccountDirectories, launcher: LauncherScope): Promise<void> {
  const command = args[0] ?? "status";

  switch (command) {
    case "status":
      console.log(fontStatusSummary(getFontStatus(directories)));
      break;
    case "install":
      await install(directories, launcher);
      break;
    case "dismiss":
      updateFontTipDismissed(true, directories);
      console.log("Font tip dismissed.");
      break;
    case "reset":
      updateFontTipDismissed(false, directories);
      console.log("Font tip reset.");
      break;
    default:
      console.error(`Unknown font command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
}

async function install(directories: AccountDirectories, launcher: LauncherScope): Promise<void> {
  try {
    const result = await installBundledFont(directories, { run: ownedCommandRunner(launcher) });
    console.log(fontInstallSummary(result));
    console.log(`Installed files: ${result.targetDir}`);
    for (const warning of result.warnings.slice(1)) console.log(`Warning: ${warning}`);
  } catch (err) {
    console.error(`Font install failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}
