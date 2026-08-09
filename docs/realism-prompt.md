# Typewriter Realism Spec (expanded build prompt)

This is the reference brief for the look, feel, and sound of the app. Any implementation session should treat it as the acceptance criteria for "does this feel like a real typewriter". It is deliberately opinionated: realism here comes from a small number of physical rules applied consistently, not from piling on effects.

## 0. One-line premise

The user types on a keyboard; the screen is not a text editor, it is a sheet of paper in a mid-century mechanical typewriter, seen from the typist's seat. Every character that appears must look like it was struck onto that sheet by a metal typebar through an inked ribbon, and must sound like it.

## 1. The governing constraint: it is a machine, not a document

The single most important realism decision is that the app must behave mechanically, not digitally. The four rules below drive nearly everything else, and breaking any one of them instantly reads as "web page with a typewriter font".

1. **Monospaced, grid-locked characters.** Every glyph occupies one identical cell. No kerning, no ligatures, no proportional spacing, no variable line height. The page is a fixed character grid (recommended 65 characters per line, 54 lines per page for US Letter at 10 CPI / 6 LPI).
2. **The carriage moves, not the text.** When the user types, the paper does not scroll under a fixed cursor in the way a text editor scrolls. The strike point stays where it is on screen and the sheet shifts left one cell per character, or the sheet stays and the carriage assembly slides. Pick one model and keep it. See section 6.
3. **Ink is additive and permanent - under Realism Mode.** Struck ink stays on the sheet and correction is a separate modeled affordance, not `Backspace`. This is the honest mechanical behavior, but it is hostile to a first-time user, so it lives behind a **Realism Mode** toggle that is **off by default**. Rules 1, 2, and 4 always apply; only rule 3 is switchable. See section 7 for the two modes.
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
- **Ink density:** opacity 0.72 to 1.0, weighted so most strikes are strong and occasional ones are faint. With Realism Mode off, this range is stable for the whole session. With Realism Mode on, it drifts under the ribbon wear model below.
- **Bleed:** a 0.3 to 0.6 px blur or a very slight text-shadow in the ink color, simulating ink spreading into paper fibre. Heavier on the cotton-paper theme, lighter on the onionskin theme.
- **Edge break-up:** the ribbon does not deposit evenly. Either use TT2020's variant glyphs, or apply a subtle SVG turbulence/displacement filter, or overlay a fine noise mask on the text layer. Prefer the font variants; filters on live text are expensive.

**Ink color is not black, and it leans blue.** Use a very dark blue-black, roughly `#1c1f2a` to `#232838`, with a faint cool cast that is visible when a strike lands light. Not brown-black - brown reads as an aged carbon ribbon, blue-black reads as a well-inked machine and holds contrast better against the warm paper. Pure `#000` reads digital. Faint strikes should desaturate toward `#3a4055` rather than toward grey. Offer a red-ribbon mode (the bottom half of a bichrome ribbon, `#8f2b23`) toggled the way the real machine's ribbon selector works.

**Ribbon wear (Realism Mode only).** A real ribbon gives up its ink as it runs. Model it as a wear counter that increments per strike and drags the whole ink-density range down as it climbs: full ink for roughly the first 800 to 1000 strikes, then a slow, non-linear fade so that by 3000 strikes impressions sit around 0.45 to 0.7 opacity, visibly grey-blue and patchy, with faint strikes becoming more frequent than strong ones. The fade must be slow enough that the user notices it as a mood shift, not as the app breaking - never let it drop below legibility. Bleed increases slightly as density drops (a dry ribbon smears more than it prints).

Wear is per-ribbon, persisted alongside the page, and does **not** reset when a new sheet is fed - only a ribbon swap resets it. Surface the swap as a small **NEW RIBBON** control that appears on the settings card only when Realism Mode is on and wear is past roughly half; using it plays the ribbon-spool sound and returns density to full. Toggling Realism Mode off restores full density immediately without resetting the counter; toggling it back on resumes at the wear level where it left off. Impressions already on the page keep their frozen density and are never retroactively faded or restored.

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

The user must be able to "go back and retype anything they want" without the app collapsing into a text editor. There are two modes, and the key binding for correction **flips between them**. This is the only behavioral difference between the modes.

### Default mode (Realism Mode OFF)

The forgiving mode. This is what a first-time visitor gets.

- **`Backspace` = white-out.** Steps the carriage back one cell and lays a correction patch over whatever was there, clearing it visually. Feels like a normal delete key, looks like correction tape rather than a digital erase.
- **`Shift+Backspace` = carriage back only.** Moves the type guide left one cell without touching the ink, for deliberate overstriking.

### Realism Mode ON

The honest machine. Toggled in the settings card (section 9), persisted, off by default.

- **`Backspace` = carriage back only, no erase.** Ink already on the paper stays. The type guide moves left. Typing now overstrikes.
- **`Shift+Backspace` = white-out.** Paints the correction patch.

### Shared affordances (both modes)

- **Correction patch rendering:** an opaque paper-colored patch over the cell, slightly larger than the glyph, with soft irregular edges and a very faintly different paper tone so it stays visible as a correction rather than a clean erase. Typing over the patch lays fresh ink on top. Play the correction tape squeak on every patch, in both modes - the sound is what tells the user which thing just happened.
- **X-out:** hold a modifier and type to strike `x` or `/` characters over existing text, the traditional fast correction.
- **Undo (`Ctrl+Z`)** removes the last impression outright, with a short rewind sound. Available in both modes; frame it as an anachronistic convenience, not a typewriter feature. In Realism Mode it stays available but is not surfaced in the UI.

Because the binding flips, the app must always be able to answer "which mode am I in" without opening settings: the Realism Mode key on the button rail (section 8) sits visibly depressed/latched down when active, the way a shift-lock key does.

**Free positioning.** Arrow keys move the type guide anywhere on the sheet, cell by cell, with the corresponding carriage and platen sounds. Clicking a cell moves the guide there (with a carriage travel animation, not a jump). This is what makes "retype anything" work.

**Document model.** Store the page as a sparse grid of cells, each cell holding an ordered list of impressions (glyph, ink color, and the frozen randomization seed). Do not store a string. The grid-of-impressions model is what makes overstrike, correction patches, and per-glyph variation all fall out naturally, and it is worth the extra code. Persist to `localStorage` with a schema version field.

## 8. UI - the button rail

There is no conventional web UI in this app. Every control is a **typewriter key on an arm that reaches in from off the edge of the screen**, as though the machine is larger than the viewport and these keys belong to the part of it you cannot see. Nothing renders as an HTML button, icon, hamburger, or floating action pill.

**Anatomy of a key.** Three parts, drawn back-to-front:

1. **The arm** - a slim metal typebar/linkage that enters from off-canvas and runs to the key. Brushed steel or blackened nickel, a soft specular highlight along the top edge matching the section 4 key light from upper left. The arm is clipped by the viewport edge; it must never appear to start at a visible endpoint. It casts a soft shadow onto the surface behind it.
2. **The key ring** - a thin chrome or nickel bezel around the cap, slightly elliptical because the key is seen at an angle, not head-on.
3. **The cap** - a round, slightly dished bakelite key in aged cream, black, or oxblood, with the label set in the same typewriter face as the page, small caps, ink-colored, very slightly worn at the center where a thumb would land.

**Placement.** Keys enter from the left and right edges, vertically staggered so no two arms are parallel and no arm crosses another. They sit outside the paper's shadow so they never compete with the sheet for attention. On narrow viewports they fold to the bottom edge, arms reaching up.

**The four keys (v1):**

- **SETTINGS** - opens the settings card (section 9).
- **SAVE** - persists the page. Confirms with a small mechanical thunk and a brief inked stamp or check mark on the key cap that fades, not a toast notification.
- **COPY ALL** - copies the page's plain text to the clipboard. Same non-toast confirmation pattern.
- **ERASE** - clears the sheet. **Requires confirmation** (see below).

**Interaction.** Hover: the arm slides in 2 to 4 px and the cap brightens slightly. Press: the cap travels down along the arm's axis (not straight down the screen) by 3 to 5 px over about 70 ms, the arm flexes very slightly, and a key-press sample plays - a heavier, duller sample than a letter key, because these are function keys, not typebars. Release springs back with a small overshoot. Latching keys (Realism Mode, if surfaced on the rail) stay down.

**ERASE confirmation.** Never a browser `confirm()` and never a generic modal. Erase slides in a small carbon-paper slip, tinted grey-purple and semi-transparent the way a real carbon copy is, reading something like "ERASE THIS PAGE? THIS CANNOT BE UNDONE." with two small key-style controls, **YES** and **NO**, styled identically to the rail keys. NO is the default focus. Confirming plays the paper-feed/roll sound as the sheet ejects, then a fresh sheet rolls in.

**Accessibility.** These are real, focusable `<button>` elements underneath the art. Keyboard focus draws a visible ink-colored ring on the key ring itself. Each has an accessible label. Tab order runs the rail after the sheet, so a typist never tabs out of the page by accident.

## 9. The settings card

Settings are a physical object handed onto the desk, not a panel.

**Object.** A small typewriter-era index/notecard: ruled buff-cream stock, a red header rule near the top, faint blue horizontal rules below it, slightly rounded corners, one soft dog-eared corner and a small coffee-ring or thumb smudge for wear. Roughly 3 by 5 inch proportions. Card stock is visibly a different, heavier, cooler paper than the sheet in the machine.

**Entrance.** The card slides in from the upper right at a slight angle (about 3 to 6 degrees off square), overshoots by a few pixels, and settles - as though tossed onto the desk. 260 to 340 ms, ease-out. It casts a distinct drop shadow onto the sheet below and dims the sheet very slightly (no heavy modal scrim; a real card does not darken the desk). Exit reverses, slightly faster, sliding off up and right.

**Sound.** A paper shuffle/crinkle on entrance - the card being grabbed off a stack and dropped down. Short, dry, close-mic'd, no reverb tail. Exit uses a lighter version of the same sample (or the same sample at a slightly higher rate and lower gain), so entrance and exit feel like the same sheet of card. Respect the Sound toggle absolutely: if Sound is off, the card is silent.

**Contents.** Handwritten-label feel for headings (a period-appropriate script or the typewriter face in small caps), controls drawn as physical objects, never as OS form widgets:

- **REALISM MODE** - a latching toggle drawn as a small metal lever or a stamped checkbox. Off by default. Beneath it, two lines of small print explaining the consequences: "Backspace moves the carriage without erasing. Use Shift+Backspace to white out." and "The ribbon wears out as you type." When toggled, the corresponding rail key latch state updates immediately.
- **NEW RIBBON** - a small key-style control, shown only when Realism Mode is on and ribbon wear is past about half. Displays wear as a physical cue (a spool that empties, or a short worn/fresh bar in ink), not a percentage readout. Pressing it plays the ribbon-spool sound and resets density to full.
- **TYPEFACE** - a dropdown, but drawn as a small typebar selector or a card-stock select with an ink-drawn chevron. Lists the fonts from section 2 (TT2020, Courier Prime, Special Elite, Cutive Mono) with each option previewed in its own face. Switching re-renders existing impressions in the new face while preserving each impression's frozen random seed, so the page keeps its character.
- **SOUND** - an on/off toggle plus a volume slider. The slider is a small brass thumbwheel or a lever in a slotted track, not an `<input type=range>` in its default skin. Moving it plays a single quiet keystroke sample at the new level so the user can hear what they are setting. Off silences everything including the card's own shuffle.

All settings persist to `localStorage` and apply immediately - no OK/Apply button. Closing is a small **X** stamped in the card's corner, `Esc`, or clicking off the card.

**Accessibility.** Real form controls underneath the art, correctly labeled and keyboard-operable. Focus is trapped in the card while open and returns to the SETTINGS key on close.

## 10. Sound

Soft, warm, and never fatiguing. The user will type thousands of keystrokes; anything harsh or repetitive becomes intolerable in two minutes. Rules:

- **Variation is mandatory.** Minimum 5 to 8 samples per event, chosen randomly, never the same sample twice in a row. Additionally randomize playback rate by plus or minus 4 percent and gain by plus or minus 2 dB.
- **Layers per keystroke:** a soft key-down click, the typebar hitting the platen (the body of the sound), and a faint mechanical return. Distinguish key classes: space bar is deeper and duller, letter keys are sharper.
- **Event set:** keystroke, space, backspace/carriage step, bell, carriage return sweep, platen line advance ratchet, paper feed/roll, correction tape squeak, ribbon advance tick (very quiet, every keystroke), ribbon spool swap, rail key press (heavier and duller than a letter key), settings card shuffle/crinkle.
- **Mixing:** default master level low. Roll off above about 6 kHz so it reads as a machine in a room rather than a click track. Add a short, small room reverb (0.3 to 0.6 s, low wet mix). A subtle low-level room tone bed under the whole session is a strong immersion cue and is optional/toggleable.
- **Engine:** Web Audio API with a preloaded, decoded buffer pool. Never `new Audio()` per keystroke. Must handle fast typists (12+ keys/sec) without stutter or voice buildup; cap concurrent voices and steal oldest.
- **Autoplay:** audio context starts suspended, resumes on first user gesture. The first keystroke must not be silent, so resume on `keydown` before scheduling that keystroke's sample.
- **Off switch** that is obvious and instantly effective, and remembered. It lives on the settings card (section 9) and silences everything, including the card's own entrance sound.

## 11. Performance budget

- Sustained 60 fps while typing at 12 characters per second on a mid-range laptop.
- Keystroke to visible ink latency under 30 ms; that is the difference between "responsive machine" and "laggy web app", and it is the second thing after per-glyph variation that people feel without being able to name.
- Do not re-render the whole grid per keystroke. Append the new impression only. Only the sheet transform changes.
- Randomization filters must be precomputed or expressed as cheap CSS transforms, not live SVG filters on the whole text layer.
- Full page of 54 lines by 65 characters with overstrikes must stay smooth.
- Switching typeface on a full page must re-render in under 200 ms.

## 12. What to avoid

- Blinking block or I-beam text caret.
- Any proportional font anywhere on the sheet.
- Pure black ink, brown-black ink, pure white paper.
- A photographic paper texture at high opacity - it fights the ink and tiles visibly.
- Identical glyph rendering for repeated letters.
- Loud, bright, or identical keystroke samples.
- A typing "animation" that reveals pre-written text. The user types; the app never types for them, except optionally in a one-time demo.
- Text-editor conveniences leaking in visually: no selection highlight in the browser default blue, no autocorrect, no spellcheck underlines, no scrollbars on the sheet.
- Any control that looks like web UI: no hamburger, no gear icon, no floating action button, no toast notifications, no OS-default checkbox/select/range widgets, no browser `confirm()` or `alert()`.
- A modal scrim behind the settings card. It is a card on a desk, not a dialog over an app.
- Ribbon wear that outruns legibility, or that fades ink already on the page.

## 13. Acceptance test

The build is right when: screenshot a paragraph, zoom to 400 percent, and no two instances of the same letter are identical; type with eyes closed and the sound alone tells you when you hit the margin bell and when you returned the carriage; backspace and retype a word and the result looks like a real corrected page rather than a clean edit; a first-time user can correct a typo with `Backspace` without reading anything, and a Realism Mode user can tell which mode they are in at a glance from the latched key; the settings card reads as an object that was placed on the desk rather than a panel that appeared; a 3000-strike session in Realism Mode has visibly tired ink but is still fully readable; and typing for ten minutes straight is pleasant rather than annoying.
