/** Lets go of a hold that a read took. A held domain's read, such as a
 *  `sessionDetailSnapshot`, makes the runtime hold the session for this
 *  connection until the client releases it. A release that arrives before
 *  the read that took the hold leaves that hold in place for the rest of the
 *  connection, so the release waits for `lastRead` to settle, either way.
 *  The client can hold the session again while it waits, so `free` decides
 *  then whether to send `release`. With no read in flight, the decision and
 *  the release happen in this call. A failed release changes nothing that
 *  lasts, because the end of the connection ends every hold. */
export function releaseAfterLastRead(options: {
  readonly lastRead: Promise<unknown> | undefined
  readonly free: () => boolean
  readonly release: () => Promise<void> | void
}): void {
  const tell = async (): Promise<void> => {
    if (options.free()) await options.release()
  }
  const told = options.lastRead === undefined ? tell() : options.lastRead.then(tell, tell)
  void told.catch(() => {})
}
