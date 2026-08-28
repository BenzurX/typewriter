# PROGRESS - Typewriter

Progressive-disclosure format: each section below is a heading + tags + two-sentence blurb.
Full detail lives in a linked file under `progress/<slug>.md`. Open the link only if the
blurb/tags are relevant to current work - don't read every linked file every session.

## Realism spec (written 2026-08-09, revised 2026-08-28, status: implemented)
`spec` `design` `audio` `typography` `ui`
The full look/feel/sound acceptance criteria: grid-locked monospace, per-glyph ink randomization, Realism Mode (off by default, flips Backspace/Shift+Backspace), off-screen typebar button rail, slide-in notecard settings. Now describes shipped behavior rather than a brief - revised 2026-08-28 to name Alt as the X-out modifier and to add the touch-input section.
→ [docs/realism-prompt.md](docs/realism-prompt.md)

## App build (built 2026-08-09 to 2026-08-28, status: shipped, not yet deployed)
`ui` `audio` `document-model` `persistence`
The working app: sparse-grid impression model, five synthesised sound profiles, four self-hosted typefaces, endless paper with word wrap and soft-break tracking, export to md/txt/html/rtf, localStorage persistence. Sound is synthesised rather than sample-based - a deliberate substitution documented at `app.js:1-22` with a migration path, not an oversight.
→ [docs/realism-prompt.md](docs/realism-prompt.md)

## Review hardening pass (done 2026-08-28, status: applied, not verified end-to-end)
`review` `bugfix` `performance` `mobile` `deploy`
Pre-deploy review of the whole app via Codex plus a Claude pass, then all accepted findings applied: first-keystroke-silent audio race, double return ratchet, carriage-return undo landing in the wrong cell, per-keystroke forced layout, and no touch input at all. Nothing has been exercised in a browser - the audio resume path, touch input, and word-wrap DOM repositioning are the three riskiest changes and need hand-testing before deploy.
→ [progress/review-hardening.md](progress/review-hardening.md)

## Next Session
1. Hand-test in a browser before anything else: first keystroke after a cold load makes a sound; a carriage return plays one ratchet not two; Ctrl+Z after Enter returns to where the carriage actually was; word wrap in friendly mode does not visibly rebuild the page.
2. Hand-test on a phone: tapping the sheet raises the keyboard, typing lands on the paper, backspace white-outs (friendly mode) or steps back (Realism Mode).
3. Decide the `stage/` and `tests/` question: accept that Cloudflare Pages will serve them publicly, or move the app into a `public/` output directory. Do not gitignore them, that loses the regression tests.
4. Create the GitHub remote (none is configured yet) and push, then connect Cloudflare Pages. The pre-push gate is already done for v0.01: `APP_VERSION` (`app.js:992`) stays at 0.01 because this is the first release and 0.01 is the starting version, the CHANGELOG entry is dated, no service worker exists so there is no `CACHE` to bump, and the spec has been reconciled with actual behavior.
5. Next release after this one bumps `APP_VERSION` to 0.02 and opens a fresh CHANGELOG entry. v0.09 to v0.10 and v1.00 need Ben's explicit approval.

## Backlog
- Red-ribbon (bichrome) mode. The `ink` field already exists on every impression and serializes; nothing reads `'red'` yet except the renderer.
- "Strict machine" toggle (no `1`, no `!`).
- Elite (12 CPI) machine option.
- Export page as PNG.
- Sample-based audio engine to replace the synthesis, per the migration note at `app.js:1-22`.
- Decide whether non-Latin input is in scope. There is now an IME guard but no IME support.
- Refactor the mobile rail-key `!important` block (`style.css` section 13) to reassign custom properties instead, so the base and mobile rules stop needing to be edited in lockstep.
