#!/usr/bin/env python3
"""Install Flywheel for OpenCode.

Transforms flywheel/ markdown files to ~/.config/opencode/ format and
optionally configures Context7 MCP server.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import TypedDict


class TransformConfig(TypedDict):
    """Configuration for transforming a file type."""

    remove: list[str]
    add: dict[str, str]
    apply_body_transforms: bool


TRANSFORMS: dict[str, TransformConfig] = {
    "commands": {
        "remove": ["name", "argument-hint"],
        "add": {},
        "apply_body_transforms": True,
    },
    "agents": {
        "remove": ["name", "tools", "skills"],
        "add": {"mode": "subagent"},
        "apply_body_transforms": False,
    },
    "skills": {
        "remove": ["allowed-tools"],
        "add": {},
        "apply_body_transforms": False,
    },
}

BODY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"#\$ARGUMENTS"), "$ARGUMENTS"),
    (re.compile(r"/fly:(\w+)"), r"/fly/\1"),
    (re.compile(r"^skill:\s*([\w-]+)\s*$", re.MULTILINE), r'skill({ name: "\1" })'),
    (re.compile(r"^See `flywheel/skills/.*$\n?", re.MULTILINE), ""),
    (re.compile(r"(references/[\w-]+)\.md"), r"\1.txt"),
]

# Path replacements applied to ALL text files (skills, agents, commands, references).
# Order matters: longer/more-specific patterns first to avoid partial matches.
PATH_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # --- Claude Code tool names -> OpenCode tool names ---
    # AskUserQuestion -> question (tool name in prose and code)
    (re.compile(r"\bAskUserQuestion\b"), "question"),
    # TaskCreate/TaskUpdate/TaskList -> todowrite/todoread
    (re.compile(r"\bTaskCreate\b"), "todowrite"),
    (re.compile(r"\bTaskUpdate\b"), "todowrite"),
    (re.compile(r"\bTaskList\b"), "todoread"),
    # --- Claude Code-specific paths and env vars ---
    # ~/.claude/tasks (task storage path — no OpenCode equivalent)
    (re.compile(r"`~/\.claude/tasks`"), "the todo system"),
    (re.compile(r"~/\.claude/tasks"), "the todo system"),
    # CLAUDE_CODE_TASK_LIST_ID env var (no OpenCode equivalent — remove references)
    (re.compile(r"[^\n]*CLAUDE_CODE_TASK_LIST_ID[^\n]*\n?"), ""),
    # claude --worktree -> git worktree add
    (re.compile(r"`claude --worktree <branch>` or "), ""),
    # flywheel/skills/ (source repo path) -> ~/.config/opencode/skills/ (installed path)
    (re.compile(r"\bflywheel/skills/"), "~/.config/opencode/skills/"),
    # --- Claude Code directory paths ---
    # ~/.claude/plugins/cache .../agents/*.md -> ~/.config/opencode/agents
    (
        re.compile(r"find ~/\.claude/plugins/cache -path \"\*/agents/\*\.md\"[^\n]*"),
        'find ~/.config/opencode/agents -name "*.md" 2>/dev/null',
    ),
    # ~/.claude/plugins -name "SKILL.md" -> ~/.config/opencode/skills
    (
        re.compile(r"find ~/\.claude/plugins -name \"SKILL\.md\"[^\n]*"),
        'find ~/.config/opencode/skills -name "SKILL.md" 2>/dev/null',
    ),
    # ~/.claude/agents -> ~/.config/opencode/agents
    (re.compile(r"~/\.claude/agents"), "~/.config/opencode/agents"),
    # ~/.claude/skills -> ~/.config/opencode/skills
    (re.compile(r"~/\.claude/skills/"), "~/.config/opencode/skills/"),
    (re.compile(r"~/\.claude/skills\b"), "~/.config/opencode/skills"),
    # .claude/agents (project-local) -> .opencode/agents
    (re.compile(r"(?<![~/])\.claude/agents"), ".opencode/agents"),
    # .claude/skills (project-local) -> .opencode/skills
    (re.compile(r"(?<![~/])\.claude/skills/"), ".opencode/skills/"),
    (re.compile(r"(?<![~/])\.claude/skills\b"), ".opencode/skills"),
    # .claude/flywheel/... (local plugin path) -> .opencode/...
    (re.compile(r"(?<![~/])\.claude/flywheel/"), ".opencode/"),
    # ${CLAUDE_PLUGIN_ROOT}/skills/ -> ~/.config/opencode/skills/
    (re.compile(r"\$\{CLAUDE_PLUGIN_ROOT\}/skills/"), "~/.config/opencode/skills/"),
    # --- Agent namespace ---
    # Prefix fly/ agent names with fly/ (agents live under agents/fly/ in OpenCode).
    # Negative lookbehind avoids double-prefixing if fly/ is already present.
    (re.compile(r"(?<!fly/)(?<!agents/)\b((?:reviewer|analyzer|locator)-[\w-]+)"), r"fly/\1"),
    # --- Product names and docs ---
    # CLAUDE.md -> AGENTS.md
    (re.compile(r"\bCLAUDE\.md\b"), "AGENTS.md"),
    # Claude Code UI / Claude Code (product name in prose)
    (re.compile(r"Claude Code UI"), "OpenCode UI"),
    (re.compile(r"Claude Code"), "OpenCode"),
    # Claude attribution -> AI attribution
    (re.compile(r"Claude attribution"), "AI attribution"),
]

TEXT_SUFFIXES = {".md", ".txt"}

# Map short model names (used in source files) to full OpenCode model IDs.
# "inherit" means "use the parent agent's model" — achieved by omitting the key.
# These are fallback values; resolve_model_map() queries the CLI for current IDs.
MODEL_MAP_DEFAULTS: dict[str, str | None] = {
    "haiku": "anthropic/claude-haiku-4-5",
    "sonnet": "anthropic/claude-sonnet-4-5",
    "opus": "anthropic/claude-opus-4-6",
    "inherit": None,  # Remove the key so OpenCode inherits from parent
}

# Populated at runtime by resolve_model_map(); falls back to MODEL_MAP_DEFAULTS.
MODEL_MAP: dict[str, str | None] = dict(MODEL_MAP_DEFAULTS)

# Patterns to match short names to undated model aliases from `opencode models`.
# Each entry: (short_name, regex capturing major and minor version numbers).
# Minor version limited to 1-3 digits to exclude dated IDs like "4-20250514".
_MODEL_FAMILY_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("haiku", re.compile(r"^anthropic/claude-haiku-(\d+)-(\d{1,3})$")),
    ("sonnet", re.compile(r"^anthropic/claude-sonnet-(\d+)-(\d{1,3})$")),
    ("opus", re.compile(r"^anthropic/claude-opus-(\d+)-(\d{1,3})$")),
]


def _version_key(model_id: str, pattern: re.Pattern[str]) -> tuple[int, int]:
    """Extract (major, minor) version tuple from a model ID for sorting."""
    m = pattern.match(model_id)
    if not m:
        return (0, 0)
    return (int(m.group(1)), int(m.group(2)))


def resolve_model_map() -> None:
    """Query ``opencode models anthropic`` and update MODEL_MAP with latest IDs.

    For each model family (haiku, sonnet, opus), we find all undated aliases
    (e.g. ``anthropic/claude-haiku-4-5``, not ``...-20251001``) and pick the
    one with the highest version number.

    Falls back silently to MODEL_MAP_DEFAULTS if the CLI is unavailable.
    """
    try:
        result = subprocess.run(
            ["opencode", "models", "anthropic"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return

    available = [line.strip() for line in result.stdout.splitlines() if line.strip()]

    for short_name, pattern in _MODEL_FAMILY_PATTERNS:
        matches = [m for m in available if pattern.match(m)]
        if not matches:
            continue
        # Highest version = latest generation.
        best = str(max(matches, key=lambda m: _version_key(m, pattern)))
        MODEL_MAP[short_name] = best


SKIP_PATHS = {".claude-plugin", "README.md"}
SKIP_EXTENSIONS = {".DS_Store"}


def transform_frontmatter(lines: list[str], config: TransformConfig) -> list[str]:
    """Remove specified keys (including multiline blocks), add new keys."""
    result = []
    in_block = False
    remove_keys = config.get("remove", [])

    for line in lines:
        # Check if starting a key to remove
        if any(line.startswith(f"{key}:") for key in remove_keys):
            # Inline list (ends with ]) = single line; otherwise multiline block
            in_block = not line.rstrip().endswith("]")
            continue

        # Skip indented continuation lines
        if in_block:
            if line.startswith("  ") or line.startswith("\t"):
                continue
            in_block = False

        # Map short model names to full OpenCode model IDs
        if line.startswith("model:"):
            short_name = line.split(":", 1)[1].strip()
            if short_name in MODEL_MAP:
                full_id = MODEL_MAP[short_name]
                if full_id is None:
                    # "inherit" — omit the key entirely
                    continue
                line = f"model: {full_id}\n"

        result.append(line)

    # Add new keys before closing ---
    for key, value in config.get("add", {}).items():
        result.append(f"{key}: {value}\n")

    return result


def transform_paths(content: str) -> str:
    """Replace Claude-specific paths with OpenCode equivalents."""
    for pattern, replacement in PATH_PATTERNS:
        content = pattern.sub(replacement, content)
    return content


def transform_body(content: str) -> str:
    """Apply regex replacements to body content."""
    for pattern, replacement in BODY_PATTERNS:
        content = pattern.sub(replacement, content)
    return content


def is_safe_path(path: Path, base: Path) -> bool:
    """Check path is within base directory and not a symlink."""
    if path.is_symlink():
        return False
    try:
        return path.resolve().is_relative_to(base.resolve())
    except ValueError:
        return False


def atomic_write(path: Path, content: str) -> None:
    """Write content atomically using temp file + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_str = tempfile.mkstemp(dir=path.parent, prefix=".tmp_")
    tmp = Path(tmp_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        tmp.replace(path)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def extract_skills(fm_lines: list[str]) -> list[str]:
    """Extract skill names from a 'skills:' frontmatter field."""
    for line in fm_lines:
        if line.startswith("skills:"):
            # Parse inline list: skills: [foo, bar-baz]
            match = re.search(r"\[([^\]]*)\]", line)
            if match:
                return [s.strip() for s in match.group(1).split(",") if s.strip()]
    return []


def skills_to_body_prefix(skills: list[str]) -> str:
    """Generate a body-level instruction to load skills at agent startup."""
    if not skills:
        return ""
    lines = [
        "**IMPORTANT — Before starting any work, load the following skills using the skill tool:**\n",
    ]
    for name in skills:
        lines.append(f'- `skill({{ name: "{name}" }})`')
    lines.append("")
    lines.append("These skills contain required conventions and standards. Do not skip this step.\n\n")
    return "\n".join(lines)


def transform_file(src: Path, dest: Path, transform_type: str) -> None:
    """Read, transform, and write a single file."""
    config = TRANSFORMS[transform_type]
    content = src.read_text(encoding="utf-8")

    # Split frontmatter from body
    if content.startswith("---\n"):
        parts = content.split("---\n", 2)
        if len(parts) >= 3:
            fm_lines = parts[1].splitlines(keepends=True)
            body = parts[2]

            # For agents: extract skills before stripping, inject into body
            if transform_type == "agents":
                skills = extract_skills(fm_lines)
                body = skills_to_body_prefix(skills) + body

            # Transform frontmatter
            fm_lines = transform_frontmatter(fm_lines, config)
            frontmatter = "---\n" + "".join(fm_lines) + "---\n"

            # Transform body if needed
            if config.get("apply_body_transforms"):
                body = transform_body(body)

            content = frontmatter + body

    # Always apply path transforms
    content = transform_paths(content)

    atomic_write(dest, content)


def get_transform_type(rel_path: Path) -> str | None:
    """Determine transform type from relative path, or None to skip/copy."""
    parts = rel_path.parts

    if parts[0] in SKIP_PATHS:
        return None
    if rel_path.name in SKIP_EXTENSIONS or rel_path.name.startswith("."):
        return None

    if parts[0] == "commands":
        if "references" in parts:
            return "copy_as_txt" if rel_path.suffix == ".md" else "copy"
        return "commands" if rel_path.suffix == ".md" else None
    if parts[0] == "agents":
        return "agents" if rel_path.suffix == ".md" else None
    if parts[0] == "skills":
        if rel_path.name == "SKILL.md":
            return "skills"
        # Copy other skill files verbatim (assets, scripts, etc.)
        return "copy"

    return None


def get_shell_profile() -> Path:
    """Determine the user's shell profile file."""
    shell = os.environ.get("SHELL", "")
    home = Path.home()
    if "zsh" in shell:
        return home / ".zshrc"
    if "bash" in shell:
        bash_profile = home / ".bash_profile"
        return bash_profile if bash_profile.exists() else home / ".bashrc"
    return home / ".profile"


def configure_context7(config_path: Path, dry_run: bool) -> None:
    """Prompt for Context7 API key and write MCP config to opencode.json."""
    api_key = os.environ.get("CONTEXT7_API_KEY", "")
    save_to_profile = False

    if api_key:
        print("  * Found CONTEXT7_API_KEY in environment, using it...")
    else:
        print("  * Context7 provides up-to-date framework documentation for the planning workflow.")
        try:
            api_key = input("  * Enter your Context7 API key (or press Enter to skip): ").strip()
        except (EOFError, KeyboardInterrupt):
            api_key = ""
        save_to_profile = True

    if not api_key:
        print("  * Skipped Context7 configuration")
        return

    # Build the MCP config block
    context7_mcp: dict = {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp",
        "headers": {"CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"},
    }

    # Read existing config or start fresh
    config: dict = {}
    if config_path.exists():
        try:
            text = config_path.read_text(encoding="utf-8")
            if text.strip():
                config = json.loads(text)
        except (json.JSONDecodeError, OSError):
            pass

    # Merge MCP config
    config.setdefault("$schema", "https://opencode.ai/config.json")
    config.setdefault("mcp", {})
    config["mcp"]["context7"] = context7_mcp

    if dry_run:
        print(f"  [dry-run] Would write Context7 config to {config_path}")
        print(f"  [dry-run] Config: {json.dumps(config, indent=2)}")
    else:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(config_path, json.dumps(config, indent=2) + "\n")
        print(f"  \u2713 Context7 configured in {config_path}")

    # Offer to save API key to shell profile
    if save_to_profile:
        profile = get_shell_profile()
        try:
            choice = input(f"  * Save API key to {profile} for future installs? [Y/n]: ").strip()
        except (EOFError, KeyboardInterrupt):
            choice = "n"
        if not choice or choice.lower().startswith("y"):
            if dry_run:
                print(f"  [dry-run] Would save CONTEXT7_API_KEY to {profile}")
            else:
                profile_text = profile.read_text(encoding="utf-8") if profile.exists() else ""
                export_line = f'export CONTEXT7_API_KEY="{api_key}"'
                if "export CONTEXT7_API_KEY=" in profile_text:
                    # Update existing entry
                    profile_text = re.sub(
                        r"^export CONTEXT7_API_KEY=.*$",
                        export_line,
                        profile_text,
                        flags=re.MULTILINE,
                    )
                    profile.write_text(profile_text, encoding="utf-8")
                    print(f"  \u2713 Updated CONTEXT7_API_KEY in {profile}")
                else:
                    with profile.open("a", encoding="utf-8") as f:
                        f.write(f"\n# Context7 API key for Flywheel plugin\n{export_line}\n")
                    print(f"  \u2713 Added CONTEXT7_API_KEY to {profile}")
                print("  * Restart your terminal to use this variable in future sessions.")


def main() -> int:
    """Install Flywheel for OpenCode."""
    parser = argparse.ArgumentParser(description="Install Flywheel for OpenCode")
    parser.add_argument("--source", type=Path, default=Path("flywheel"))
    parser.add_argument("--output", type=Path, default=Path.home() / ".config/opencode")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done")
    parser.add_argument(
        "--no-context7",
        action="store_true",
        help="Skip Context7 MCP configuration",
    )
    args = parser.parse_args()

    print("================================")
    print("  Flywheel Installer (OpenCode)")
    print("================================")
    print("")

    if not args.source.is_dir():
        print(f"Error: Source '{args.source}' not found", file=sys.stderr)
        return 1

    print("Step 1: Resolving model IDs...")
    resolve_model_map()
    for short, full in MODEL_MAP.items():
        if full is not None:
            print(f"  {short:8s} -> {full}")
    print()

    print("Step 2: Installing Flywheel files...")

    # Paths we manage (relative to output), only these will be replaced.
    # agents/fly and commands/fly are namespaced subfolders so we don't
    # clobber agents/commands from other sources.  skills use per-skill
    # directories so the whole skills/ tree is ours to manage.
    managed_paths = [
        Path("agents") / "fly",
        Path("commands") / "fly",
        Path("skills"),
    ]

    # Use temp directory for atomic swap of each subdir
    temp_base = args.output.parent / f".{args.output.name}.tmp" if not args.dry_run else None

    counts = {"commands": 0, "agents": 0, "skills": 0, "copied": 0, "skipped": 0}

    for src in args.source.rglob("*"):
        if src.is_dir():
            continue
        if not is_safe_path(src, args.source):
            print(f"Skipping unsafe path: {src}", file=sys.stderr)
            counts["skipped"] += 1
            continue

        rel = src.relative_to(args.source)
        transform_type = get_transform_type(rel)

        if transform_type is None:
            counts["skipped"] += 1
            continue

        if transform_type == "copy_as_txt":
            dest_rel = rel.with_suffix(".txt")
        elif transform_type == "agents":
            # Namespace agents under fly/ subfolder
            dest_rel = Path("agents") / "fly" / rel.relative_to("agents")
        elif transform_type == "commands":
            # Keep commands/fly/ subfolder structure (source already has it)
            dest_rel = rel
        else:
            dest_rel = rel

        dest = (temp_base or args.output) / dest_rel

        if args.dry_run:
            action = "copy" if transform_type in ("copy", "copy_as_txt") else f"transform ({transform_type})"
            print(f"{rel} -> {dest_rel} [{action}]")
        else:
            if transform_type in ("copy", "copy_as_txt"):
                dest.parent.mkdir(parents=True, exist_ok=True)
                # Apply path transforms to text files; binary files get raw copy
                if src.suffix in TEXT_SUFFIXES:
                    text = src.read_text(encoding="utf-8")
                    atomic_write(dest, transform_paths(text))
                else:
                    shutil.copy2(src, dest)
                counts["copied"] += 1
            else:
                transform_file(src, dest, transform_type)
                counts[transform_type] += 1

    if not args.dry_run and temp_base:
        # Atomic swap of only the managed paths
        args.output.mkdir(parents=True, exist_ok=True)
        for managed in managed_paths:
            temp_managed = temp_base / managed
            final_managed = args.output / managed
            if temp_managed.exists():
                if final_managed.exists():
                    shutil.rmtree(final_managed)
                final_managed.parent.mkdir(parents=True, exist_ok=True)
                temp_managed.rename(final_managed)
        # Clean up temp directory
        if temp_base.exists():
            shutil.rmtree(temp_base)

    print(
        f"  \u2713 {counts['commands']} commands, {counts['agents']} agents, "
        f"{counts['skills']} skills, {counts['copied']} copied, {counts['skipped']} skipped"
    )

    # Step 3: Context7 MCP configuration
    if not args.no_context7:
        print("\nStep 3: Configuring Context7...")
        config_path = args.output / "opencode.json"
        configure_context7(config_path, args.dry_run)
    else:
        print("\nStep 3: Skipped Context7 configuration (--no-context7)")

    print("\nInstallation Complete!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
