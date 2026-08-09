# PROGRESS - Typewriter

Progressive-disclosure format: each section below is a heading + tags + two-sentence blurb.
Full detail lives in a linked file under `progress/<slug>.md`. Open the link only if the
blurb/tags are relevant to current work - don't read every linked file every session.

## Realism spec (written 2026-08-09, status: not yet implemented)
`spec` `design` `audio` `typography`
The full look/feel/sound acceptance criteria for the typewriter effect: grid-locked monospace, per-glyph ink randomization, mechanical editing model, layered Web Audio keystrokes. Nothing is built yet - this is the brief every implementation session should work against.
→ [docs/realism-prompt.md](docs/realism-prompt.md)

## Next Session
1. Pick and self-host the primary font (TT2020 recommended, Courier Prime as clean alternate) into `assets/fonts/`.
2. Scaffold `index.html` / `style.css` / `app.js` with the sparse-grid impression document model (see CLAUDE.md key invariant) - no audio yet.
3. Get the sheet, platen, bail, and fixed type guide rendering with correct 10 CPI / 6 LPI metrics.
4. Add per-glyph randomization (offset, rotation, ink density, bleed) and verify at 400 percent zoom that repeated letters differ.
5. Only then start audio: source or generate 5-8 samples per event, build the Web Audio buffer pool.

## Backlog
- Correction tape / white-out affordance and x-out mode.
- Ribbon wear drift and ribbon swap.
- Red-ribbon (bichrome) mode.
- "Strict machine" toggle (no `1`, no `!`).
- Export page as PNG / print stylesheet.
- localStorage persistence with schema version.
- Elite (12 CPI) machine option.
