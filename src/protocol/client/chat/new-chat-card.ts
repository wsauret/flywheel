/** The profile a new chat's card names, or undefined when the card leaves its
 *  profile line out. A card names the profile only when more than one exists:
 *  with one profile, the line would offer a choice the person does not have
 *  (PI-INTERACTION-016). */
export function cardProfileName(profile: { readonly displayName: string; readonly count: number } | undefined): string | undefined {
  return profile !== undefined && profile.count > 1 ? profile.displayName : undefined
}
