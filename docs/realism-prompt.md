# Typewriter Realism Spec (expanded build prompt)

This is the reference brief for the look, feel, and sound of the app. Any implementation session should treat it as the acceptance criteria for "does this feel like a real typewriter". It is deliberately opinionated: realism here comes from a small number of physical rules applied consistently, not from piling on effects.

## 0. One-line premise

The user types on a keyboard; the screen is not a text editor, it is a sheet of paper in a mid-century mechanical typewriter, seen from the typist's seat. Every character that appears must look like it was struck onto that sheet by a metal typebar through an inked ribbon, and must sound like it.

## 1. The governing constraint: it is a machine, not a document

The single most important realism decision is that the app must behave mechanically, not digitally. The four rules below drive nearly everything else, and breaking any one of them instantly reads as "web page with a typewriter font".

1. **Monospaced, grid-locked characters.** Every glyph occupies one identical cell. No kerning, no ligatures, no proportional spacing, no variable line height. The page is a fixed character grid (recommended 65 characters per line, 54 lines per page for US Letter at 10 CPI / 6 LPI).
2. **The carriage moves, not the text.** When the user types, the paper does not scroll under a fixed cursor in the way a text editor scrolls. The strike point stays where it is on screen and the sheet shifts left one cell per character, or the sheet stays and the carriage assembly slides. Pick one model and keep it. See section 6.
3. **Ink is additive and permanent by default.** Struck ink stays on the sheet. Backspacing moves the carriage back over existing ink; it does not erase it. Retyping over a cell overlays a second impression. Erasing is a separate, modeled affordance (section 7), not `Backspace`.
4. **Nothing is perfect twice.** Every impression varies slightly in ink density, vertical baseline offset, horizontal jitter, and rotation. The same letter typed ten times must produce ten visibly different marks. This is the highest-payoff detail in the entire app.

## 2. Typography

**Face.** Use a genuine typewriter face, self-hosted as woff2, never a generic "monospace" fallback. Ranked candidates, all open-licensed:

- **TT2020** (Fredrick Brennan, OFL) - purpose-built simulation of a 1930s-2020 typewriter face, ships multiple randomized style variants (Style A through G, plus Base) specifically so consecutive identical letters differ. This is the strongest single choice for this project because glyph-level variation is already baked in.
- **Special Elite** (Google Fonts, Apache 2.0) - grimy, heavily distressed, strong "found document" character. Good for a worn-machine mood, too dirty for a clean-office mood.
- **Courier Prime** (Quote-Unquote Apps, OFL) - clean, well-drawn Courier successor with real bold/italic. Best when the mood is crisp office typewriter rather than distressed. Least "effect-y", most legible.
- **Cutive Mono** (OFL) - lighter weight, slab-serif, closer to a well-inked ribbon on smooth paper.

Recommendation: **TT2020 Base as primary with its style variants cycled per-glyph**, Courier Prime as the "clean ribbon" alternate theme. Ship both, let the machine theme select.

**Metrics.** Set the grid explicitly rather than letting the font decide: 10 characters per inch (pica) is the default machine; offer 12 CPI (elite) as a second machine. Line advance is 1/6 inch single-spaced, with 1.5 and double spacing selectable, as a real platen ratchet offers. Do not use fractional line spacing values that are not on the ratchet.

**Case and characters.** Model the machine's real character set. A period-accurate machine has no `1` (type lowercase `l`), no `0` on some models (type capital `O`), no `!` (apostrophe, backspace, period). Ship this as an optional "strict machine" toggle, off by default, because it is delightful but hostile.

## 3. The ink impression

This is where realism is won. Each struck character is a composite of several randomized properties, seeded per-keystroke and then frozen for the life of that character:

- **Vertical offset:** plus or minus 0.5 to 1.5 px. Typebars do not land on a perfect baseline.
- **Horizontal jitter:** plus or minus 0.5 px within the cell, never enough to break grid alignment.
- **Rotation:** plus or minus 0.4 to 0.8 degrees.
- **Ink density:** opacity 0.72 to 1.0, weighted so most strikes are strong and occasional ones are faint. Density should drift slowly with a "ribbon wear" counter so a long session gets progressively lighter until the user swaps the ribbon (section 8).
- **Bleed:** a 0.3 to 0.6 px blur or a very slight text-shadow in the ink color, simulating ink spreading into paper fibre. Heavier on the cotton-paper theme, lighter on the onionskin theme.
- **Edge break-up:** the ribbon does not deposit evenly. Either use TT2020's variant glyphs, or apply a subtle SVG turbulence/displacement filter, or overlay a fine noise mask on the text layer. Prefer the font variants; filters on live text are expensive.

**Ink color is not black.** Use a very dark desaturated blue-black or brown-black, roughly `#241f1c` to `#2b2622`. Pure `#000` reads digital. Offer a red-ribbon mode (the bottom half of a bichrome ribbon, `#8f2b23`) toggled the way the real machine's ribbon selector works.

**Overstrike.** When two characters land in the same cell, both render, both stacked, ink density adds toward opaque. This is the mechanic that makes retyping and struck-through corrections look authentic.

## 4. The paper

- **Color:** aged off-white, `#f4efe4` to `#efe7d6`, never `#fff`. Slight vertical gradient, warmer and marginally darker at the bottom of the visible sheet where it curves away.
- **Texture:** a subtle fibre grain. Implement as a tiled noise PNG at low opacity or an SVG `feTurbulence` layer, not as a heavy photographic scan (which tiles badly and kills the crispness of the ink).
- **Curl:** the sheet emerges from the platen and curves toward the viewer. Render the top of the sheet with a soft shadow and a slight perspective compression so it reads as rolling over the roller.
- **Shadow and lighting:** a single soft key light from the upper left. Sheet casts a diffuse contact shadow onto the platen and machine body. Subtle vignette at the page edges.
- **Margins:** visible, generous, and adjustable by margin stops. Left margin roughly 1 inch, right margin stop triggers the bell (section 5).
- **Page end:** at line 54 the sheet is done. Either auto-feed a new sheet with the roll animation and its sound, or make the user do it. Auto-feed by default, manual as a toggle.

## 5. The machine chrome

The typing surface should sit inside a suggested machine, not float. Minimum viable machine: platen roller at the top edge of the sheet, paper bail bar with two rubber rollers crossing the sheet, and the type guide / strike point at the bottom center of the visible ink line. A full-body illustration is optional; the platen, bail, and strike point are not.

- **Type guide** marks where the next character will land. This is the cursor. It should look like a metal slot, not a blinking text caret. A blinking element is acceptable if it is a thin ink-colored underscore inside the guide.
- **Carriage return lever** on the left, visually present, animates on Enter, clickable as an alternate way to return.
- **Bell:** rings once when the carriage reaches 7 to 8 characters before the right margin. This is a strong realism cue and costs almost nothing.
- **Margin stops** visible on a scale above the platen if a full machine body is drawn.

## 6. Motion

Choose the fixed-strike-point model: the ink line's active character cell stays at a constant screen position, and the paper translates left by exactly one cell width per character. This is what a typist actually sees and it is what makes the app feel like a machine rather than a page.

- **Per-character advance:** 25 to 45 ms, ease-out, with a 1 px overshoot and settle. The overshoot is what sells the mechanical escapement.
- **Carriage return:** the sheet sweeps right, fast (about 180 to 260 ms, ease-out) and then the platen advances one line with a distinct ratchet step. The two motions overlap slightly; they are not sequential.
- **Line advance:** vertical translation of the sheet by exactly one line height, 90 to 140 ms, with a small settle bounce.
- **Key press feedback:** the whole sheet should shudder by a fraction of a pixel on each strike. Very small (0.3 to 0.7 px), very fast (60 ms), randomized direction. Barely perceptible individually; unmistakable when removed.
- **Reduced motion:** honor `prefers-reduced-motion` by removing shudder, overshoot, and sweep, keeping instant positional jumps. Ink variation stays; it is not motion.

## 7. Editing model - the hard part

The user must be able to "go back and retype anything they want" without the app collapsing into a text editor. Model three distinct, real affordances and keep them distinct:

1. **Backspace = carriage back one cell, no erase.** Ink already on the paper remains. The type guide moves left. Typing now overstrikes. This is the honest mechanical behavior and should be the default binding.
2. **Correction tape / white-out** (a click-and-drag or a modifier key, e.g. `Shift+Backspace`): paints an opaque paper-colored patch over the cell, slightly larger than the glyph, with soft irregular edges and a very faintly different paper tone so it stays visible as a correction. Typing over the patch lays fresh ink on top. This is how retyping actually looks on a real page and it looks great.
3. **X-out:** hold a key and type to strike `x` or `/` characters over existing text, the traditional fast correction.

Then, because this is software and usability matters, add an explicit escape hatch:

4. **Undo (`Ctrl+Z`)** removes the last impression outright, with a short rewind sound. Frame it in the UI as an anachronistic convenience, not as a typewriter feature. Do not let it become the primary correction path; the correction tape should be the ergonomic default in the UI.

**Free positioning.** Arrow keys move the type guide anywhere on the sheet, cell by cell, with the corresponding carriage and platen sounds. Clicking a cell moves the guide there (with a carriage travel animation, not a jump). This is what makes "retype anything" work.

**Document model.** Store the page as a sparse grid of cells, each cell holding an ordered list of impressions (glyph, ink color, and the frozen randomization seed). Do not store a string. The grid-of-impressions model is what makes overstrike, correction patches, and per-glyph variation all fall out naturally, and it is worth the extra code. Persist to `localStorage` with a schema version field.

## 8. Sound

Soft, warm, and never fatiguing. The user will type thousands of keystrokes; anything harsh or repetitive becomes intolerable in two minutes. Rules:

- **Variation is mandatory.** Minimum 5 to 8 samples per event, chosen randomly, never the same sample twice in a row. Additionally randomize playback rate by plus or minus 4 percent and gain by plus or minus 2 dB.
- **Layers per keystroke:** a soft key-down click, the typebar hitting the platen (the body of the sound), and a faint mechanical return. Distinguish key classes: space bar is deeper and duller, letter keys are sharper.
- **Event set:** keystroke, space, backspace/carriage step, bell, carriage return sweep, platen line advance ratchet, paper feed/roll, correction tape squeak, ribbon advance tick (very quiet, every keystroke).
- **Mixing:** default master level low. Roll off above about 6 kHz so it reads as a machine in a room rather than a click track. Add a short, small room reverb (0.3 to 0.6 s, low wet mix). A subtle low-level room tone bed under the whole session is a strong immersion cue and is optional/toggleable.
- **Engine:** Web Audio API with a preloaded, decoded buffer pool. Never `new Audio()` per keystroke. Must handle fast typists (12+ keys/sec) without stutter or voice buildup; cap concurrent voices and steal oldest.
- **Autoplay:** audio context starts suspended, resumes on first user gesture. The first keystroke must not be silent, so resume on `keydown` before scheduling that keystroke's sample.
- **Off switch** that is obvious and instantly effective, and remembered.

## 9. Performance budget

- Sustained 60 fps while typing at 12 characters per second on a mid-range laptop.
- Keystroke to visible ink latency under 30 ms; that is the difference between "responsive machine" and "laggy web app", and it is the second thing after per-glyph variation that people feel without being able to name.
- Do not re-render the whole grid per keystroke. Append the new impression only. Only the sheet transform changes.
- Randomization filters must be precomputed or expressed as cheap CSS transforms, not live SVG filters on the whole text layer.
- Full page of 54 lines by 65 characters with overstrikes must stay smooth.

## 10. What to avoid

- Blinking block or I-beam text caret.
- Any proportional font anywhere on the sheet.
- Pure black ink, pure white paper.
- A photographic paper texture at high opacity - it fights the ink and tiles visibly.
- Identical glyph rendering for repeated letters.
- Loud, bright, or identical keystroke samples.
- A typing "animation" that reveals pre-written text. The user types; the app never types for them, except optionally in a one-time demo.
- Text-editor conveniences leaking in visually: no selection highlight in the browser default blue, no autocorrect, no spellcheck underlines, no scrollbars on the sheet.

## 11. Acceptance test

The build is right when: screenshot a paragraph, zoom to 400 percent, and no two instances of the same letter are identical; type with eyes closed and the sound alone tells you when you hit the margin bell and when you returned the carriage; backspace and retype a word and the result looks like a real corrected page rather than a clean edit; and typing for ten minutes straight is pleasant rather than annoying.
