/** The lifetimes of the projects that the runtime background Worker serves:
 *  one open project per root until its release, and the reads that a project
 *  accepted, which its release joins before the project closes. */

interface RuntimeBackgroundProjectMap<Project> {
  get(projectRoot: string): Project
  release(projectRoot: string): Promise<void>
  dispose(): Promise<void>
}

/** Admits a project's reads until its close. Close cancels what the project
 *  can cancel, waits for every read it admitted, then disposes the project;
 *  a read that arrives after close starts rejects. */
export function createRuntimeBackgroundProjectOperations() {
  const active = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined
  return {
    run<A>(start: () => Promise<A>): Promise<A> {
      if (closing) return Promise.reject(new Error("Runtime background project is closing"))
      const operation = Promise.resolve().then(start)
      active.add(operation)
      void operation.finally(() => active.delete(operation)).catch(() => {})
      return operation
    },
    close(cancel: () => void, dispose: () => Promise<void>): Promise<void> {
      closing ??= (async () => {
        cancel()
        await Promise.allSettled(active)
        await dispose()
      })()
      return closing
    },
  }
}

/** Opens one project per root on its first read. A release closes it, and a
 *  later read opens it again; disposal closes every project, joins a release
 *  in progress, and refuses every later read. */
export function createRuntimeBackgroundProjectMap<Project extends { close(): Promise<void> }>(
  createProject: (projectRoot: string) => Project,
): RuntimeBackgroundProjectMap<Project> {
  const projects = new Map<string, Project>()
  const releases = new Map<string, { project: Project; promise: Promise<void> }>()
  let disposal: Promise<void> | undefined
  const closeProject = (projectRoot: string, project: Project): Promise<void> => {
    const existing = releases.get(projectRoot)
    if (existing?.project === project) return existing.promise
    const promise = project.close().finally(() => {
      if (projects.get(projectRoot) === project) projects.delete(projectRoot)
      if (releases.get(projectRoot)?.project === project) releases.delete(projectRoot)
    })
    releases.set(projectRoot, { project, promise })
    return promise
  }
  return {
    get(projectRoot) {
      if (disposal) throw new Error("Runtime background Worker is shutting down")
      let project = projects.get(projectRoot)
      if (!project) {
        project = createProject(projectRoot)
        projects.set(projectRoot, project)
      }
      return project
    },
    async release(projectRoot) {
      const project = projects.get(projectRoot)
      if (!project) return
      await closeProject(projectRoot, project)
    },
    async dispose() {
      disposal ??= (async () => {
        await Promise.all([...projects].map(([projectRoot, project]) => closeProject(projectRoot, project)))
      })()
      await disposal
    },
  }
}
