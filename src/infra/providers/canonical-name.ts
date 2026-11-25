export function canonicalize(name: string): string {
  return name.toLowerCase().trim();
}

/** Turn a slug like "reviewer-code-quality" into "Reviewer Code Quality". */
export function deslugify(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
