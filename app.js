/* ---------------------------------------------------------------------------
 * Audio engine - procedural synthesis standing in for the sample-based engine
 * described in docs/realism-prompt.md section 10.
 *
 * The spec asks for 5 to 8 recorded samples per event played from a decoded
 * buffer pool. No sample files exist for this build and none can be fetched,
 * so every sound here is built at runtime from oscillators, filtered noise and
 * gain envelopes. The variation the spec demands is preserved: each event has
 * several synthesis variants, one is chosen at random, the same variant never
 * fires twice in a row, and playback rate is jittered by plus or minus 4
 * percent with gain jittered by plus or minus 2 dB.
 *
 * To swap in real samples later:
 *   1. Replace the noise buffer pool built in buildNoisePool() with an
 *      AudioBuffer pool decoded from fetched files, keyed by event name.
 *   2. Replace each synth<Event>() function body with a single call to
 *      playBuffer(pool[event][variantIndex], ...) - the variant picker, the
 *      rate/gain jitter, the voice cap, the wear model and the master chain
 *      all stay exactly as they are and need no changes.
 *   3. Keep unlock() lazy: decodeAudioData still belongs there, after resume().
 * The public API (unlock, play, setEnabled, setVolume) would not change.
 * ------------------------------------------------------------------------- */

function createAudioEngine() {
  'use strict';

  var ctx = null;
  var ready = false;
  var enabled = true;
  var volume = 0.55;

  // Master level is deliberately low. Everything is scaled by this.
  var MASTER_TRIM = 0.34;
  var VOICE_CAP = 24;

  var masterGain = null;   // final level, also the mute point
  var masterIn = null;     // everything lands here before tone shaping
  var busWet = null;       // voices that should get room reverb
  var busDry = null;       // close, dry voices (paper, card shuffle)
  var convolver = null;
  var wetGain = null;

  var noisePool = [];      // reused forever, never allocated per keystroke
  var voices = [];         // active voice records, oldest first
  var lastVariant = {};    // per event name, index of the previous variant
  var lastBuffer = -1;

  // ---- small helpers -------------------------------------------------------

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // plus or minus 4 percent playback rate
  function rateJitter() { return rnd(0.96, 1.04); }

  // plus or minus 2 dB expressed as a linear factor
  function gainJitter() { return Math.pow(10, rnd(-2, 2) / 20); }

  // Pick a variant index that is never the same as the previous one.
  function pickVariant(key, count) {
    if (count <= 1) return 0;
    var prev = lastVariant[key];
    var i = Math.floor(Math.random() * count);
    if (i === prev) i = (i + 1 + Math.floor(Math.random() * (count - 1))) % count;
    lastVariant[key] = i;
    return i;
  }

  function pickNoise() {
    var i = Math.floor(Math.random() * noisePool.length);
    if (i === lastBuffer) i = (i + 1) % noisePool.length;
    lastBuffer = i;
    return noisePool[i];
  }

  // ---- buffer + impulse construction (runs once, inside unlock) ------------

  function buildNoisePool() {
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * 0.5);
    var pool = [];
    for (var n = 0; n < 7; n++) {
      var buf = ctx.createBuffer(1, len, sr);
      var d = buf.getChannelData(0);
      var pink = n % 2 === 1; // alternate white and pink for tonal variety
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        if (pink) {
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        } else {
          d[i] = w * 0.6;
        }
      }
      pool.push(buf);
    }
    return pool;
  }

  // Small warm room, 0.3 to 0.6 s, built from decaying filtered noise.
  function buildImpulse() {
    var sr = ctx.sampleRate;
    var dur = 0.46;
    var len = Math.floor(sr * dur);
    var buf = ctx.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      var lp = 0;
      var preDelay = Math.floor(sr * (c === 0 ? 0.008 : 0.011));
      for (var i = 0; i < len; i++) {
        if (i < preDelay) { d[i] = 0; continue; }
        var t = (i - preDelay) / (len - preDelay);
        var decay = Math.pow(1 - t, 2.6) * Math.exp(-3.2 * t);
        var s = (Math.random() * 2 - 1) * decay;
        lp += (s - lp) * 0.32;   // one pole lowpass, keeps the tail soft
        d[i] = lp * 0.9;
      }
    }
    return buf;
  }

  // ---- voice management ----------------------------------------------------

  function reap() {
    var now = ctx.currentTime;
    for (var i = voices.length - 1; i >= 0; i--) {
      if (voices[i].dead || voices[i].end < now - 0.05) voices.splice(i, 1);
    }
  }

  function killVoice(v, fade) {
    if (v.dead) return;
    v.dead = true;
    var now = ctx.currentTime;
    var f = fade === undefined ? 0.02 : fade;
    try {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(Math.max(v.gain.gain.value, 0.0001), now);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, now + f);
    } catch (e) { /* node already gone */ }
    for (var i = 0; i < v.sources.length; i++) {
      try { v.sources[i].stop(now + f + 0.005); } catch (e) {}
    }
  }

  function killAll(fade) {
    for (var i = 0; i < voices.length; i++) killVoice(voices[i], fade);
    voices.length = 0;
  }

  // Creates the per-voice output gain and registers it against the voice cap.
  function newVoice(end, dry) {
    reap();
    while (voices.length >= VOICE_CAP) {
      killVoice(voices.shift(), 0.012);   // steal the oldest
    }
    var g = ctx.createGain();
    g.gain.value = 1;
    g.connect(dry ? busDry : busWet);
    var v = { gain: g, sources: [], end: end, dead: false };
    voices.push(v);
    return v;
  }

  function trackSource(v, src, stopAt) {
    v.sources.push(src);
    src.onended = function () {
      try { src.disconnect(); } catch (e) {}
      src.onended = null;
      v.pending = (v.pending || 0) - 1;
      if (v.pending <= 0) {
        try { v.gain.disconnect(); } catch (e) {}
        v.dead = true;
      }
    };
    v.pending = (v.pending || 0) + 1;
    if (stopAt !== undefined) {
      try { src.stop(stopAt); } catch (e) {}
    }
  }

  // ---- envelope helper -----------------------------------------------------
  // Soft attacks only. Nothing here uses an instant step, which is what makes
  // a synthetic click sound harsh.
  function env(param, t0, peak, attack, decay, hold) {
    var h = hold || 0;
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    if (h > 0) param.setValueAtTime(Math.max(peak, 0.0002), t0 + attack + h);
    param.exponentialRampToValueAtTime(0.0001, t0 + attack + h + decay);
    param.setValueAtTime(0, t0 + attack + h + decay + 0.001);
    return t0 + attack + h + decay + 0.01;
  }

  // ---- primitive layers ----------------------------------------------------

  /* A filtered burst of noise. opts:
     t     start time
     dur   decay length
     freq  filter cutoff or centre
     type  'lowpass' | 'bandpass' | 'highpass'
     q     filter Q
     gain  peak gain
     atk   attack length
     hold  sustain length
     sweep optional end frequency for a swept gesture
     lp    optional extra lowpass ceiling                                   */
  function noiseBurst(v, o) {
    var t = o.t;
    var src = ctx.createBufferSource();
    src.buffer = pickNoise();
    src.playbackRate.value = (o.rate || 1) * rateJitter();

    var f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(clamp(o.freq, 40, 9000), t);
    f.Q.value = o.q === undefined ? 0.9 : o.q;
    if (o.sweep) {
      f.frequency.exponentialRampToValueAtTime(
        clamp(o.sweep, 40, 9000), t + o.dur + (o.hold || 0)
      );
    }

    var tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = clamp(o.lp || 5200, 200, 9000);
    tone.Q.value = 0.6;

    var g = ctx.createGain();
    var end = env(g.gain, t, o.gain * gainJitter(), o.atk || 0.004, o.dur, o.hold || 0);

    src.connect(f); f.connect(tone); tone.connect(g); g.connect(v.gain);
    var offset = Math.random() * 0.35;
    try { src.start(t, offset, (end - t) + 0.02); } catch (e) { src.start(t); }
    trackSource(v, src, end + 0.02);
    return end;
  }

  /* A pitched partial. Used for the platen resonance, the bell and the low
     body thump under heavy keys.                                          */
  function partial(v, o) {
    var t = o.t;
    var osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(clamp(o.freq * (o.jitter === false ? 1 : rateJitter()), 20, 9000), t);
    if (o.glide) {
      osc.frequency.exponentialRampToValueAtTime(clamp(o.glide, 20, 9000), t + o.dur);
    }
    var g = ctx.createGain();
    var end = env(g.gain, t, o.gain * gainJitter(), o.atk || 0.003, o.dur, o.hold || 0);
    osc.connect(g);
    if (o.lp) {
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = clamp(o.lp, 100, 9000);
      f.Q.value = 0.6;
      g.connect(f); f.connect(v.gain);
    } else {
      g.connect(v.gain);
    }
    osc.start(t);
    trackSource(v, osc, end + 0.02);
    return end;
  }

  // A single ratchet detent: tiny woody click, never full spectrum.
  function ratchetClick(v, t, gain, freq) {
    noiseBurst(v, {
      t: t, freq: freq, type: 'bandpass', q: 4.5,
      dur: 0.022, gain: gain, atk: 0.0015, lp: 3400
    });
    partial(v, { t: t, freq: freq * 0.5, type: 'triangle', dur: 0.03, gain: gain * 0.35, lp: 1800 });
    return t + 0.03;
  }

  // ---- event synthesis -----------------------------------------------------

  /* Keystroke family. Three layers: key-down click, typebar hitting the
     platen (the body), faint mechanical return. `weight` shifts the whole
     thing darker and heavier for space and rail keys.                     */
  function synthKey(kind, wear) {
    var t = ctx.currentTime + 0.001;
    var w = clamp(wear || 0, 0, 1);

    var cfg;
    if (kind === 'space') {
      // deeper and duller than a letter key
      cfg = { body: rnd(430, 620), lp: 2100, dur: 0.075, gain: 0.30, thump: 96, click: 0.055 };
    } else if (kind === 'rail') {
      // heavier and duller still: a function key, not a typebar
      cfg = { body: rnd(300, 430), lp: 1500, dur: 0.11, gain: 0.34, thump: 74, click: 0.06 };
    } else {
      cfg = { body: rnd(900, 1500), lp: 4200, dur: 0.05, gain: 0.26, click: 0.07, thump: 150 };
    }

    var variant = pickVariant('key-' + kind, 5);
    // Each variant nudges the resonance, the decay and the filter slope so no
    // two consecutive strikes are the same shape.
    var vShift = [1.0, 1.14, 0.88, 1.06, 0.94][variant];
    var vDecay = [1.0, 0.86, 1.18, 1.05, 0.92][variant];

    // A worn ribbon dulls and quietens the strike slightly. Small effect.
    var wearGain = 1 - 0.14 * w;
    var wearTone = 1 - 0.16 * w;

    var end = t + cfg.dur * vDecay + 0.16;
    var v = newVoice(end, false);

    // 1. key-down click - soft, low, no high end at all
    noiseBurst(v, {
      t: t, freq: 780 * vShift, type: 'lowpass', q: 0.8,
      dur: 0.014, gain: cfg.click * wearGain, atk: 0.0025, lp: 1600
    });

    // 2. the body: filtered noise burst plus a short pitched platen resonance
    noiseBurst(v, {
      t: t + 0.006, freq: cfg.body * vShift, type: 'bandpass', q: 1.5,
      dur: cfg.dur * vDecay, gain: cfg.gain * wearGain, atk: 0.003,
      lp: cfg.lp * wearTone
    });
    partial(v, {
      t: t + 0.006, freq: cfg.body * vShift * 1.9, type: 'triangle',
      dur: cfg.dur * 0.8 * vDecay, gain: cfg.gain * 0.30 * wearGain,
      lp: cfg.lp * wearTone
    });
    partial(v, {
      t: t + 0.005, freq: cfg.thump, type: 'sine',
      dur: cfg.dur * 1.5, gain: cfg.gain * 0.42 * wearGain, lp: 700
    });

    // 3. faint mechanical return of the typebar
    var rt = t + rnd(0.052, 0.086);
    noiseBurst(v, {
      t: rt, freq: cfg.body * 0.55, type: 'bandpass', q: 2.2,
      dur: 0.03, gain: cfg.gain * 0.16 * wearGain, atk: 0.004, lp: 1900
    });
  }

  // Backspace / arrow key: the escapement stepping one cell.
  function synthCarriageStep() {
    var t = ctx.currentTime + 0.001;
    var vi = pickVariant('carriageStep', 4);
    var f = [1180, 1320, 1050, 1420][vi];
    var v = newVoice(t + 0.14, false);
    noiseBurst(v, { t: t, freq: f, type: 'bandpass', q: 5, dur: 0.026, gain: 0.13, atk: 0.002, lp: 3200 });
    partial(v, { t: t, freq: f * 0.42, type: 'triangle', dur: 0.045, gain: 0.07, lp: 1500 });
    noiseBurst(v, { t: t + rnd(0.03, 0.05), freq: 520, type: 'lowpass', dur: 0.03, gain: 0.05, atk: 0.004, lp: 1200 });
  }

  /* Margin bell. A real struck bell: a soft mallet noise plus three
     inharmonic partials with a longish decay.                              */
  function synthBell() {
    var t = ctx.currentTime + 0.001;
    var vi = pickVariant('bell', 3);
    var base = [1046, 1120, 985][vi] * rateJitter();
    var v = newVoice(t + 2.0, false);

    // strike transient, kept soft
    noiseBurst(v, { t: t, freq: base * 1.4, type: 'bandpass', q: 2.5, dur: 0.02, gain: 0.10, atk: 0.002, lp: 5000 });

    var ratios = [1, 2.41, 3.72];       // inharmonic, dome-bell flavoured
    var gains = [0.20, 0.085, 0.045];
    var decays = [1.55, 1.05, 0.62];
    for (var i = 0; i < 3; i++) {
      partial(v, {
        t: t + i * 0.002, freq: base * ratios[i] * rnd(0.997, 1.003),
        type: 'sine', dur: decays[i] * rnd(0.9, 1.1),
        gain: gains[i], atk: 0.006, lp: 6000, jitter: false
      });
    }
    // slow beating from a slightly detuned fundamental
    partial(v, { t: t, freq: base * 1.006, type: 'sine', dur: 1.3, gain: 0.09, atk: 0.008, lp: 6000, jitter: false });
  }

  /* Carriage return: a swept noise gesture (the carriage travelling right),
     the margin stop landing, then the platen ratchet advancing one line.
     The two motions overlap, as the spec's motion section describes.       */
  function synthReturn() {
    var t = ctx.currentTime + 0.001;
    var vi = pickVariant('return', 4);
    var travel = [0.20, 0.24, 0.18, 0.22][vi];
    var v = newVoice(t + travel + 0.5, false);

    noiseBurst(v, {
      t: t, freq: 2400, sweep: 620, type: 'bandpass', q: 1.1,
      dur: travel * 0.55, hold: travel * 0.45, gain: 0.15, atk: 0.018, lp: 4200
    });
    noiseBurst(v, {
      t: t, freq: 380, type: 'lowpass', dur: travel * 0.5, hold: travel * 0.4,
      gain: 0.10, atk: 0.02, lp: 900
    });
    // margin stop thunk
    var st = t + travel;
    noiseBurst(v, { t: st, freq: 420, type: 'bandpass', q: 1.4, dur: 0.09, gain: 0.24, atk: 0.003, lp: 2000 });
    partial(v, { t: st, freq: 118, type: 'sine', dur: 0.14, gain: 0.20, lp: 600 });
    // overlapping line advance
    lineAdvanceInto(v, st - 0.03);
  }

  function lineAdvanceInto(v, t) {
    var n = 3 + Math.floor(Math.random() * 2);
    var p = t;
    for (var i = 0; i < n; i++) {
      ratchetClick(v, p, 0.085 * (1 - i * 0.12), rnd(900, 1250));
      p += rnd(0.016, 0.026);
    }
    partial(v, { t: t + 0.02, freq: 132, type: 'sine', dur: 0.10, gain: 0.09, lp: 600 });
    return p;
  }

  function synthLineAdvance() {
    var t = ctx.currentTime + 0.001;
    pickVariant('lineAdvance', 4);
    var v = newVoice(t + 0.28, false);
    lineAdvanceInto(v, t);
  }

  /* Paper feed / roll: a longer rolling noise with a slow amplitude wobble
     from the platen turning, plus sparse detents.                          */
  function synthPaperFeed(scale, gainScale) {
    var t = ctx.currentTime + 0.001;
    var vi = pickVariant('paperFeed', 3);
    var dur = ([0.85, 1.05, 0.72][vi]) * (scale || 1);
    var g0 = 0.13 * (gainScale === undefined ? 1 : gainScale);
    var v = newVoice(t + dur + 0.3, true);

    // rolling paper body
    var src = ctx.createBufferSource();
    src.buffer = pickNoise();
    src.loop = true;
    src.playbackRate.value = rnd(0.72, 0.9);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 760; bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(560, t);
    bp.frequency.linearRampToValueAtTime(980, t + dur * 0.6);
    bp.frequency.linearRampToValueAtTime(600, t + dur);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    var g = ctx.createGain();
    env(g.gain, t, g0 * gainJitter(), 0.05, dur * 0.35, dur * 0.55);

    // slow wobble so it reads as a turning roller, not a hiss
    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rnd(5.5, 8.5);
    var lfoG = ctx.createGain();
    lfoG.gain.value = g0 * 0.35;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    lfo.start(t);
    trackSource(v, lfo, t + dur + 0.1);

    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(v.gain);
    src.start(t);
    trackSource(v, src, t + dur + 0.1);

    var p = t + 0.06;
    while (p < t + dur * 0.9) {
      ratchetClick(v, p, 0.045, rnd(700, 1100));
      p += rnd(0.09, 0.17);
    }
  }

  // Correction tape: a short dry squeak, close mic'd, no tail.
  function synthWhiteout() {
    var t = ctx.currentTime + 0.001;
    var vi = pickVariant('whiteout', 4);
    var f0 = [1500, 1720, 1330, 1880][vi] * rateJitter();
    var dur = rnd(0.09, 0.14);
    var v = newVoice(t + dur + 0.2, true);

    // the squeak itself: two close partials sliding, band limited
    partial(v, { t: t, freq: f0, glide: f0 * rnd(1.18, 1.45), type: 'triangle', dur: dur, gain: 0.055, atk: 0.012, lp: 3600 });
    partial(v, { t: t + 0.006, freq: f0 * 1.51, glide: f0 * 1.9, type: 'sine', dur: dur * 0.8, gain: 0.028, atk: 0.014, lp: 3600 });
    // the dry scrape under it
    noiseBurst(v, { t: t, freq: 900, sweep: 1400, type: 'bandpass', q: 2.0, dur: dur * 0.9, gain: 0.05, atk: 0.01, lp: 3000 });
  }

  // Ribbon advance tick: fires on every keystroke, so it must be very quiet.
  function synthRibbonTick() {
    var t = ctx.currentTime + 0.001;
    var vi = pickVariant('ribbonTick', 4);
    var f = [1650, 1450, 1850, 1550][vi];
    var v = newVoice(t + 0.06, true);
    noiseBurst(v, { t: t, freq: f, type: 'bandpass', q: 6, dur: 0.012, gain: 0.022, atk: 0.0015, lp: 3000 });
  }

  // Ribbon spool swap: spool rattle, a short roll, and the cover seating.
  function synthRibbonSwap() {
    var t = ctx.currentTime + 0.001;
    pickVariant('ribbonSwap', 3);
    var v = newVoice(t + 0.9, false);
    var p = t;
    for (var i = 0; i < 4; i++) {
      ratchetClick(v, p, 0.07, rnd(800, 1350));
      p += rnd(0.045, 0.08);
    }
    noiseBurst(v, { t: t + 0.12, freq: 680, sweep: 900, type: 'bandpass', q: 0.8, dur: 0.18, hold: 0.16, gain: 0.075, atk: 0.03, lp: 2400 });
    // spool seating thunk
    noiseBurst(v, { t: t + 0.46, freq: 360, type: 'bandpass', q: 1.3, dur: 0.11, gain: 0.17, atk: 0.004, lp: 1700 });
    partial(v, { t: t + 0.46, freq: 104, type: 'sine', dur: 0.16, gain: 0.15, lp: 550 });
  }

  // Settings card: dry paper crinkle, no reverb tail.
  function synthCardShuffle(soft) {
    var t = ctx.currentTime + 0.001;
    var vi = pickVariant('cardShuffle', 4);
    var count = [5, 6, 4, 7][vi];
    var g0 = soft ? 0.055 : 0.085;
    var v = newVoice(t + 0.5, true);
    var p = t;
    for (var i = 0; i < count; i++) {
      noiseBurst(v, {
        t: p, freq: rnd(1400, 2600), type: 'bandpass', q: rnd(0.8, 1.6),
        dur: rnd(0.02, 0.05), gain: g0 * rnd(0.5, 1.0), atk: 0.006, lp: 4000
      });
      p += rnd(0.018, 0.055);
    }
    // the card landing on the desk
    noiseBurst(v, { t: p + 0.02, freq: 520, type: 'lowpass', dur: 0.06, gain: g0 * 0.9, atk: 0.006, lp: 1300 });
  }

  // Undo: an anachronistic little rewind. Fast accelerating clicks under a
  // rising band of noise.
  function synthUndo() {
    var t = ctx.currentTime + 0.001;
    var vi = pickVariant('undo', 3);
    var n = [6, 7, 5][vi];
    var v = newVoice(t + 0.35, false);
    noiseBurst(v, { t: t, freq: 700, sweep: 1900, type: 'bandpass', q: 1.6, dur: 0.13, gain: 0.075, atk: 0.012, lp: 3400 });
    var p = t, step = 0.030;
    for (var i = 0; i < n; i++) {
      ratchetClick(v, p, 0.05 * (1 - i * 0.08), 1000 + i * 90);
      step *= 0.86;
      p += step;
    }
  }

  // ---- public API ----------------------------------------------------------

  function unlock() {
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();

        noisePool = buildNoisePool();

        masterGain = ctx.createGain();
        masterGain.gain.value = enabled ? volume * MASTER_TRIM : 0;

        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 68; hp.Q.value = 0.7;

        // Roll off above roughly 6 kHz so it reads as a machine in a room.
        var lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 6000; lp.Q.value = 0.6;

        // A second gentle shelf keeps anything sharp above 4 kHz from biting.
        var shelf = ctx.createBiquadFilter();
        shelf.type = 'highshelf'; shelf.frequency.value = 4200; shelf.gain.value = -5;

        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -20;
        comp.knee.value = 22;
        comp.ratio.value = 3.5;
        comp.attack.value = 0.004;
        comp.release.value = 0.14;

        masterIn = ctx.createGain();
        masterIn.gain.value = 1;

        convolver = ctx.createConvolver();
        convolver.buffer = buildImpulse();
        wetGain = ctx.createGain();
        wetGain.gain.value = 0.16;      // low wet mix

        busWet = ctx.createGain(); busWet.gain.value = 1;
        busDry = ctx.createGain(); busDry.gain.value = 1;

        busWet.connect(masterIn);
        busWet.connect(convolver);
        convolver.connect(wetGain);
        wetGain.connect(masterIn);
        busDry.connect(masterIn);

        masterIn.connect(hp);
        hp.connect(shelf);
        shelf.connect(lp);
        lp.connect(comp);
        comp.connect(masterGain);
        masterGain.connect(ctx.destination);

        ready = true;
      }
      if (ctx.state === 'suspended' && ctx.resume) {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {
      ctx = null;
      ready = false;
    }
  }

  function play(name, opts) {
    // Before unlock this is a silent no-op and never throws.
    if (!ready || !ctx || !enabled) return;
    if (ctx.state !== 'running') return;
    try {
      var wear = opts && typeof opts.wear === 'number' ? opts.wear : 0;
      switch (name) {
        case 'key':          synthKey('letter', wear); break;
        case 'space':        synthKey('space', wear); break;
        case 'railKey':      synthKey('rail', 0); break;
        case 'carriageStep': synthCarriageStep(); break;
        case 'bell':         synthBell(); break;
        case 'return':       synthReturn(); break;
        case 'lineAdvance':  synthLineAdvance(); break;
        case 'paperFeed':    synthPaperFeed(1, 1); break;
        case 'whiteout':     synthWhiteout(); break;
        case 'ribbonTick':   synthRibbonTick(); break;
        case 'ribbonSwap':   synthRibbonSwap(); break;
        case 'cardShuffle':  synthCardShuffle(opts && opts.soft); break;
        case 'undo':         synthUndo(); break;
        default: break;
      }
    } catch (e) {
      // Never let a sound break a keystroke.
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!ctx || !masterGain) return;
    var now = ctx.currentTime;
    try {
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(masterGain.gain.value, now);
      if (enabled) {
        masterGain.gain.linearRampToValueAtTime(volume * MASTER_TRIM, now + 0.03);
      } else {
        // Silence immediately, then tear down anything already scheduled.
        masterGain.gain.linearRampToValueAtTime(0, now + 0.012);
        killAll(0.012);
      }
    } catch (e) {}
  }

  function setVolume(v) {
    volume = clamp(typeof v === 'number' ? v : 0, 0, 1);
    if (!ctx || !masterGain) return;
    try {
      var now = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(masterGain.gain.value, now);
      masterGain.gain.linearRampToValueAtTime(enabled ? volume * MASTER_TRIM : 0, now + 0.04);
    } catch (e) {}
  }

  return {
    unlock: unlock,
    play: play,
    setEnabled: setEnabled,
    setVolume: setVolume
  };
}


/* Typewriter - app core.
   Source of truth for behavior: docs/realism-prompt.md
   Layers here: config, seeded RNG, page model, renderer, carriage, ribbon,
   input, UI (rail + settings card), persistence. Audio engine is appended
   at the bottom of this file. */
(function () {
  'use strict';

  /* ----------------------------------------------------------------- audio
     Bound before anything else so every call site is safe during boot. The
     real engine is defined at the bottom of this file. */

  var Sound = (typeof createAudioEngine === 'function') ? createAudioEngine() : {
    unlock: function () {}, play: function () {},
    setEnabled: function () {}, setVolume: function () {}
  };

  /* ---------------------------------------------------------------- config */

  var COLS = 65;
  var ROWS = 54;
  var BELL_AT = COLS - 8;           // bell rings this many cells before the margin
  var STORAGE_KEY = 'typewriter:v1';
  var PREFS_KEY = 'typewriter:prefs:v1';

  // Ribbon wear (Realism Mode only). Full ink until FRESH_STRIKES, then a
  // non-linear fade that bottoms out at WORN_STRIKES and never goes further.
  var FRESH_STRIKES = 900;
  var WORN_STRIKES = 3000;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ------------------------------------------------------------------- dom */

  var $ = function (sel) { return document.querySelector(sel); };
  var sheet = $('#sheet');
  var inkLayer = $('#ink-layer');
  var patchLayer = $('#patch-layer');
  var machine = $('#machine');
  var card = $('#settings-card');
  var carbon = $('#erase-confirm');
  var status = $('#a11y-status');

  function say(msg) { status.textContent = msg; }

  /* ------------------------------------------------------------------- rng
     Each impression freezes a seed at strike time. Everything visual about
     that impression is derived from the seed, so it never changes on
     re-render, typeface switch, or reload. */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function newSeed() { return (Math.random() * 4294967296) >>> 0; }

  /* ----------------------------------------------------------------- model
     The page is a sparse grid of cells, NOT a string. Each cell holds an
     ordered list of impressions so overstrike falls out for free. */

  var page = {
    cells: Object.create(null),   // "row,col" -> { impressions: [], patched: bool }
    strikes: 0,                   // ribbon wear counter, survives new sheets
    sheetNo: 1
  };

  var history = [];               // undo stack
  var carriage = { row: 0, col: 0 };
  var bellRungThisLine = false;

  function cellKey(row, col) { return row + ',' + col; }

  function getCell(row, col, create) {
    var k = cellKey(row, col);
    var c = page.cells[k];
    if (!c && create) { c = page.cells[k] = { impressions: [], patched: false }; }
    return c;
  }

  /* ---------------------------------------------------------------- ribbon */

  function realismOn() { return document.body.dataset.realism === 'on'; }

  // 0 = fresh, 1 = fully worn. Only meaningful in Realism Mode.
  function wearLevel() {
    if (!realismOn()) { return 0; }
    var t = (page.strikes - FRESH_STRIKES) / (WORN_STRIKES - FRESH_STRIKES);
    if (t <= 0) { return 0; }
    if (t >= 1) { return 1; }
    return t * t * (3 - 2 * t);   // smoothstep, so the fade creeps in
  }

  function refreshRibbonUi() {
    var w = wearLevel();
    var row = card.querySelector('[data-setting="ribbon"]');
    var spool = $('#ribbon-wear');
    spool.style.setProperty('--wear', w.toFixed(3));
    row.hidden = !(realismOn() && w > 0.45);
    document.body.dataset.ribbon = w > 0.45 ? 'worn' : 'fresh';
  }

  function swapRibbon() {
    page.strikes = 0;
    refreshRibbonUi();
    Sound.play('ribbonSwap');
    say('Fresh ribbon.');
  }

  /* -------------------------------------------------------------- renderer
     JS only ever writes custom properties. Position, jitter, opacity and
     bleed all live in CSS. */

  function makeImpressionEl(imp) {
    var rand = mulberry32(imp.seed);
    var el = document.createElement('span');
    el.className = 'impression';
    el.textContent = imp.ch;

    var dx = (rand() - 0.5) * 1.5;          // horizontal jitter, stays in cell
    var dy = (rand() - 0.5) * 2.4;          // typebars do not land on a baseline
    var rot = (rand() - 0.5) * 1.4;         // degrees

    // Ink density: mostly strong, occasionally faint, dragged down by wear.
    var roll = rand();
    var base = 0.72 + Math.pow(roll, 0.45) * 0.28;
    var top = 1.0 - imp.wear * 0.30;
    var bottom = 0.72 - imp.wear * 0.27;
    var alpha = bottom + (base - 0.72) / 0.28 * (top - bottom);

    // A dry ribbon smears more than it prints.
    var blur = 0.3 + rand() * 0.3 + imp.wear * 0.35;

    el.style.setProperty('--col', imp.col);
    el.style.setProperty('--row', imp.row);
    el.style.setProperty('--dx', dx.toFixed(2) + 'px');
    el.style.setProperty('--dy', dy.toFixed(2) + 'px');
    el.style.setProperty('--rot', rot.toFixed(2) + 'deg');
    el.style.setProperty('--alpha', alpha.toFixed(3));
    el.style.setProperty('--blur', blur.toFixed(2) + 'px');
    if (imp.ink === 'red') { el.classList.add('red'); }

    imp.el = el;
    return el;
  }

  function makePatchEl(row, col, seed) {
    var rand = mulberry32(seed);
    var el = document.createElement('span');
    el.className = 'correction-patch';
    el.style.setProperty('--col', col);
    el.style.setProperty('--row', row);
    el.style.setProperty('--dx', ((rand() - 0.5) * 2).toFixed(2) + 'px');
    el.style.setProperty('--dy', ((rand() - 0.5) * 2).toFixed(2) + 'px');
    el.style.setProperty('--rot', ((rand() - 0.5) * 3).toFixed(2) + 'deg');
    return el;
  }

  function renderAll() {
    inkLayer.textContent = '';
    patchLayer.textContent = '';
    Object.keys(page.cells).forEach(function (k) {
      var c = page.cells[k];
      if (c.patched) { patchLayer.appendChild(makePatchEl(c.patchRow, c.patchCol, c.patchSeed)); }
      c.impressions.forEach(function (imp) { inkLayer.appendChild(makeImpressionEl(imp)); });
    });
  }

  /* -------------------------------------------------------------- carriage
     Fixed strike point: the active cell stays put on screen and the sheet
     translates under it. */

  // Cell metrics and the strike point both live in CSS. Measure rather than
  // duplicate the numbers, so the two files can never drift apart.
  var metrics = { cw: 19.2, ch: 32, mx: 0, my: 0, gx: 0, gy: 0 };

  function measure() {
    var cs = getComputedStyle(sheet);
    var rootCs = getComputedStyle(document.documentElement);
    metrics.cw = parseFloat(rootCs.getPropertyValue('--cell-w')) || 19.2;
    metrics.ch = parseFloat(rootCs.getPropertyValue('--cell-h')) || 32;
    metrics.mx = parseFloat(rootCs.getPropertyValue('--margin-x')) || 0;
    metrics.my = parseFloat(rootCs.getPropertyValue('--margin-y')) || 0;

    // Where the type guide sits, in viewport-local coordinates.
    var vp = $('#sheet-viewport').getBoundingClientRect();
    var g = $('#type-guide').getBoundingClientRect();
    metrics.gx = (g.left + g.width / 2) - vp.left;
    metrics.gy = (g.top + g.height / 2) - vp.top;
    if (!isFinite(metrics.gx) || g.width === 0) { metrics.gx = vp.width * 0.5; metrics.gy = vp.height * 0.64; }
    void cs;
  }

  function updateSheet() {
    // The active cell's center is pinned to the type guide; the sheet moves.
    var x = metrics.gx - metrics.mx - (carriage.col + 0.5) * metrics.cw;
    var y = metrics.gy - metrics.my - (carriage.row + 0.5) * metrics.ch;
    sheet.style.setProperty('--sheet-x', x.toFixed(2) + 'px');
    sheet.style.setProperty('--sheet-y', y.toFixed(2) + 'px');
  }

  function relayout() { measure(); updateSheet(); }

  function shudder() {
    if (reduceMotion.matches) { return; }
    sheet.classList.remove('is-struck');
    void sheet.offsetWidth;
    sheet.classList.add('is-struck');
  }

  function moveTo(row, col, silent) {
    row = Math.max(0, Math.min(ROWS - 1, row));
    col = Math.max(0, Math.min(COLS - 1, col));
    if (row === carriage.row && col === carriage.col) { return; }
    if (row !== carriage.row) { bellRungThisLine = false; }
    carriage.row = row;
    carriage.col = col;
    updateSheet();
    if (!silent) { Sound.play('carriageStep'); }
  }

  function advance() {
    if (carriage.col >= COLS - 1) { return; }   // margin lock
    carriage.col++;
    if (!bellRungThisLine && carriage.col >= BELL_AT) {
      bellRungThisLine = true;
      Sound.play('bell');
    }
    updateSheet();
  }

  function carriageReturn() {
    if (carriage.row >= ROWS - 1) { feedNewSheet(); return; }
    carriage.col = 0;
    carriage.row++;
    bellRungThisLine = false;
    updateSheet();
    Sound.play('return');
    window.setTimeout(function () { Sound.play('lineAdvance'); }, 90);
    history.push({ type: 'return' });

    var lever = $('#carriage-lever');
    lever.classList.add('is-thrown');
    window.setTimeout(function () { lever.classList.remove('is-thrown'); }, 220);
  }

  function feedNewSheet() {
    // Wear is per ribbon, not per sheet, so page.strikes is deliberately kept.
    page.cells = Object.create(null);
    page.sheetNo++;
    carriage.row = 0;
    carriage.col = 0;
    bellRungThisLine = false;
    history.length = 0;
    renderAll();
    updateSheet();
    Sound.play('paperFeed');
    say('New sheet, page ' + page.sheetNo + '.');
  }

  /* ----------------------------------------------------------------- input */

  function strike(ch) {
    var cell = getCell(carriage.row, carriage.col, true);
    var imp = {
      ch: ch,
      col: carriage.col,
      row: carriage.row,
      seed: newSeed(),
      wear: wearLevel(),
      ink: 'black'
    };
    cell.impressions.push(imp);
    inkLayer.appendChild(makeImpressionEl(imp));
    history.push({ type: 'strike', row: imp.row, col: imp.col });

    page.strikes++;
    Sound.play(ch === ' ' ? 'space' : 'key', { wear: imp.wear });
    Sound.play('ribbonTick');
    shudder();
    advance();
    if (realismOn() && page.strikes % 50 === 0) { refreshRibbonUi(); }
  }

  // Carriage back one cell, ink untouched.
  function carriageBack() {
    if (carriage.col === 0) { return; }
    carriage.col--;
    updateSheet();
    Sound.play('carriageStep');
  }

  // White-out: step back, then patch over whatever is in the cell.
  function whiteOut() {
    if (carriage.col > 0) { carriage.col--; updateSheet(); }
    var cell = getCell(carriage.row, carriage.col, true);
    var covered = cell.impressions.slice();
    covered.forEach(function (imp) { if (imp.el && imp.el.parentNode) { imp.el.parentNode.removeChild(imp.el); } });
    cell.impressions = [];

    var wasPatched = cell.patched;
    if (!wasPatched) {
      cell.patched = true;
      cell.patchRow = carriage.row;
      cell.patchCol = carriage.col;
      cell.patchSeed = newSeed();
      patchLayer.appendChild(makePatchEl(cell.patchRow, cell.patchCol, cell.patchSeed));
    }
    history.push({ type: 'patch', row: carriage.row, col: carriage.col, covered: covered, wasPatched: wasPatched });
    Sound.play('whiteout');
  }

  function undo() {
    var op = history.pop();
    if (!op) { return; }
    if (op.type === 'strike') {
      var cell = getCell(op.row, op.col, false);
      if (cell && cell.impressions.length) {
        var imp = cell.impressions.pop();
        if (imp.el && imp.el.parentNode) { imp.el.parentNode.removeChild(imp.el); }
        if (page.strikes > 0) { page.strikes--; }
      }
      moveTo(op.row, op.col, true);
      updateSheet();
    } else if (op.type === 'patch') {
      var c = getCell(op.row, op.col, true);
      if (!op.wasPatched) {
        c.patched = false;
        var el = patchLayer.querySelector('.correction-patch[style*="--col: ' + op.col + '"]');
        if (el) { patchLayer.removeChild(el); }
      }
      c.impressions = op.covered;
      c.impressions.forEach(function (i) { inkLayer.appendChild(makeImpressionEl(i)); });
      moveTo(op.row, op.col, true);
    } else if (op.type === 'return') {
      moveTo(op.row !== undefined ? op.row : carriage.row - 1, COLS - 1, true);
    }
    Sound.play('undo');
    renderPatchesIfStale();
  }

  // Patch removal by attribute lookup is brittle; fall back to a full redraw
  // when the counts disagree.
  function renderPatchesIfStale() {
    var want = 0;
    Object.keys(page.cells).forEach(function (k) { if (page.cells[k].patched) { want++; } });
    if (patchLayer.children.length !== want) { renderAll(); }
  }

  function isPrintable(e) {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  document.addEventListener('keydown', function (e) {
    if (!card.hidden || !carbon.hidden) { return; }              // dialogs own the keyboard
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) { return; }

    Sound.unlock();

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) { return; }

    switch (e.key) {
      case 'Backspace':
        e.preventDefault();
        // Realism Mode flips these two bindings. That is the whole difference.
        if (realismOn() ? e.shiftKey : !e.shiftKey) { whiteOut(); } else { carriageBack(); }
        return;
      case 'Enter':      e.preventDefault(); carriageReturn(); return;
      case 'ArrowLeft':  e.preventDefault(); moveTo(carriage.row, carriage.col - 1); return;
      case 'ArrowRight': e.preventDefault(); moveTo(carriage.row, carriage.col + 1); return;
      case 'ArrowUp':    e.preventDefault(); moveTo(carriage.row - 1, carriage.col); return;
      case 'ArrowDown':  e.preventDefault(); moveTo(carriage.row + 1, carriage.col); return;
      case 'Home':       e.preventDefault(); moveTo(carriage.row, 0); return;
      case 'End':        e.preventDefault(); moveTo(carriage.row, COLS - 1); return;
    }

    if (isPrintable(e)) {
      e.preventDefault();
      strike(e.key);
      scheduleAutosave();
    }
  });

  // Click a cell to move the guide there.
  $('#sheet-viewport').addEventListener('click', function (e) {
    var rect = sheet.getBoundingClientRect();
    var col = Math.floor((e.clientX - rect.left - metrics.mx) / metrics.cw);
    var row = Math.floor((e.clientY - rect.top - metrics.my) / metrics.ch);
    Sound.unlock();
    moveTo(row, col);
  });

  $('#carriage-lever').addEventListener('click', function () { Sound.unlock(); carriageReturn(); });

  /* ------------------------------------------------------------------ text */

  function pageText() {
    var lines = [];
    for (var r = 0; r < ROWS; r++) {
      var line = '';
      for (var c = 0; c < COLS; c++) {
        var cell = page.cells[cellKey(r, c)];
        line += (cell && cell.impressions.length) ? cell.impressions[cell.impressions.length - 1].ch : ' ';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
    return lines.join('\n');
  }

  /* ----------------------------------------------------------- persistence */

  var saveTimer = null;
  function scheduleAutosave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(savePage, 1200);
  }

  function serialize() {
    var cells = {};
    Object.keys(page.cells).forEach(function (k) {
      var c = page.cells[k];
      cells[k] = {
        i: c.impressions.map(function (m) { return [m.ch, m.col, m.row, m.seed, +m.wear.toFixed(3), m.ink]; }),
        p: c.patched ? [c.patchRow, c.patchCol, c.patchSeed] : null
      };
    });
    return { v: 1, sheetNo: page.sheetNo, strikes: page.strikes, cells: cells, carriage: carriage };
  }

  function savePage(quiet) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
      if (!quiet) { say('Saved.'); }
      return true;
    } catch (err) {
      say('Could not save.');
      return false;
    }
  }

  function loadPage() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (err) { return; }
    if (!raw) { return; }
    var data;
    try { data = JSON.parse(raw); } catch (err) { return; }
    if (!data || data.v !== 1) { return; }

    page.cells = Object.create(null);
    page.strikes = data.strikes || 0;
    page.sheetNo = data.sheetNo || 1;
    Object.keys(data.cells || {}).forEach(function (k) {
      var src = data.cells[k];
      var cell = { impressions: [], patched: false };
      (src.i || []).forEach(function (a) {
        cell.impressions.push({ ch: a[0], col: a[1], row: a[2], seed: a[3], wear: a[4], ink: a[5] || 'black' });
      });
      if (src.p) { cell.patched = true; cell.patchRow = src.p[0]; cell.patchCol = src.p[1]; cell.patchSeed = src.p[2]; }
      page.cells[k] = cell;
    });
    if (data.carriage) { carriage.row = data.carriage.row || 0; carriage.col = data.carriage.col || 0; }
  }

  /* -------------------------------------------------------------- settings */

  var prefs = { realism: false, sound: true, volume: 0.55, typeface: 'tt2020' };

  function loadPrefs() {
    var raw;
    try { raw = localStorage.getItem(PREFS_KEY); } catch (err) { return; }
    if (!raw) { return; }
    try {
      var p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        if (typeof p.realism === 'boolean') { prefs.realism = p.realism; }
        if (typeof p.sound === 'boolean') { prefs.sound = p.sound; }
        if (typeof p.volume === 'number') { prefs.volume = p.volume; }
        if (typeof p.typeface === 'string') { prefs.typeface = p.typeface; }
      }
    } catch (err) { /* corrupt prefs, keep defaults */ }
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (err) { /* full or blocked */ }
  }

  function applyPrefs() {
    document.body.dataset.realism = prefs.realism ? 'on' : 'off';
    document.body.dataset.sound = prefs.sound ? 'on' : 'off';
    document.body.dataset.typeface = prefs.typeface;
    $('#opt-realism').checked = prefs.realism;
    $('#opt-sound').checked = prefs.sound;
    $('#opt-volume').value = Math.round(prefs.volume * 100);
    $('#opt-typeface').value = prefs.typeface;
    // Realism Mode must be readable without opening settings: the Settings
    // key carries a latch mark driven by body[data-realism].
    Sound.setEnabled(prefs.sound);
    Sound.setVolume(prefs.volume);
    refreshRibbonUi();
  }

  $('#opt-realism').addEventListener('change', function (e) {
    prefs.realism = e.target.checked;
    savePrefs();
    applyPrefs();
    say(prefs.realism
      ? 'Realism Mode on. Backspace moves the carriage; Shift plus Backspace whites out.'
      : 'Realism Mode off. Backspace whites out.');
  });

  $('#opt-sound').addEventListener('change', function (e) {
    prefs.sound = e.target.checked;
    savePrefs();
    applyPrefs();
    if (prefs.sound) { Sound.unlock(); Sound.play('key'); }
  });

  $('#opt-volume').addEventListener('input', function (e) {
    prefs.volume = e.target.value / 100;
    Sound.setVolume(prefs.volume);
    Sound.unlock();
    Sound.play('key');
    savePrefs();
  });

  $('#opt-typeface').addEventListener('change', function (e) {
    prefs.typeface = e.target.value;
    savePrefs();
    applyPrefs();
    // Seeds are frozen per impression, so the page keeps its character.
  });

  $('#opt-new-ribbon').addEventListener('click', swapRibbon);

  /* --------------------------------------------------------- dialog plumbing */

  var lastFocus = null;

  function openDialog(el, firstFocus, sfx) {
    lastFocus = document.activeElement;
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('is-open');
    if (sfx) { Sound.unlock(); Sound.play(sfx); }
    (firstFocus || el.querySelector('button, input, select')).focus();
  }

  function closeDialog(el, sfx) {
    el.classList.remove('is-open');
    // The lighter shuffle variant on exit, so entrance and exit read as the
    // same piece of card.
    if (sfx) { Sound.play(sfx, { soft: true }); }
    var done = function () { el.hidden = true; };
    if (reduceMotion.matches) { done(); } else { window.setTimeout(done, 240); }
    if (lastFocus && lastFocus.focus) { lastFocus.focus(); }
  }

  function trapFocus(el, e) {
    if (e.key !== 'Tab') { return; }
    var items = el.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
    if (!items.length) { return; }
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  card.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(card, 'cardShuffle'); }
    trapFocus(card, e);
  });

  carbon.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(carbon); }
    trapFocus(carbon, e);
  });

  $('#card-close').addEventListener('click', function () { closeDialog(card, 'cardShuffle'); });

  document.addEventListener('pointerdown', function (e) {
    if (!card.hidden && !card.contains(e.target) && !e.target.closest('.rail-key[data-action="settings"]')) {
      closeDialog(card, 'cardShuffle');
    }
  });

  /* ------------------------------------------------------------- rail keys */

  function flashKey(btn) {
    btn.classList.remove('is-stamped');
    void btn.offsetWidth;
    btn.classList.add('is-stamped');
    window.setTimeout(function () { btn.classList.remove('is-stamped'); }, 900);
  }

  document.querySelectorAll('.rail-key').forEach(function (btn) {
    btn.addEventListener('click', function () {
      Sound.unlock();
      Sound.play('railKey');
      var action = btn.dataset.action;

      if (action === 'settings') {
        if (card.hidden) { openDialog(card, $('#opt-realism'), 'cardShuffle'); }
        else { closeDialog(card, 'cardShuffle'); }

      } else if (action === 'save') {
        if (savePage()) { flashKey(btn); }

      } else if (action === 'copy') {
        var text = pageText();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            flashKey(btn);
            say('Page copied.');
          }, function () { say('Could not copy.'); });
        } else {
          say('Clipboard not available.');
        }

      } else if (action === 'erase') {
        openDialog(carbon, $('#erase-no'));
      }
    });
  });

  $('#erase-no').addEventListener('click', function () { closeDialog(carbon); });

  $('#erase-yes').addEventListener('click', function () {
    closeDialog(carbon);
    page.cells = Object.create(null);
    history.length = 0;
    carriage.row = 0;
    carriage.col = 0;
    bellRungThisLine = false;
    renderAll();
    updateSheet();
    Sound.play('paperFeed');
    savePage(true);
    say('Page erased.');
  });

  /* ------------------------------------------------------------------ boot */

  window.addEventListener('beforeunload', function () { savePage(true); });
  window.addEventListener('resize', relayout);
  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(relayout); }

  loadPrefs();
  loadPage();
  applyPrefs();
  renderAll();
  relayout();

})();
