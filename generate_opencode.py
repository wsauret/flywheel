#!/usr/bin/env python3
"""Transform marketplace/flywheel/ markdown files to ~/.config/opencode/ format."""

from __future__ import annotations

import argparse
import os
import re
import shutil
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
        "remove": ["model", "tools"],
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
    (re.compile(r"/fly:(\w+)"), r"/\1"),
    (re.compile(r"^skill:\s*([\w-]+)\s*$", re.MULTILINE), r'skill({ name: "\1" })'),
    (re.compile(r"^See `marketplace/flywheel/skills/.*$\n?", re.MULTILINE), ""),
]

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

        result.append(line)

    # Add new keys before closing ---
    for key, value in config.get("add", {}).items():
        result.append(f"{key}: {value}\n")

    return result


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

            # Transform frontmatter
            fm_lines = transform_frontmatter(fm_lines, config)
            frontmatter = "---\n" + "".join(fm_lines) + "---\n"

            # Transform body if needed
            if config.get("apply_body_transforms"):
                body = transform_body(body)

            content = frontmatter + body

    atomic_write(dest, content)


def get_transform_type(rel_path: Path) -> str | None:
    """Determine transform type from relative path, or None to skip/copy."""
    parts = rel_path.parts

    if parts[0] in SKIP_PATHS:
        return None
    if rel_path.name in SKIP_EXTENSIONS or rel_path.name.startswith("."):
        return None

    if parts[0] == "commands":
        return "commands" if rel_path.suffix == ".md" else None
    if parts[0] == "agents":
        return "agents" if rel_path.suffix == ".md" else None
    if parts[0] == "skills":
        if rel_path.name == "SKILL.md":
            return "skills"
        # Copy other skill files verbatim (assets, scripts, etc.)
        return "copy"

    return None


def main() -> int:
    """Transform marketplace/flywheel/ directory to ~/.config/opencode/ format."""
    parser = argparse.ArgumentParser(
        description="Transform marketplace/flywheel/ to ~/.config/opencode/ format"
    )
    parser.add_argument("--source", type=Path, default=Path("local-marketplace/flywheel"))
    parser.add_argument("--output", type=Path, default=Path.home() / ".config/opencode")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done")
    args = parser.parse_args()

    if not args.source.is_dir():
        print(f"Error: Source '{args.source}' not found", file=sys.stderr)
        return 1

    # Subdirectories we manage (only these will be replaced)
    managed_subdirs = {"agents", "commands", "skills"}

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

        # Flatten commands/fly/*.md -> commands/*.md
        if transform_type == "commands" and len(rel.parts) > 2:
            dest_rel = Path("commands") / rel.name
        else:
            dest_rel = rel

        dest = (temp_base or args.output) / dest_rel

        if args.dry_run:
            action = "copy" if transform_type == "copy" else f"transform ({transform_type})"
            print(f"{rel} -> {dest_rel} [{action}]")
        else:
            if transform_type == "copy":
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                counts["copied"] += 1
            else:
                transform_file(src, dest, transform_type)
                counts[transform_type] += 1

    if not args.dry_run and temp_base:
        # Atomic swap of only the managed subdirectories
        args.output.mkdir(parents=True, exist_ok=True)
        for subdir in managed_subdirs:
            temp_subdir = temp_base / subdir
            final_subdir = args.output / subdir
            if temp_subdir.exists():
                if final_subdir.exists():
                    shutil.rmtree(final_subdir)
                temp_subdir.rename(final_subdir)
        # Clean up temp directory
        if temp_base.exists():
            shutil.rmtree(temp_base)

    print(f"Done: {counts['commands']} commands, {counts['agents']} agents, "
          f"{counts['skills']} skills, {counts['copied']} copied, {counts['skipped']} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
