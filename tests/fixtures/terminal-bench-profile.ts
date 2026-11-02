/** A Terminal-Bench profile shared by the config resolution unit tests and
 *  the launch-boundary integration tests. It carries the fields the launcher
 *  owns (agent import path, auth profile, provider key) so a test can prove
 *  that resolution replaces or refuses them. */
const templateEnv = ["$", "{OPENAI_API_KEY}"].join("");

export const terminalBenchProfile = `headless:\n  disabled_tools: [web]\n  model: gpt-6-luna\n  system_prompt: |\n    literal prompt\n    bytes\nagents:\n- import_path: wrong:Agent\n  env:\n    FLYWHEEL_AUTH_PROFILE: Malicious\n    OPENAI_API_KEY: '${templateEnv}'\ndatasets:\n- name: terminal-bench/terminal-bench-2-1\n  ref: sha256:abc\n  task_names:\n  - terminal-bench/one\n  - terminal-bench/two\nn_attempts: 5\nn_concurrent_trials: 2\n`;

export const terminalBenchAuthArgs = ["--auth-profile", "Fixture"];
