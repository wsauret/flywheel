export interface LazyTuiViewImport {
  sourcePath: string;
  targetPath: string;
  dynamic: boolean;
}

export const lazyTuiViewRegistryPath = "src/tui/modals/lazy-modal-registry.ts";
const lazyTuiViewPrimitivePath = "src/tui/components/lazy-tui-view.tsx";
/** A module's terminal home: `src/tui/modules/<id>/index.ts` owns the views under its directory. */
const tuiModuleHomeIndex = /^(src\/tui\/modules\/[^/]+\/)index\.tsx?$/;

function isTuiViewModule(targetPath: string): boolean {
  return targetPath.startsWith("src/tui/modals/") || targetPath.startsWith("src/tui/components/") || targetPath.startsWith("src/tui/modules/");
}

/** The directory a module home's index owns, when `sourcePath` is one. */
function ownedModuleHome(sourcePath: string): string | undefined {
  return tuiModuleHomeIndex.exec(sourcePath)?.[1];
}

/** A deferred import a module home makes of a view under its own directory:
 *  the module's registration, the way the kernel registry's imports are. */
function isModuleHomeRegistration(importRef: LazyTuiViewImport): boolean {
  const home = ownedModuleHome(importRef.sourcePath);
  return home !== undefined && importRef.dynamic && importRef.targetPath.startsWith(home);
}

export function isLazyTuiViewRegistryTarget(importRef: LazyTuiViewImport): boolean {
  if (importRef.sourcePath === lazyTuiViewRegistryPath) {
    return importRef.targetPath !== lazyTuiViewPrimitivePath && isTuiViewModule(importRef.targetPath);
  }
  return isModuleHomeRegistration(importRef);
}

/** True when a registered lazy TUI view is imported outside its safety boundary. */
export function bypassesLazyTuiViewRegistry(importRef: LazyTuiViewImport, registeredTargets: ReadonlySet<string>): boolean {
  if (isModuleHomeRegistration(importRef)) return false;
  if (importRef.sourcePath === lazyTuiViewRegistryPath) {
    return importRef.targetPath !== lazyTuiViewPrimitivePath && isTuiViewModule(importRef.targetPath) && !importRef.dynamic;
  }
  if (registeredTargets.has(importRef.targetPath)) return true;
  return importRef.dynamic && isTuiViewModule(importRef.targetPath);
}
