import { Layer, Scheduler } from "effect"

/** The Effect scheduler a connection's runtime runs on.
 *
 *  Effect yields a fiber through `setImmediate`, and falls back to
 *  `setTimeout(0)` where `setImmediate` does not exist, as in every browser.
 *  A browser holds a timer that is nested five deep to 4 ms or more, so a
 *  burst of calls that a lane opens with went out one every 4 to 5 ms: the
 *  twentieth read of a reattach was written 80 ms after the first. A
 *  `MessageChannel` task has no such clamp, so this scheduler yields through
 *  one where `setImmediate` is missing and changes nothing where it exists. */
export function laneSchedulerLayer(host: LaneHost = globalThis): Layer.Layer<never> {
  return Layer.succeed(Scheduler.Scheduler)(new Scheduler.MixedScheduler("async", nextTask(host)))
}

/** The globals the scheduler chooses its task source from. Tests pass a
 *  browser's set. */
export interface LaneHost {
  setImmediate?(task: () => void): void
  readonly MessageChannel: typeof MessageChannel
}

type ScheduleTask = (task: () => void) => () => void

/** A task source that cancels a task by skipping it when it runs, so a host
 *  hands out no handle to cancel with. */
function nextTask(host: LaneHost): ScheduleTask {
  if (typeof host.setImmediate === "function") {
    return (task) => {
      let live = true
      host.setImmediate?.(() => {
        if (live) task()
      })
      return () => {
        live = false
      }
    }
  }
  return messageChannelTask(host)
}

const channelTasks = new WeakMap<LaneHost, ScheduleTask>()

/** One channel serves every connection on the page: each task posts one
 *  message, and the tasks run in the order they were posted. */
function messageChannelTask(host: LaneHost): ScheduleTask {
  const existing = channelTasks.get(host)
  if (existing) return existing
  const channel = new host.MessageChannel()
  const tasks: Array<() => void> = []
  channel.port1.addEventListener("message", () => {
    tasks.shift()?.()
  })
  // A listener added this way, unlike `onmessage`, needs the port started.
  channel.port1.start()
  // A host that counts open ports would otherwise stay alive for this one.
  const port: object = channel.port1
  if ("unref" in port && typeof port.unref === "function") port.unref()
  const channelTask: ScheduleTask = (task) => {
    let live = true
    tasks.push(() => {
      if (live) task()
    })
    channel.port2.postMessage(0)
    return () => {
      live = false
    }
  }
  channelTasks.set(host, channelTask)
  return channelTask
}
