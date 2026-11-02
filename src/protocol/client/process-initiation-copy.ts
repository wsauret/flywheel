/** The notice every surface of Process initiation shows on a Linux machine
 *  where lingering is off for the account (PI-REMOTE-011): the terminal and
 *  web Remote views, the phone, `flywheel remote status`, and `flywheel serve
 *  install`. `user` is the account's name as logind states it. Registering
 *  the service turns lingering on itself where logind allows it, so the
 *  notice shows only where the machine refused that, and the command it
 *  names needs the machine's administrator. The notice asks nothing and
 *  blocks nothing. */
export function lingerNotice(user: string): string {
  return `Flywheel stops when you log out, because lingering is off for ${user}. To keep Flywheel running after you log out, run \`sudo loginctl enable-linger ${user}\` on this machine.`
}
