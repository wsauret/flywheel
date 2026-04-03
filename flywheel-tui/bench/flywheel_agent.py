"""Harbor agent adapter for the Flywheel harness CLI.

Installs Bun inside the Docker container, copies the harness source,
and runs bin/harness with the task instruction.
"""

import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HARNESS_DIR = "/opt/flywheel-harness"
REPO_ROOT = Path(__file__).resolve().parent.parent


class FlywheelHarness(BaseInstalledAgent):
    SUPPORTS_ATIF: bool = False

    CLI_FLAGS = [
        CliFlag("max_turns", cli="--max-turns", type="int", default=100),
        CliFlag("max_tokens", cli="--max-tokens", type="int", default=16384),
        CliFlag("thinking", cli="--thinking", type="int"),
    ]

    @staticmethod
    def name() -> str:
        return "flywheel-harness"

    def get_version_command(self) -> str | None:
        return None

    async def install(self, environment: BaseEnvironment) -> None:
        # Install system deps (curl, unzip) as root
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates git ripgrep"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
            timeout_sec=120,
        )

        # Install Bun as the agent user
        await self.exec_as_agent(
            environment,
            command="curl -fsSL https://bun.sh/install | bash",
            timeout_sec=60,
        )

        # Create harness directory and upload the source tree
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {HARNESS_DIR} && chmod 777 {HARNESS_DIR}",
        )

        # Upload the minimal files needed to run the harness.
        # We use environment.upload() if available, or tar+exec approach.
        # Harbor environments support upload_file() for copying host files in.
        await self._upload_harness(environment)

        # Install npm dependencies inside the container
        await self.exec_as_agent(
            environment,
            command=(
                f'export PATH="$HOME/.bun/bin:$PATH" && '
                f"cd {HARNESS_DIR} && bun install --frozen-lockfile 2>&1 | tail -5"
            ),
            timeout_sec=120,
        )

    async def _upload_harness(self, environment: BaseEnvironment) -> None:
        """Upload the harness source tree into the container."""
        import subprocess
        import tempfile

        # Create a tar of the necessary files
        with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
            tar_path = tmp.name

        try:
            # Tar just the files we need (exclude heavy/unnecessary dirs)
            subprocess.run(
                [
                    "tar",
                    "czf",
                    tar_path,
                    "--exclude=.git",
                    "--exclude=.flywheel",
                    "--exclude=.factory",
                    "--exclude=dist",
                    "--exclude=inspiration",
                    "--exclude=docs",
                    "--exclude=tests",
                    "--exclude=full-stderr.log",
                    "--exclude=jobs",
                    "--exclude=crates/ripgrep/target",
                    "--exclude=crates/ripgrep/src",
                    "--exclude=crates/ripgrep/build.rs",
                    "--exclude=crates/ripgrep/Cargo.toml",
                    "--exclude=crates/ripgrep/Cargo.lock",
                    "--exclude=node_modules",
                    "-C",
                    str(REPO_ROOT),
                    ".",
                ],
                check=True,
                capture_output=True,
            )

            # Upload and extract in container
            await environment.upload_file(tar_path, f"{HARNESS_DIR}/harness.tar.gz")
            await self.exec_as_agent(
                environment,
                command=f"cd {HARNESS_DIR} && tar xzf harness.tar.gz && rm harness.tar.gz",
            )

            # Also upload package.json, bun.lock for install
            # (They should already be in the tar)

        finally:
            os.unlink(tar_path)

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        escaped_instruction = shlex.quote(instruction)

        env = {
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", ""),
            "PATH": "$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        }
        env = {k: v for k, v in env.items() if v}

        model_flag = ""
        if self.model_name:
            model_name = self.model_name
            if "/" in model_name:
                model_name = model_name.split("/", 1)[-1]
            model_flag = f"--model {shlex.quote(model_name)}"

        cli_flags = self.build_cli_flags()

        await self.exec_as_agent(
            environment,
            command=(
                f'export PATH="$HOME/.bun/bin:$PATH" && '
                f"cd {HARNESS_DIR} && "
                f"bun run bin/harness {escaped_instruction} "
                f"{model_flag} {cli_flags} --verbose "
                f"2>&1 | tee /logs/agent/flywheel-harness.txt"
            ),
            env=env,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        log_path = self.logs_dir / "agent" / "flywheel-harness.txt"
        if not log_path.exists():
            return

        try:
            text = log_path.read_text()
            # Parse the final summary line: "completed | 10 turns | 72.3s | 45,123 tokens | $0.1234"
            for line in reversed(text.splitlines()):
                if "turns" in line and "tokens" in line and "$" in line:
                    parts = [p.strip() for p in line.split("|")]
                    for part in parts:
                        if part.startswith("$"):
                            try:
                                context.cost_usd = float(part[1:])
                            except ValueError:
                                pass
                    break
        except Exception:
            pass
