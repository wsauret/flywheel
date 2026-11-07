/** A Terminal-Bench profile shared by the config resolution unit tests and
 *  the launch-boundary integration tests: the checked-in OpenAI arm config,
 *  two tasks, and the submission-shaped attempts. */
export const ARM_CONFIG = "bench/terminal_bench/configs/tb-mini-openai.toml";

export const terminalBenchProfile = `headless:\n  flywheel_config: ${ARM_CONFIG}\ndatasets:\n- name: terminal-bench/terminal-bench-2-1\n  ref: sha256:abc\n  task_names:\n  - terminal-bench/one\n  - terminal-bench/two\nn_attempts: 5\nn_concurrent_trials: 2\n`;

/** A profile that names the arm config and adds `extra` YAML lines. */
export function armProfile(extra = "datasets: [{ task_names: [one] }]\n"): string {
  return `headless: { flywheel_config: ${ARM_CONFIG} }\n${extra}`;
}

/** The launcher arguments that every run needs: the auth profile and the agent repository. */
export const terminalBenchLaunchArgs = ["--auth-profile", "Fixture", "--agent-repo", "owner/agent"];
