import type { Step } from "../types";

export interface RoleMapping<R extends string> {
  hintMap: Record<string, R>;
  titleMap: [keyword: string, role: R][];
  defaultRole: R;
}

export function detectRole<R extends string>(step: Step, mapping: RoleMapping<R>): R {
  const hint = step.dispatcherHint?.toLowerCase();
  if (hint && hint in mapping.hintMap) {
    return mapping.hintMap[hint];
  }

  const title = step.title.toLowerCase();
  for (const [keyword, role] of mapping.titleMap) {
    if (title.includes(keyword)) return role;
  }

  return mapping.defaultRole;
}
