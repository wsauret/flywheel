/**
 * A stand-in for the Claude engine's login commands, compiled into an executable by the separation test. A real
 * `auth login` opens a browser and needs a person, so the qualification runs this instead and proves what Flywheel
 * does around the engine: where each login lives, and what the engine receives.
 *
 * `auth login` writes a login's account details into `CLAUDE_CONFIG_DIR`, as the engine does after a person logs in.
 * `auth logout` removes them. Each call appends one JSON line to `FAKE_ENGINE_LOG`: its arguments, the names of its
 * environment variables, and the values of the variables that place it. No value of any other variable is written.
 */
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLACING_VARIABLES = [
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "DISABLE_UPDATES", "DISABLE_AUTOUPDATER",
] as const;

const args = process.argv.slice(2);
const log = process.env["FAKE_ENGINE_LOG"];
const configDir = process.env["CLAUDE_CONFIG_DIR"];
if (log === undefined || configDir === undefined) process.exit(64);
appendFileSync(log, `${JSON.stringify({
  args,
  names: Object.keys(process.env).sort(),
  placed: Object.fromEntries(PLACING_VARIABLES.map((name) => [name, process.env[name]])),
})}\n`);
if (args[0] === "auth" && args[1] === "login") {
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: {
    accountUuid: process.env["FAKE_ENGINE_ACCOUNT"], emailAddress: "qualification@example.invalid", billingType: "stripe_subscription",
  } }));
} else if (args[0] === "auth" && args[1] === "logout") {
  rmSync(join(configDir, ".claude.json"), { force: true });
} else {
  process.exit(2);
}
