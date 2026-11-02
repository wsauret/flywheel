# flywl.sh website

This workspace is the static site at [flywl.sh](https://flywl.sh). It is an [Astro](https://astro.build) project: the pages are in `src/pages/`, the shared layout is in `src/layouts/`, and static files are in `public/`.

Run these commands from the repository root after `bun install --frozen-lockfile`:

```bash
bun run --cwd website dev       # serve the site locally with live reload
bun run --cwd website build     # build the static site into website/dist/
bun run --cwd website test      # build the site, then test the built output
```

The scripts run Astro under Bun, so Node is not necessary. `bun run --cwd website test` is the check for a change to the site. The tests are in `tests/`.

The maintainer deploys the site to Cloudflare. A pull request does not deploy anything, and a contributor does not need a Cloudflare account.
