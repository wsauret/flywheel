/** The wordings one containment refusal carries.
 *
 *  POSIX containment walks a path with descriptor-relative calls and refuses
 *  what leaves the trusted root, so it names the escape. Windows exposes no
 *  descriptor-relative calls: containment there refuses the entry it will not
 *  follow - a symlink, a junction, or a target that is not a regular file - and
 *  states the same refusal in its own words.
 *
 *  A case that exists to prove containment refused matches either wording. A
 *  case about POSIX diagnostic detail, such as the failing syscall or stage,
 *  proves nothing on Windows and is skipped there instead of matched loosely.
 */
export const CONTAINMENT_REFUSAL = /escapes its trusted root|is a symlink or junction|is not a regular file/;
