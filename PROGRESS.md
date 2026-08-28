# PROGRESS - Typewriter

Progressive-disclosure format: each section below is a heading + tags + two-sentence blurb.
Full detail lives in a linked file under `progress/<slug>.md`. Open the link only if the
blurb/tags are relevant to current work - don't read every linked file every session.

## Realism spec (written 2026-08-09, revised 2026-08-28, status: implemented)
`spec` `design` `audio` `typography` `ui`
The full look/feel/sound acceptance criteria: grid-locked monospace, per-glyph ink randomization, Realism Mode (off by default, flips Backspace/Shift+Backspace), off-screen typebar button rail, slide-in notecard settings. Now describes shipped behavior rather than a brief - revised 2026-08-28 to name Alt as the X-out modifier and to add the touch-input section.
→ [docs/realism-prompt.md](docs/realism-prompt.md)

## App build (built 2026-08-09 to 2026-08-28, status: deployed as v0.01)
`ui` `audio` `document-model` `persistence`
The working app: sparse-grid impression model, five synthesised sound profiles, four self-hosted typefaces, endless paper with word wrap and soft-break tracking, export to md/txt/html/rtf, localStorage persistence. Sound is synthesised rather than sample-based - a deliberate substitution documented at `public/app.js:1-22` with a migration path, not an oversight.
→ [docs/realism-prompt.md](docs/realism-prompt.md)

## Review hardening pass (done 2026-08-28, status: applied, not verified end-to-end)
`review` `bugfix` `performance` `mobile` `deploy`
Pre-deploy review of the whole app via Codex plus a Claude pass, then all accepted findings applied: first-keystroke-silent audio race, double return ratchet, carriage-return undo landing in the wrong cell, per-keystroke forced layout, and no touch input at all. Nothing has been exercised in a browser - the audio resume path, touch input, and word-wrap DOM repositioning are the three riskiest changes and need hand-testing before deploy.
→ [progress/review-hardening.md](progress/review-hardening.md)

## Deploy (set up 2026-08-28, status: live)
`deploy` `cloudflare` `github`
A Cloudflare Worker serving `public/` as static assets at https://typewriter.benzur.workers.dev, repo at https://github.com/BenzurX/typewriter on `main`, matching the pattern used by the other side projects. Workers Builds is NOT connected, so `git push` and `npx wrangler deploy` are separate acts - a push alone does not update the live site. An earlier Cloudflare Pages attempt was deleted on 2026-08-28; the Worker is the only deployment.
→ [progress/review-hardening.md](progress/review-hardening.md)

## Next Session
1. Hand-test the live site in a browser: first keystroke after a cold load makes a sound; a carriage return plays one ratchet not two; Ctrl+Z after Enter returns to where the carriage actually was; word wrap in friendly mode does not visibly rebuild the page. None of this has ever been executed, only reviewed.
2. Hand-test on a phone: tapping the sheet raises the keyboard, typing lands on the paper, backspace white-outs (friendly mode) or steps back (Realism Mode), and the type reads at a comfortable size. If the type is wrong, `public/style.css` has the single `--scale` value for upright phones in its last media block.
3. Optional: connect Workers Builds to the GitHub repo in the Cloudflare dashboard so a push deploys automatically. Needs Ben's OAuth step, not doable from the CLI. Until then every deploy is a manual `npx wrangler deploy`.
4. Next release bumps `APP_VERSION` (`public/app.js:992`) to 0.02 and opens a fresh CHANGELOG entry. v0.09 to v0.10 and v1.00 need Ben's explicit approval.

## Backlog
- Red-ribbon (bichrome) mode. The `ink` field already exists on every impression and serializes; nothing reads `'red'` yet except the renderer.
- "Strict machine" toggle (no `1`, no `!`).
- Elite (12 CPI) machine option.
- Export page as PNG.
- Sample-based audio engine to replace the synthesis, per the migration note at `public/app.js:1-22`.
- Decide whether non-Latin input is in scope. There is now an IME guard but no IME support.
- Refactor the mobile rail-key `!important` block (`public/style.css` section 13) to reassign custom properties instead, so the base and mobile rules stop needing to be edited in lockstep.
