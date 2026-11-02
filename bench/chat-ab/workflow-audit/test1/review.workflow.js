export const meta = {
  name: 'review-five-files',
  description: 'Review each file, merge duplicate findings, verify each finding, and report.',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Report' }],
}

// Test 1 of the workflow audit campaign (bench/chat-ab/workflow-audit.ts), as a Claude Code workflow
// script. review.workflow.yaml holds the same topology as a Flywheel workflow file: the same instructions, byte for
// byte, and the same output schemas (tests/unit/bench/chat-ab-claude-code-test1.test.ts). No agent call names a model
// or an effort: the subject uses its normal model routing.
// Launch input: { "files": [{ "path": "src/a.ts" }, { "path": "src/b.ts" }] }

const REVIEW = 'Review the file in your item context for correctness bugs. Report only a bug that you can point to by line, and report at most 6. Do not report style issues.'
const VERIFY = 'Try to refute the finding in your item context. Confirm it only when you reproduce it or trace it in the code. Write any test file only under a temporary directory, and change no file of the repository.'
const REPORT = 'Write the final report. List each confirmed finding with its file, its line, and its evidence. Then list each refuted finding with the reason in one sentence.'

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          site: { type: 'string', description: 'Exactly `<path>:<line>`, such as `src/a.ts:42`. Build it only from path and line.' },
          path: { type: 'string', description: 'Repository-relative path, with no leading ./' },
          line: { type: 'number', description: 'The first line of the bug.' },
          claim: { type: 'string', description: 'The bug in one sentence.' },
        },
        required: ['site', 'path', 'line', 'claim'],
        additionalProperties: false,
      },
      maxItems: 6,
      description: 'The correctness bugs in this file.',
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

const VERDICT = {
  type: 'object',
  properties: {
    site: { type: 'string', description: 'The site of the finding, as your item context states it.' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted'], description: 'The result of the check.' },
    evidence: { type: 'string', description: 'What you ran or read, and what it showed.' },
  },
  required: ['site', 'verdict', 'evidence'],
  additionalProperties: false,
}

// The task text of one agent: its instructions, then the data it works on, as JSON.
const task = (instructions, name, value) => `${instructions}\n\n${name}:\n${JSON.stringify(value, null, 2)}`

// The model may pass the launch input as JSON text.
const input = typeof args === 'string' ? JSON.parse(args) : args
const files = input.files

phase('Review')
const reviews = await parallel(files.map((file) => () => agent(task(REVIEW, 'Item context', file), { label: file.path, phase: 'Review', schema: FINDINGS })))

// The dedupe join of the Flywheel file (`dedupe@1`): the reviews in path order, then each review's findings in list
// order, and the first finding of each site is kept with the path of its review as `branch`.
const kept = []
const dropped = []
const seen = new Set()
const byPath = files.map((file, index) => ({ path: file.path, review: reviews[index] })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
for (const { path, review } of byPath) {
  if (review === null) {
    log(`review of ${path} failed`)
    continue
  }
  for (const finding of review.findings) {
    if (seen.has(finding.site)) dropped.push({ key: finding.site, branch: path })
    else {
      seen.add(finding.site)
      kept.push({ ...finding, branch: path })
    }
  }
}
log(`kept ${kept.length} findings, dropped ${dropped.length} duplicates`)

phase('Verify')
const verify = await parallel(kept.map((finding) => () => agent(task(VERIFY, 'Item context', finding), { label: finding.site, phase: 'Verify', schema: VERDICT })))

phase('Report')
return await agent(task(REPORT, 'verify', verify.filter((verdict) => verdict !== null)), { label: 'report', phase: 'Report' })
