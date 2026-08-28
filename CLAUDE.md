# Typewriter

See global CLAUDE.md (`C:\Users\Ben\.claude\CLAUDE.md`) for delegation, provenance, and model-effort rules - this file only holds project-specific detail.

## What this is
A browser app where the user types and the output appears as if struck onto a sheet of paper in a mechanical typewriter: monospaced grid, per-glyph ink variation, soft layered key sounds, carriage motion, and mechanically-modeled correction (backspace does not erase).

## Realism spec
`docs/realism-prompt.md` is the acceptance criteria for look, feel, and sound. Read it before any UI, font, audio, or motion work. Changes to the intended feel go there first, then into code.

## Stack
Pure HTML/CSS/JS, no build step, no framework/bundler, single file per layer (`public/index.html`, `public/style.css`, `public/app.js`). Fonts self-hosted as woff2 under `public/assets/fonts/`, audio samples under `public/assets/audio/`. Web Audio API for all sound (no `new Audio()` per keystroke).

## Hosting
A Cloudflare Worker named `typewriter`, configured by `wrangler.jsonc`, serving `public/` as static assets at https://typewriter.benzur.workers.dev. Repo is on GitHub at `BenzurX/typewriter`, branch `main`. Deploy with `npx wrangler deploy`. This is the same shape as the other side projects (see `ojochal-fundraiser`): git holds the version history, Cloudflare serves it.

Workers Builds is not connected, so `git push` alone does not update the live site - deploying is a separate `npx wrangler deploy`. Connecting the repo so a push deploys automatically is a Cloudflare dashboard step needing Ben's OAuth; it cannot be done from the CLI.

## Layout
The shipping app lives in `public/`, which is the Worker's asset directory. Everything outside it (`docs/`, `progress/`, `stage/`, `wrangler.jsonc`, `CLAUDE.md`, `PROGRESS.md`, `CHANGELOG.md`) is repo furniture and is deliberately not deployed. The asset server publishes the named directory and nothing above it, so that directory boundary is what keeps working notes off the public URL. Anything new that should not be public goes outside `public/`; anything the app loads at runtime goes inside it.

The alternative is `board-game-tracker`'s approach: point `assets.directory` at the repo root and exclude internal paths with an `.assetsignore` file. Both work. This project uses the directory boundary because it fails safe - a new file is private unless deliberately put in `public/`, whereas `.assetsignore` makes every new file public unless someone remembers to list it.

Unmatched paths serve `public/404.html` with a real 404, set by `assets.not_found_handling` in `wrangler.jsonc`. Do not switch that to `single-page-application` - this is a single page, but that mode answers every unknown path with `index.html` and a 200, which hides typos and makes missing assets look like successes.

## Key invariant
The document model is a sparse grid of cells, each holding an ordered list of impressions (glyph, ink color, frozen random seed) - not a string. Overstrike, correction patches, and per-glyph variation all depend on this.

## Pre-push gate
Pushing and deploying are one task in this project, not two. Workers Builds is not connected, so `git push` alone leaves the live site on the old build - a push that stops at GitHub is an unfinished push. Before any `git push`:
- [ ] Bump `APP_VERSION` in `public/app.js` (starts at v0.01, +0.01 per release; tens boundaries and v1.00+ need Ben's approval)
- [ ] Add/fold the pending CHANGELOG.md entry under the new version
- [ ] Bump the service worker `CACHE` name if a service worker exists
- [ ] Confirm `docs/realism-prompt.md` still matches actual behavior if the feel changed

Then ship with `.\ship.ps1` rather than a bare `git push`. It pushes, deploys, and verifies in one run, and refuses to proceed on a dirty tree or an unbumped `APP_VERSION`. A bare `git push` is only correct when the commit deliberately should not reach users yet - say so out loud when doing that, so the undeployed state is a decision on the record and not an oversight.

## Deploy gate
`ship.ps1` performs these automatically after the deploy. Do them by hand only when deploying without it:
- [ ] `npx wrangler deploy`
- [ ] Confirm the live site serves the new build, not a cached old one (compare `APP_VERSION` at `/app.js` against `public/app.js`)
- [ ] Confirm nothing outside `public/` became fetchable
