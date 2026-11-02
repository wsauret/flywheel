import { createAccountModuleAnswerReader } from "../protocol/account-attach.js"

/** One `module` attach: writes its preface and reads answers until the
 *  service ends the request. A close before the first byte cannot say why on
 *  the wire: a service refuses an attach it cannot read by closing it, which
 *  is what an older build does with the `module` intent, and a current
 *  service that accepted the request and then exited closes the same way. */
export function requestAccountModule(socketPath: string, preface: Uint8Array, onAnswer: (answer: unknown) => void): Promise<void> {
  const reader = createAccountModuleAnswerReader()
  return new Promise((resolve, reject) => {
    let settled = false
    let answered = false
    const finish = (socket: { end(): void } | undefined, error?: unknown): void => {
      if (settled) return
      settled = true
      socket?.end()
      if (error === undefined) resolve()
      else reject(error)
    }
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) { socket.write(preface) },
        data(socket, chunk) {
          answered = true
          try {
            for (const event of reader.push(chunk)) {
              if (event.kind === "answer") onAnswer(event.payload)
              else finish(socket, event.kind === "failed" ? new Error(event.error) : undefined)
            }
          } catch (error) {
            // An answer the caller cannot read ends the request with its reason.
            finish(socket, error)
          }
        },
        error(socket, error) { finish(socket, error) },
        close() {
          finish(undefined, new Error(answered
            ? "The account service closed before it ended the request."
            : "The account service closed before it answered. A running service of an older build that does not accept this request is a likely cause: run /restart in a Flywheel terminal to restart it, then run this command again."))
        },
      },
    }).catch((error: unknown) => { finish(undefined, error) })
  })
}
