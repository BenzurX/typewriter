# Changelog

All notable changes to this project are recorded here. Versions start at v0.01 and increment by 0.01 per release.

## v0.01 - 2026-08-28

First release. A browser typewriter: monospaced grid, per-glyph ink variation, layered synthesised key sounds, carriage motion, and mechanically-modeled correction where backspace does not erase.

### Added

- Sparse grid document model: cells hold an ordered list of impressions (glyph, ink colour, frozen random seed), so overstrike, correction patches, and per-glyph variation all fall out of the same structure.
- Realism Mode, toggled and persisted from the settings card, flipping the `Backspace` / `Shift+Backspace` bindings between white-out and carriage-back.
- Button rail: Settings, Save, Copy All, Erase, with the settings card and the ruled-notecard erase confirmation.
- Five synthesised sound profiles over the Web Audio API, with a shared reverb bus, master compression, and no per-keystroke `Audio` objects.
- Four self-hosted typefaces (TT2020, Courier Prime, Special Elite, Cutive Mono), selectable from the settings card.
- Endless paper with automatic row growth, word wrapping in friendly mode, hard wrapping in Realism Mode, and soft-break tracking so copy and export reflow paragraphs correctly.
- Export to Markdown, plain text, HTML, or RTF, plus copy-to-clipboard.
- X-out correction: `Alt` plus `x` or `/` strikes that character over existing text without a preceding backspace.
- Touch support: tapping the sheet raises the software keyboard and typing is routed through the same strike path as a physical keyboard.
- Print stylesheet that drops the machine and controls and prints the sheet alone.
- Larger type on upright phones. The narrow-screen scale had shrunk glyphs to about 14px chasing column count that a phone cannot show at any readable size; upright phones now get about 21px and let the line crop horizontally instead.
- Favicon, `theme-color`, and a preload hint for the default typeface.

### Fixed

- First keystroke after page load could be silent: `AudioContext.resume()` was not awaited, so the strike that triggered the unlock was dropped. Sounds asked for during the resume window are now queued and flushed.
- Every carriage return played two line-advance ratchets, because the return synthesis already ends in one and a second was scheduled separately.
- Undoing a carriage return jumped to the end of the previous row regardless of where the carriage actually was, and did not restore the soft-break flag the return had overwritten.
- Undoing a white-out could remove the wrong correction patch when two patches in different rows shared a column, because the patch was looked up by a CSS-string match on the column alone.
- Word wrapping onto a cell that already carried a patch silently replaced that patch's identity.
- Autosave only ran after a strike, so white-out, undo, carriage returns, and navigation survived only a clean unload. Saving now also happens on `visibilitychange` and `pagehide`, which is what mobile browsers actually fire.
- The Save rail key would not export when `localStorage` was full, the moment getting the page out of the browser matters most.
- Corrupt or hand-edited saved pages are now validated record by record instead of being trusted wholesale.

### Deploy

- Hosted as a Cloudflare Worker serving `public/` as static assets at https://typewriter.benzur.workers.dev, with the repo on GitHub at `BenzurX/typewriter`. Matches the pattern the other side projects use.
- The shipping app moved into `public/`. A deploy publishes that directory and nothing above it, which is what keeps `docs/`, `progress/`, `stage/` and the working markdown off the public URL.
- Unmatched paths serve a 404 page rather than falling back to the app with a 200.

### Changed

- `updateSheet()` no longer reads layout: the platen and viewport widths are cached during `measure()`, removing a forced synchronous layout from every keystroke.
- The per-strike sheet shudder restarts by alternating two identically-shaped animations instead of forcing a reflow with an `offsetWidth` read.
- Word wrapping repositions only the nodes it moves rather than rebuilding the whole grid, and remaps undo history in a single pass instead of one pass per moved cell.
- Empty cells left behind by an undone patch are no longer persisted.
- Failing to save settings now reports it rather than failing silently.
- `resize` is coalesced to one relayout per animation frame.
- Arrow-key navigation treats a whited-out cell as part of the line rather than as empty.
- Keystrokes arriving mid-IME-composition are left to the IME.
