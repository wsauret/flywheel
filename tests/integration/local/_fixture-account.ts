import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { defaultRoleSlots } from "../../../src/orchestration/config/role-selection.js"
import { ROLE_MODEL_DEFAULTS } from "../../../src/orchestration/config/role-model-defaults.js"

/** Writes the config and auth of the account under `userDataRoot`, so that
 *  every model role runs `model` at low effort on
 *  the fixture provider that listens on `port`, with a placeholder key. The
 *  account's directories are private, as the auth store requires. */
export async function writeFixtureAccountConfig(userDataRoot: string, provider: { readonly port: number; readonly model: string }): Promise<void> {
  const authDirectory = join(userDataRoot, "auth", "profiles", "default")
  await mkdir(authDirectory, { recursive: true })
  for (const dir of [userDataRoot, join(userDataRoot, "auth"), join(userDataRoot, "auth", "profiles"), authDirectory]) await chmod(dir, 0o700)
  const roles = new Set([...defaultRoleSlots().map((slot) => slot.roleId), ...Object.keys(ROLE_MODEL_DEFAULTS)])
  await writeFile(join(userDataRoot, "flywheel.toml"), [
    "[custom_providers.fixture]",
    `base_url = ${JSON.stringify(`http://127.0.0.1:${provider.port}/v1`)}`,
    `models = [${JSON.stringify(provider.model)}]`,
    "",
    ...[...roles].flatMap((role) => [`[profiles.default.roles.${JSON.stringify(role)}]`, `model = ${JSON.stringify(provider.model)}`, 'effort = "low"', ""]),
  ].join("\n"))
  await writeFile(join(authDirectory, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-placeholder-key" } }), { mode: 0o600 })
}
