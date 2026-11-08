/** The launcher arguments shared by the config resolution unit tests and the
 *  launch-boundary integration tests: Terminal-Bench 2.1, the checked-in
 *  OpenAI arm config, the auth profile, and the agent repository. A test adds
 *  its own task selection. */
export const ARM_CONFIG = "bench/harbor/configs/tb-mini-openai.toml";

export const harborLaunchArgs = ["--benchmark", "terminal-bench-2.1", "--arm", ARM_CONFIG, "--auth-profile", "Fixture", "--agent-repo", "owner/agent"];
