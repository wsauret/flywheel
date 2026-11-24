// Workflow asset manifest: static source of runtime prompt assets.
//
// Defaults to empty (dev mode reads from filesystem instead).
// build-binary.ts populates these with real content before bundling,
// so compiled binaries carry the definition and prompt asset files inline.

export interface WorkflowAssets { [path: string]: string }
export const workflowAssets: WorkflowAssets = {};

export const agents: WorkflowAssets = {};

export const skillDefinitions: WorkflowAssets = {};

export interface ModuleBundleAssets { [bundle: string]: WorkflowAssets }
export const moduleSkillDefinitions: ModuleBundleAssets = {};
