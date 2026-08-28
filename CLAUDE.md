# Typewriter

See global CLAUDE.md (`C:\Users\Ben\.claude\CLAUDE.md`) for delegation, provenance, and model-effort rules - this file only holds project-specific detail.

## What this is
A browser app where the user types and the output appears as if struck onto a sheet of paper in a mechanical typewriter: monospaced grid, per-glyph ink variation, soft layered key sounds, carriage motion, and mechanically-modeled correction (backspace does not erase).

## Realism spec
`docs/realism-prompt.md` is the acceptance criteria for look, feel, and sound. Read it before any UI, font, audio, or motion work. Changes to the intended feel go there first, then into code.

## Stack
Pure HTML/CSS/JS, no build step, no framework/bundler, single file per layer (`public/index.html`, `public/style.css`, `public/app.js`). Fonts self-hosted as woff2 under `public/assets/fonts/`, audio samples under `public/assets/audio/`. Web Audio API for all sound (no `new Audio()` per keystroke).

## Layout
The shipping app lives in `public/`, which is the Cloudflare Pages output directory. Everything outside it (`docs/`, `progress/`, `stage/`, `CLAUDE.md`, `PROGRESS.md`, `CHANGELOG.md`) is repo furniture and is deliberately not deployed. A Pages deploy serves its output directory wholesale and offers no per-file exclusion without a build step, so the directory boundary is the only thing keeping working notes off the production domain. Anything new that should not be public goes outside `public/`; anything the app loads at runtime goes inside it.

## Key invariant
The document model is a sparse grid of cells, each holding an ordered list of impressions (glyph, ink color, frozen random seed) - not a string. Overstrike, correction patches, and per-glyph variation all depend on this.

## Pre-push gate
Before any `git push` in this project:
- [ ] Bump `APP_VERSION` (starts at v0.01, +0.01 per release; tens boundaries and v1.00+ need Ben's approval)
- [ ] Add/fold the pending CHANGELOG.md entry under the new version
- [ ] Bump the service worker `CACHE` name if a service worker exists
- [ ] Confirm `docs/realism-prompt.md` still matches actual behavior if the feel changed
