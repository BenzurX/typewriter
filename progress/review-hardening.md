# Review hardening pass

Full record of the pre-deploy review of 2026-08-28 and the changes that came out of it.

## How the review ran

Two parallel review passes over the whole app. The `app.js` pass went to `codex-agent`, which delegated to Codex (gpt-5.1-codex) and then reconciled Codex's findings against its own read before reporting. The HTML/CSS/deploy pass was assigned to `codex-agent` as well, but that agent judged a review-only task with no diff to return as outside the Codex contract and did the inspection directly instead, so that half of the review is Claude-only and did not get a second opinion. Worth knowing if that half needs to be trusted later.

Findings were verified against source in the main thread before any were acted on. Four of the reviewers' findings were rejected on verification (see "Rejected findings" below), and one of their factual claims was wrong: the HTML/CSS pass reported that no `APP_VERSION` constant existed, when it is defined at `app.js:954` and rendered into `#version-plate`.

## Correctness fixes

**Audio resume race.** `unlock()` called `ctx.resume()` without holding the returned promise, and `play()` early-returned whenever `ctx.state !== 'running'`. Because the same keydown both unlocks and strikes, the first keystroke of a session lost its sound. Direct violation of realism-prompt section 10. Now `unlock()` sets a `resuming` flag and flushes on the promise; `play()` queues into a capped six-entry buffer while resuming and `playNow()` does the actual synthesis. The cap exists so a key held down through a slow resume cannot stack a burst that all fires at once. `flushPending()` re-checks `enabled` / `ready` / state, since sound can be switched off inside the resume window.

**Double line-advance on every carriage return.** `synthReturn()` (`app.js:642`) and `synthProfileReturn()` (`app.js:665`) both end in `lineAdvanceInto()`, so the ratchet is already part of the return. `carriageReturn()` was separately scheduling `Sound.play('lineAdvance')` at +90ms. Removed the separate call.

**Carriage-return undo.** `history.push({ type: 'return' })` stored no position, so the undo branch always fell through to `carriage.row - 1` and hardcoded `COLS - 1` - undo landed at the end of the previous row no matter where the carriage had actually been. It also never restored `page.softBreaks[previousRow]`, which `carriageReturn()` deletes for a manual return, so copy and export kept reflowing the paragraph as though the line had wrapped. The history entry now carries `row`, `col`, and `soft`, and undo restores all three.

**Patch identity.** Undo removed correction patches with `patchLayer.querySelector('.correction-patch[style*="--col: N"]')`, matching on column alone with no row, so two patches in different rows sharing a column meant undo could delete the wrong node. Cells now hold a direct `patchEl` reference, set in `whiteOut()` and `renderAll()` and cleared on undo. `renderPatchesIfStale()` is kept as a count-based safety net.

**Word-wrap patch collision.** `moveCell()` overwrote `patchRow` / `patchCol` / `patchSeed` on a destination that already carried its own patch, silently replacing that patch's identity. It now drops the arriving patch instead, since the destination cell is covered either way.

## Performance fixes

All three of these were per-keystroke costs, measured against the spec's sub-30ms strike budget (realism-prompt section 11).

**Forced layout in `updateSheet()`.** It wrote `--sheet-x` / `--sheet-y` and then immediately read `getBoundingClientRect()` on `#platen-assembly` and `#sheet-viewport`, forcing a synchronous layout on every carriage move. Both widths are now cached into `metrics.assemblyW` / `metrics.vpW` during `measure()`, and the element lookups are hoisted to module scope. `updateSheet()` is write-only. `relayout()` refreshes the cache, and it already runs on resize and on `document.fonts.ready`.

**Full grid rebuild on word wrap.** `wrapTrailingWord()` called `renderAll()` every time a trailing word wrapped, directly against the spec's no-full-rerender rule. `moveCell()` already repositions impression nodes, and now repositions patch nodes too, so nothing is left to rebuild; the call is replaced with `renderPatchesIfStale()`.

**Shudder reflow.** `shudder()` used `void sheet.offsetWidth` to restart the CSS animation, forcing a reflow on every single strike. Removing and re-adding one class in the same frame does not restart an animation, which is why the read was there. Replaced with two class names, `.is-struck` and `.is-struck-b`, carrying two identically-shaped keyframe blocks under different animation-names - swapping between them is a genuine restart with no layout read. Both are covered in the reduced-motion block.

**History remap.** `remapHistoryCell()` scanned the whole history once per moved cell, making a wrap O(word length x history length). Replaced with `remapHistoryCells(map)`, a single pass keyed on `cellKey`, with `moveCell()` collecting into the map.

**Resize.** Coalesced to one `relayout()` per animation frame.

## Persistence fixes

- Autosave only ran after `strike()`. White-out, undo, carriage return, and navigation relied entirely on `beforeunload`, which does not fire when a mobile browser backgrounds or discards a tab. `scheduleAutosave()` now lives in the mutating functions themselves (`strike`, `whiteOut`, `undo`, `carriageReturn`, `carriageBack`, `moveTo`), and `visibilitychange` (hidden) and `pagehide` both force a save.
- The Save rail key ran `if (savePage(true)) { exportDocument(...) }`, so a full `localStorage` blocked the download at exactly the moment getting the page out of the browser matters most. Export now runs first, unconditionally, and the save follows.
- `loadPage()` checked only `data.v !== 1` and then trusted every record. Each cell key, impression tuple, patch tuple, and the carriage position are now validated individually; a bad record costs that cell rather than the page. Soft-break entries are checked for finite non-negative numbers.
- `serialize()` skipped nothing, so cells left with no impressions and no patch after an undo persisted forever. They are now dropped at save time.
- `savePrefs()` swallowed quota failures silently, leaving settings looking applied but gone after reload. It now reports through `say()`.

## Feature gaps closed

**Touch input.** The app had full responsive CSS down to 520px but was literally unusable on a phone: input was exclusively `document.addEventListener('keydown')` with no focusable editable element anywhere, so no software keyboard could be raised. Added `#key-catcher`, an off-screen 1x1 `<input>` (opacity 0, `z-index: -1`, `font-size: 16px` so iOS does not zoom on focus - it must stay focusable, so no `display: none` or `visibility: hidden`). `pointerdown` on `#sheet-viewport` focuses it inside the gesture, which is the only way mobile browsers will raise the keyboard.

Routing: the document keydown handler now exempts `#key-catcher` from its form-field guard, so physical keyboards behave exactly as before. For soft keyboards, which often report `keydown` as `Unidentified`, an `input` handler replays `keyCatcher.value` through `strike()` and clears the field. There is no double-strike, because a physical keystroke hits `preventDefault()` in the keydown handler, which stops the insertion and therefore the input event. `beforeinput` maps `deleteContentBackward` and `insertParagraph` onto the existing bindings.

Known limitation: touch backspace maps only to the current mode's unshifted binding, since a soft keyboard delivers a deletion intent rather than a modified key. Recorded in the spec.

**X-out.** realism-prompt section 7 asks for "hold a modifier and type to strike `x` or `/` over existing text" and it was simply absent - the keydown handler returned early on every modified key except Ctrl/Cmd+Z. Implemented as `Alt` plus `x` or `/`. Alt rather than Ctrl because Ctrl+X is Cut. The spec has been updated to name the modifier.

**IME.** Keydown events arriving mid-composition (`e.isComposing`, or `keyCode === 229`) are now left to the IME rather than being treated as strikes. This is a guard against garbage, not full IME support - committed multi-byte text arrives through the key catcher's input event. Whether this machine should accept non-Latin input at all is still an open product question.

## Deploy readiness

- Created `CHANGELOG.md` with the pending v0.01 entry. `APP_VERSION` stays at `0.01` - per the global rule it is only advanced at the pre-push gate, not mid-session.
- Added `theme-color`, a `<link rel="icon">` pointing at `assets/favicon.png`, and a preload hint for `tt2020.woff2` only (the other three faces are opt-in from the settings card and can wait for the stylesheet to request them).
- Favicon is Ben's, a 32x32 PNG exported from Figma. It arrived named `favicon.svg` while containing PNG bytes, which would have failed against the `image/svg+xml` type the link tag originally declared; renamed to `assets/favicon.png` and the tag now declares `image/png` with `sizes="32x32"`.
- Added a print stylesheet as section 14: hides the machine, controls and rail, un-crops `#sheet-viewport`, and drops the carriage transform so the sheet flows and page-breaks normally.
- Verified clean: all four `@font-face` files exist with lowercase-consistent paths (Cloudflare's filesystem is case-sensitive where Windows is not), `assets/vector/coffee-stain1.svg` resolves, no absolute or `file://` or localhost paths anywhere, no service worker exists so that pre-push gate line is a no-op.

## Rejected findings

Four review findings were rejected on verification rather than acted on.

- **White-out not persisting covered impressions** was called a blocker and an invariant violation. It is neither: realism-prompt section 7 describes white-out as an opaque patch over the ink, not as a correction that must survive a reload as undo history. Design choice.
- **Synthesised audio instead of a sample pool** was flagged against the spec. The header comment at `app.js:1-22` already documents this as a deliberate substitution with a stated migration path.
- **Realism Mode absent from the button rail** was flagged. Spec section 8 lists four v1 rail keys and describes the Realism Mode key as optional ("if surfaced on the rail"); the requirement is only that the mode be readable at a glance, which the latched Settings key satisfies.
- **IME composition unsupported** was called a blocker. Downgraded: this is a Latin mechanical typewriter simulator and the exclusion is defensible, but it was nowhere stated, so a guard was added and the product question left open.

## Open decision

`stage/` and `tests/` are untracked, unreferenced by the shipping app, and would be served publicly by Cloudflare Pages if committed with the repo root as the output directory. There is no per-file exclusion for Pages without a build step. The two real options are to accept it (they are harmless dev harnesses, no secrets) or to move the app into a `public/` output directory. Left for Ben - deliberately not resolved, since gitignoring them would mean losing the regression tests from version control.

## Verification status

Not run end-to-end. `node --check app.js` passes. The regression harnesses under `tests/` are browser pages, and browser automation is disabled for this project, so the audio resume path, touch input, and word-wrap DOM repositioning have been reasoned through and read carefully but not executed. Those three are the highest-risk changes in this pass and should be exercised by hand before the deploy is considered done.
