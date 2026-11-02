import type { DeviceStore } from "./relay-device.js"

/** The contract between the phone's hosted page and the phone shell it loads.
 *
 *  The hosted page at `remote.flywl.sh` is a bootstrap that deploys almost
 *  never. It owns what must outlive every client build: the device key, the
 *  pairings, the Web Push service worker. It chooses which client identity to
 *  load from what the relay announces, loads that build's phone shell from
 *  the relay, and hands it the device store (`relay-device.ts`) through this
 *  contract before the shell runs. The shell ships with the runtime, so a
 *  shell can be newer or older than the page that loads it: every shape here
 *  is part of the host contract `HOST_CONTRACT_VERSION` numbers, and the page
 *  states that version on `#root` beside the identity of the client it
 *  loaded. */

/** Everything the hosted page hands the shell. */
export interface PhoneBootstrap {
  readonly store: DeviceStore
}

declare global {
  interface Window {
    /** Set by the hosted page before the shell's script runs. A shell bundle
     *  is a classic script with no exports, so a property of the window is
     *  the one place both can name. Absent on any other page. */
    flywheelPhoneBootstrap?: PhoneBootstrap
  }
}
