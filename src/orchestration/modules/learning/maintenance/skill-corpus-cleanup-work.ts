import { renderSkillCorpusCleanupInstruction, type SkillCorpusCleanupRequest } from "./skill-corpus-cleanup-classifier.js"

const CLEANUP_CONCURRENCY = 2

/** Classifies each cleanup request with at most two children in flight and
 *  returns the outputs in request order. The first rejection aborts the signal
 *  that every child receives, so no queued request starts after it, and the
 *  call rejects with it only after every started child settles. */
export async function classifySkillCorpusCleanupWork<Output>(
  work: readonly SkillCorpusCleanupRequest[],
  classify: (request: SkillCorpusCleanupRequest, instruction: string, signal: AbortSignal) => Promise<Output>,
  signal?: AbortSignal,
): Promise<readonly Output[]> {
  const campaign = new AbortController()
  const childSignal = signal ? AbortSignal.any([signal, campaign.signal]) : campaign.signal
  const results: Output[] = []
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < work.length) {
      childSignal.throwIfAborted()
      const index = nextIndex
      nextIndex += 1
      const request = work.at(index)
      if (!request) throw new Error(`Cleanup work index ${index} is missing`)
      results[index] = await classify(request, renderSkillCorpusCleanupInstruction(request), childSignal)
    }
  }
  const workers = Array.from({ length: Math.min(CLEANUP_CONCURRENCY, work.length) }, () => worker().catch((error: unknown) => {
    campaign.abort(error)
    throw error
  }))
  const settled = await Promise.allSettled(workers)
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed) throw failed.reason
  return results
}
