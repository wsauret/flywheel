# Sandbox dir helpers. Each test case runs claude in its own temp cwd so
# the real ~/Documents/.../flywheel/plugin/.flywheel state is never touched.

# make_sandbox <test-name> -> echoes path to a fresh tmpdir.
# The tmpdir is git-init'd (claude reads git context at startup) and gets
# a minimal CLAUDE.md so the harness has something to load.
make_sandbox() {
  local name="$1"
  local dir
  dir=$(mktemp -d -t "flywheel-int-${name}-XXXXXX")
  (
    cd "$dir"
    git init -q
    git config user.email "test@flywheel.local"
    git config user.name "Flywheel Test"
    : > .gitignore
    git add .gitignore
    git commit -q -m "init" >/dev/null 2>&1 || true
  )
  echo "$dir"
}

# cleanup_sandbox <dir>
cleanup_sandbox() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] && rm -rf "$dir"
}
