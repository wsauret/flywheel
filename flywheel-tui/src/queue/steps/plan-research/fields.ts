import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const PLAN_RESEARCH_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the research findings, files discovered, and patterns identified",
    example: '"Researched the codebase and identified 3 key files: hello.py (main module), test_hello.py (tests), and flywheel.toml (config). Project uses Python with simple function-based architecture."',
    required: true,
  },
  {
    key: "decisions",
    description: "Key decisions made during research",
    example: '["Focused research on Python source files"]',
  },
  {
    key: "artifacts",
    description: "Files created during research (e.g., context files)",
    example: '{"files_created": ["hello-world.context.md"]}',
  },
];
