Verify the behavioral claims that this completed change relies on.

CHANGE:
Large files used to upload in one PUT. This change uploads files larger than one chunk as parallel parts: it starts a multipart upload, sends each part through a new retry wrapper (retry.ts) under a new concurrency limiter (limiter.ts), and then asks the store to assemble the parts. The change is in diff.patch; the project in this directory is the code after the change.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the plan's cost and correctness estimates rest on these; trace each one through the code before you give a verdict):
1. "A part is PUT at most MAX_ATTEMPTS (3) times, so a part that keeps failing with 503 costs at most three requests before the upload fails."
2. "A part that fails with a 4xx status other than 408 or 429, for example 404, is sent exactly once; neither layer retries it."
3. "completeUpload is called only after every part's PUT has been acknowledged, so the assemble request always lists every part."
4. "No more than options.concurrency part PUTs are in flight at any moment, including while one part sleeps between retries."
5. "When the file size is an exact multiple of chunkSize, the computed part ranges cover every byte exactly once: the last part is not dropped and no empty trailing part is made."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
