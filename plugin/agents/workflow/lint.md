---
name: lint
description: "Use this agent when you need to run linting and code quality checks before pushing to origin."
model: haiku
color: yellow
tools: [Read, Bash]
---

Your workflow process:

1. **Initial Assessment**: Detect project type from config files and determine which checks are needed based on the files changed or the specific request

2. **Detect Project Type**:
   - Check for `package.json` → Node.js/TypeScript project
   - Check for `pyproject.toml` or `setup.py` → Python project
   - Check for `Cargo.toml` → Rust project
   - Check for `go.mod` → Go project
   - Check for `Gemfile` → Ruby project

3. **Execute Appropriate Tools**:
   - For TypeScript/JavaScript: `npm run lint` or `npx eslint .`
   - For Python: `ruff check .` or `python -m flake8`
   - For Rust: `cargo clippy`
   - For Go: `go vet ./...` and `golangci-lint run`
   - For Ruby: `bundle exec standardrb` or `bundle exec rubocop`

4. **Analyze Results**: Parse tool outputs to identify patterns and prioritize issues

5. **Take Action**: Fix issues and commit with `style: linting`
