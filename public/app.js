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
 *      rate/gain jitter, the voice cap and the master chain
 *      all stay exactly as they are and need no changes.
 *   3. Keep unlock() lazy: decodeAudioData still belongs there, after resume().
 * The public API (unlock, play, setEnabled, setVolume, setProfile) would not change.
 * ------------------------------------------------------------------------- */

function createAudioEngine() {
  'use strict';

  var ctx = null;
  var ready = false;
  var enabled = true;
  var volume = 0.55;
  var soundProfile = 'classic';

  var SOUND_PROFILES = {
    classic:     { keyPitch: 1,    keyTone: 1,    keyGain: 1,    keyDecay: 1,    clickGain: 1,    travel: 0.30,  sweepF: 3200, sweepEnd: 1100, sweepGain: 0.105, sweepLp: 5600, zipF: 2350, zipGap: 0.024, zipCount: 11, zipGain: 0.13, impactF: 1350, impactBody: 148, impactLp: 3600 },
    chrome:      { staged: true, keyF: 3200, bodyF: 1120, wave: 'triangle', keyDur: 0.045, travel: 0.315, sweepF: 3700, sweepEnd: 1850, sweepGain: 0.18, sweepLp: 6500, zipF: 3000, zipGap: 0.021, zipCount: 15, zipGain: 0.27, impactF: 1650, impactBody: 162, impactLp: 4400 },
    foundry:     { staged: true, keyF: 2450, bodyF: 720,  wave: 'square',   keyDur: 0.065, travel: 0.338, sweepF: 2900, sweepEnd: 920,  sweepGain: 0.2,  sweepLp: 4700, zipF: 2200, zipGap: 0.026, zipCount: 13, zipGain: 0.3,  impactF: 1050, impactBody: 88, impactLp: 3000 },
    teleprinter: { staged: true, keyF: 4300, bodyF: 1780, wave: 'square',   keyDur: 0.032, doubleClick: true, travel: 0.304, sweepF: 4600, sweepEnd: 2400, sweepGain: 0.17, sweepLp: 7600, zipF: 3900, zipGap: 0.016, zipCount: 19, zipGain: 0.25, impactF: 1950, impactBody: 165, impactLp: 5200 },
    portable:    { staged: true, keyF: 3650, bodyF: 1380, wave: 'triangle', keyDur: 0.036, travel: 0.306, sweepF: 4050, sweepEnd: 1950, sweepGain: 0.165, sweepLp: 7000, zipF: 3350, zipGap: 0.018, zipCount: 17, zipGain: 0.26, impactF: 1750, impactBody: 142, impactLp: 4800 }
  };

  function activeSoundProfile() { return SOUND_PROFILES[soundProfile] || SOUND_PROFILES.classic; }

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
  function ratchetClick(v, t, gain, freq, steady) {
    noiseBurst(v, {
      t: t, freq: freq, type: 'bandpass', q: 4.5,
      dur: 0.022, gain: gain, atk: 0.0015, lp: 3400
    });
    partial(v, { t: t, freq: freq * 0.5, type: 'triangle', dur: 0.03, gain: gain * 0.35, lp: 1800, jitter: !steady });
    return t + 0.03;
  }

  // ---- event synthesis -----------------------------------------------------

/* ===========================================================================
 * keystroke-v2 - replacement text for the keystroke family in app.js
 *
 * REPLACES (delete these from app.js, paste this block in their place):
 *   - function synthKey(kind)            [app.js, in the "event synthesis"
 *                                         section, currently the first
 *                                         function after ratchetClick]
 *   That is the only existing function removed. synthKey keeps its exact
 *   name and signature, so play()'s 'key' / 'space' / 'railKey' cases and
 *   the rest of the engine need no edits.
 *
 * NEW HELPERS ADDED (all defined below, all used only by the keystroke
 * family; insert them immediately before synthKey, i.e. after ratchetClick
 * and before the "---- event synthesis ----" work that follows):
 *   - function strikeModes(v, o)   modal resonator bank driven by one short
 *                                  noise excitation. The core of the new
 *                                  strike sound.
 *   - function KEY_CLASSES         plain data object, no function calls at
 *                                  definition time, safe to hoist anywhere
 *                                  inside createAudioEngine().
 *   - function keyVariant(kind)    per-class variant table lookup, wraps the
 *                                  existing pickVariant().
 *
 * Uses only existing engine helpers: rnd, clamp, rateJitter, gainJitter,
 * pickVariant, pickNoise, newVoice, trackSource, env, noiseBurst, partial,
 * busWet/busDry via newVoice(end, dry), ctx. No master-chain or API change.
 *
 * SYNTHESIS MODEL
 * A typebar strike is a struck object, not a filtered noise puff, so the
 * body is now a modal resonator: one very short noise excitation (roughly 2
 * to 5 ms, ramped rather than stepped) feeds a small bank of high-Q bandpass
 * filters tuned to inharmonic ratios. Each mode has its own post-filter gain
 * envelope, so the ring decays fast and unevenly the way struck steel does.
 * Three events in sequence, timing first, timbre second:
 *   1. key lever bottoming out                       t + 0
 *   2. typebar into the platen, the loud part        t + 4 to 14 ms
 *   3. typebar falling back onto the segment         t + 30 to 70 ms
 * ========================================================================= */

  /* One short noise excitation into a bank of inharmonic bandpass resonators.
     This is the struck-metal core: the filters ring, the envelopes cut the
     ring short, and the excitation is far too brief to read as noise.

     o:
       t        start time
       f0       fundamental mode frequency (before jitter)
       ratios   array of inharmonic mode ratios, low to high
       gains    array of per-mode gain weights, same length as ratios
       decays   array of per-mode decay lengths, same length as ratios
       q        base Q for the fundamental; higher modes get more
       gain      overall peak
       atk      envelope attack (never 0, an instant step reads as a digital click)
       lp       excitation brightness ceiling
       exc      excitation length in seconds
       rate     optional excitation playback rate scale                       */
  function strikeModes(v, o) {
    var t = o.t;

    var src = ctx.createBufferSource();
    src.buffer = pickNoise();
    src.playbackRate.value = (o.rate || 1) * rateJitter();

    // Excitation colouring. One filter shared by every mode.
    var tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = clamp(o.lp || 5000, 200, 9000);
    tone.Q.value = 0.5;

    // The hammer contact itself: a couple of milliseconds, ramped up over
    // half a millisecond so there is no step discontinuity.
    var exLen = o.exc === undefined ? 0.003 : o.exc;
    var exc = ctx.createGain();
    exc.gain.setValueAtTime(0.0001, t);
    exc.gain.linearRampToValueAtTime(1, t + 0.0006);
    exc.gain.exponentialRampToValueAtTime(0.0001, t + 0.0006 + exLen);
    exc.gain.setValueAtTime(0, t + 0.0006 + exLen + 0.001);

    src.connect(tone);
    tone.connect(exc);

    // One gain jitter for the whole strike, so the mode balance stays intact.
    var peak = o.gain * gainJitter();
    var end = t;
    for (var i = 0; i < o.ratios.length; i++) {
      var f = clamp(o.f0 * o.ratios[i] * rnd(0.994, 1.006), 40, 8000);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      // Narrower bands higher up: short, bright, metallic partials.
      bp.Q.value = clamp((o.q || 34) * (1 + i * 0.3), 1, 90);

      var g = ctx.createGain();
      var e = env(g.gain, t, peak * o.gains[i], o.atk || 0.0025, o.decays[i]);
      if (e > end) end = e;

      exc.connect(bp);
      bp.connect(g);
      g.connect(v.gain);
    }

    // The source has to outlive the ring: trackSource kills the voice gain
    // once every source has ended, and the resonators are still sounding
    // long after the excitation envelope has closed to zero.
    var offset = Math.random() * 0.35;
    try { src.start(t, offset, (end - t) + 0.02); } catch (e) { src.start(t); }
    trackSource(v, src, end + 0.03);
    return end;
  }

  /* Per key class geometry. Letter keys are a light typebar into a hard
     rubber platen; space is a wide, slow lever with more mechanism rattle
     and less platen ring; rail keys are a heavy function lever that thunks
     and never reaches a platen at all. */
  var KEY_CLASSES = {
    letter: {
      f0: [820, 1080],
      ratios: [1, 2.42, 4.17],   // inharmonic, plate-like, not a harmonic series
      gains: [0.88, 0.62, 0.38],
      decays: [0.042, 0.024, 0.012],
      q: 42,
      exc: 0.0018,
      gain: 0.84,
      lp: 6200,
      atk: 0.0012,
      delay: [0.004, 0.008],     // lever bottoming out to typebar contact
      click: 0.09, clickF: 2200, clickLp: 6000,
      thump: [150, 190], thumpG: 0.065, thumpDur: 0.045,
      ret: [0.032, 0.062],       // typebar falling back on the segment
      retF: [1900, 2700], retG: 0.075,
      rattle: 0
    },
    space: {
      f0: [330, 430],
      ratios: [1, 2.18, 3.61],
      gains: [0.9, 0.38, 0.15],
      decays: [0.095, 0.05, 0.026],
      q: 26,
      exc: 0.0045,
      gain: 0.72,
      lp: 2100,
      atk: 0.0032,
      delay: [0.009, 0.015],
      click: 0.05, clickF: 520, clickLp: 1000,
      thump: [96, 124], thumpG: 0.15, thumpDur: 0.1,
      ret: [0.042, 0.078],
      retF: [1150, 1650], retG: 0.05,
      rattle: 2                  // wide bar, sloppy linkage
    },
    rail: {
      f0: [240, 320],
      ratios: [1, 2.05, 3.28],
      gains: [0.85, 0.3, 0.1],
      decays: [0.12, 0.055, 0.024],
      q: 20,
      exc: 0.005,
      gain: 0.68,
      lp: 1450,
      atk: 0.0038,
      delay: [0.010, 0.018],
      click: 0.055, clickF: 430, clickLp: 900,
      thump: [72, 92], thumpG: 0.18, thumpDur: 0.13,
      ret: [0.055, 0.095],
      retF: [780, 1080], retG: 0.045,
      rattle: 1                  // a lever thunk, no typebar to fall back
    }
  };

  /* Five non-repeating variants per key class. Each shifts the modal tuning,
     the decay length, the brightness and the mode balance, so consecutive
     strikes differ in shape and not just in level. */
  var KEY_VARIANTS = [
    { shift: 1.00, decay: 1.00, tone: 1.00, tilt: 1.00 },
    { shift: 1.13, decay: 0.84, tone: 1.10, tilt: 1.18 },
    { shift: 0.89, decay: 1.20, tone: 0.90, tilt: 0.84 },
    { shift: 1.06, decay: 0.93, tone: 1.04, tilt: 0.92 },
    { shift: 0.94, decay: 1.11, tone: 0.94, tilt: 1.09 }
  ];

  function keyVariant(kind) {
    return KEY_VARIANTS[pickVariant('key-' + kind, KEY_VARIANTS.length)];
  }

  /* The four promoted sound-stage profiles deliberately use the prototype's
     dry pulse topology. This keeps their oscillator shapes and timing audible
     instead of washing them through the default modal-resonator bank. */
  function synthProfileKey(profile) {
    var t = ctx.currentTime + 0.001;
    var v = newVoice(t + 0.12, true);
    noiseBurst(v, { t: t, freq: profile.keyF, type: 'bandpass', q: 7, dur: 0.018, gain: 0.32, atk: 0.001, lp: Math.min(8200, profile.keyF * 1.8) });
    partial(v, { t: t + 0.002, freq: profile.bodyF, type: profile.wave, dur: profile.keyDur, gain: 0.22, atk: 0.001, lp: Math.min(6200, profile.bodyF * 3), jitter: false });
    if (profile.doubleClick) {
      noiseBurst(v, { t: t + 0.008, freq: profile.keyF * 1.16, type: 'bandpass', q: 8, dur: 0.01, gain: 0.2, atk: 0.0007, lp: 8500 });
    }
    noiseBurst(v, { t: t + 0.028, freq: profile.keyF * 0.72, type: 'bandpass', q: 8, dur: 0.012, gain: 0.13, atk: 0.0008, lp: 6500 });
  }

  /* Keystroke family - 'letter', 'space', 'rail'.
     Three events in quick succession: the key lever bottoming out, the
     typebar striking the platen a few milliseconds later (the loud part,
     a modal resonator bank), and the typebar dropping back onto the segment
     30 to 70 ms later as a quieter, higher, metallic tick. */
  function synthKey(kind) {
    var t = ctx.currentTime + 0.001;
    var cfg = KEY_CLASSES[kind] || KEY_CLASSES.letter;
    var vr = keyVariant(kind);
    var profile = activeSoundProfile();
    if (kind === 'letter' && profile.staged) { synthProfileKey(profile); return; }
    if (profile.staged) { profile = SOUND_PROFILES.classic; }

    var f0 = rnd(cfg.f0[0], cfg.f0[1]) * vr.shift * profile.keyPitch;
    var lp = cfg.lp * vr.tone * profile.keyTone;
    var strikeAt = t + rnd(cfg.delay[0], cfg.delay[1]);
    var retAt = t + rnd(cfg.ret[0], cfg.ret[1]);

    // Mode gains tilted per variant: higher variants ring brighter up top.
    var gains = [
      cfg.gains[0] * profile.keyGain,
      cfg.gains[1] * vr.tilt * profile.keyGain,
      cfg.gains[2] * vr.tilt * vr.tilt * profile.keyGain
    ];
    var decays = [
      cfg.decays[0] * vr.decay * profile.keyDecay,
      cfg.decays[1] * vr.decay * profile.keyDecay,
      cfg.decays[2] * vr.decay * profile.keyDecay
    ];

    var end = Math.max(strikeAt + decays[0] + 0.06, retAt + 0.09);
    var v = newVoice(end, false);

    // 1. the key lever bottoming out. Soft, low, no high end at all, and it
    //    only exists to give the strike a leading edge.
    noiseBurst(v, {
      t: t, freq: cfg.clickF * vr.shift * profile.keyPitch, type: kind === 'letter' ? 'bandpass' : 'lowpass', q: kind === 'letter' ? 2.8 : 0.8,
      dur: kind === 'letter' ? 0.008 : 0.013, gain: cfg.click * profile.clickGain, atk: kind === 'letter' ? 0.0008 : 0.0025,
      lp: cfg.clickLp * profile.keyTone
    });

    // 2. the typebar into the platen: the struck-object body.
    strikeModes(v, {
      t: strikeAt, f0: f0, ratios: cfg.ratios, gains: gains, decays: decays,
      q: cfg.q, gain: cfg.gain, atk: cfg.atk, lp: lp, exc: cfg.exc
    });

    //    Low body under it: the frame and the desk taking the blow.
    partial(v, {
      t: strikeAt, freq: rnd(cfg.thump[0], cfg.thump[1]), type: 'sine',
      dur: cfg.thumpDur * profile.keyDecay, gain: cfg.thumpG * profile.keyGain, atk: 0.004, lp: 620 * profile.keyTone
    });

    //    Mechanism rattle for the sloppier levers (space bar, rail keys).
    for (var i = 0; i < cfg.rattle; i++) {
      noiseBurst(v, {
        t: strikeAt + rnd(0.008, 0.034), freq: rnd(620, 1250),
        type: 'bandpass', q: 3.5, dur: rnd(0.014, 0.026),
        gain: 0.026, atk: 0.002, lp: 2400
      });
    }

    // 3. the typebar falling back against the segment: quieter, higher, and
    //    unmistakably metal on metal.
    strikeModes(v, {
      t: retAt, f0: rnd(cfg.retF[0], cfg.retF[1]) * vr.shift * profile.keyPitch,
      ratios: [1, 2.31], gains: [1, 0.4],
      decays: [0.022 * vr.decay * profile.keyDecay, 0.013 * vr.decay * profile.keyDecay],
      q: 26, gain: cfg.retG * profile.keyGain, atk: 0.0018,
      lp: 5200 * profile.keyTone, exc: 0.0016
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

  function synthLeverToggle() {
    var t = ctx.currentTime + 0.001;
    var v = newVoice(t + 0.09, true);
    noiseBurst(v, { t: t, freq: 1850, type: 'bandpass', q: 3.8, dur: 0.025, gain: 0.15, atk: 0.001, lp: 4200 });
    partial(v, { t: t, freq: 720, type: 'triangle', dur: 0.045, gain: 0.07, atk: 0.0015, lp: 2200, jitter: false });
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
    var profile = activeSoundProfile();
    if (profile.staged) { synthProfileReturn(profile, t); return; }
    var travel = profile.travel;
    var v = newVoice(t + travel + 0.5, false);

    noiseBurst(v, {
      t: t, freq: profile.sweepF, sweep: profile.sweepEnd, type: 'bandpass', q: 2.2,
      dur: travel * 0.72, hold: travel * 0.22, gain: profile.sweepGain, atk: 0.002, lp: profile.sweepLp
    });
    noiseBurst(v, {
      t: t, freq: 620, type: 'lowpass', dur: travel * 0.5, hold: travel * 0.35,
      gain: 0.045, atk: 0.004, lp: 1300
    });
    // Teeth passing under the carriage pawl: keep them close and dry so the
    // continuous travel wash and room reverb cannot mask the zipper rhythm.
    var zipper = newVoice(t + travel + 0.05, true);
    for (var zi = 0; zi < profile.zipCount; zi++) {
      noiseBurst(zipper, {
        t: t + 0.018 + zi * profile.zipGap, freq: profile.zipF + (zi % 3) * 210,
        type: 'bandpass', q: 6.2, dur: Math.min(0.014, profile.zipGap * 0.7), gain: profile.zipGain,
        atk: 0.0008, lp: Math.min(7800, profile.zipF * 1.7)
      });
    }
    // Crisp, repeatable margin-stop snap.
    var st = t + travel;
    noiseBurst(v, { t: st, freq: profile.impactF, type: 'bandpass', q: 2.4, dur: 0.045, gain: 0.28, atk: 0.0015, lp: profile.impactLp });
    partial(v, { t: st, freq: profile.impactBody, type: 'triangle', dur: 0.075, gain: 0.12, lp: 900, jitter: false });
    // overlapping line advance
    lineAdvanceInto(v, st - 0.025, true);
  }

  function synthProfileReturn(profile, t) {
    var travel = profile.travel;
    var wash = newVoice(t + travel + 0.2, false);
    noiseBurst(wash, {
      t: t, freq: profile.sweepF, sweep: profile.sweepEnd,
      type: 'bandpass', q: 2.2, dur: travel * 0.78,
      hold: travel * 0.16, gain: profile.sweepGain, atk: 0.002, lp: profile.sweepLp
    });

    var rack = newVoice(t + travel + 0.08, true);
    for (var i = 0; i < profile.zipCount; i++) {
      var at = t + 0.012 + i * profile.zipGap;
      var tooth = profile.zipF + (i % 3) * 230;
      noiseBurst(rack, { t: at, freq: tooth, type: 'bandpass', q: 9, dur: 0.011, gain: profile.zipGain, atk: 0.0007, lp: Math.min(8500, tooth * 1.8) });
      partial(rack, { t: at, freq: profile.zipF * 0.34, type: 'square', dur: 0.018, gain: 0.08, atk: 0.0008, lp: 3200, jitter: false });
    }

    var stop = t + travel;
    noiseBurst(rack, { t: stop, freq: profile.impactF, type: 'bandpass', q: 4, dur: 0.045, gain: 0.42, atk: 0.001, lp: profile.impactLp });
    partial(rack, { t: stop, freq: profile.impactBody, type: 'triangle', dur: 0.085, gain: 0.3, atk: 0.0015, lp: 1000, jitter: false });
    lineAdvanceInto(rack, stop - 0.02, true);
  }

  function lineAdvanceInto(v, t, steady) {
    var n = steady ? 3 : 3 + Math.floor(Math.random() * 2);
    var p = t;
    for (var i = 0; i < n; i++) {
      ratchetClick(v, p, 0.085 * (1 - i * 0.12), steady ? 1080 : rnd(900, 1250), steady);
      p += steady ? 0.019 : rnd(0.016, 0.026);
    }
    partial(v, { t: t + 0.02, freq: 132, type: 'sine', dur: 0.10, gain: 0.09, lp: 600, jitter: !steady });
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
        // resume() is asynchronous, but the gesture that triggered it is the
        // same keydown that is about to ask for a sound. Without holding the
        // promise the first keystroke lands while state is still 'suspended'
        // and plays nothing. Queue instead, and flush the moment it runs.
        if (!resuming) {
          resuming = true;
          var p = ctx.resume();
          if (p && p.then) {
            p.then(flushPending, function () { resuming = false; pending.length = 0; });
          } else {
            flushPending();   // older implementations resume synchronously
          }
        }
      }
    } catch (e) {
      // A synchronous throw out of resume() would otherwise leave `resuming`
      // latched true with sounds stranded in the queue.
      resuming = false;
      pending.length = 0;
      ctx = null;
      ready = false;
    }
  }

  // Sounds asked for during the resume window, replayed once it completes.
  var resuming = false;
  var pending = [];

  function flushPending() {
    resuming = false;
    var queued = pending.slice();
    pending.length = 0;
    // Sound may have been switched off, or the context torn down, between
    // queueing and the resume completing.
    if (!ready || !ctx || !enabled || ctx.state !== 'running') { return; }
    queued.forEach(function (q) { playNow(q.name, q.opts); });
  }

  function play(name, opts) {
    // Before unlock this is a silent no-op and never throws.
    if (!ready || !ctx || !enabled) return;
    if (ctx.state !== 'running') {
      // Cap the queue: a held key during a slow resume must not stack up a
      // burst that all fires at once when the context finally starts.
      if (resuming && pending.length < 6) { pending.push({ name: name, opts: opts }); }
      return;
    }
    playNow(name, opts);
  }

  function playNow(name, opts) {
    try {
      switch (name) {
        case 'key':          synthKey('letter'); break;
        case 'space':        synthKey('space'); break;
        case 'railKey':      synthKey('rail'); break;
        case 'carriageStep': synthCarriageStep(); break;
        case 'leverToggle':  synthLeverToggle(); break;
        case 'bell':         synthBell(); break;
        case 'return':       synthReturn(); break;
        case 'lineAdvance':  synthLineAdvance(); break;
        case 'paperFeed':    synthPaperFeed(1, 1); break;
        case 'whiteout':     synthWhiteout(); break;
        case 'ribbonTick':   synthRibbonTick(); break;
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

  function setProfile(name) {
    soundProfile = SOUND_PROFILES[name] ? name : 'classic';
    lastVariant = {};
  }

  return {
    unlock: unlock,
    play: play,
    setEnabled: setEnabled,
    setVolume: setVolume,
    setProfile: setProfile
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
    setEnabled: function () {}, setVolume: function () {}, setProfile: function () {}
  };

  /* ---------------------------------------------------------------- config */

  var COLS = 65;
  var MIN_ROWS = 54;
  var ROW_GROWTH = 20;
  var documentRows = MIN_ROWS;
  var BELL_AT = COLS - 8;           // bell rings this many cells before the margin

  /* The build version, stamped onto the maker's plate on the front of the
     machine instead of a model name. Bumped at push time, see CLAUDE.md. */
  var APP_VERSION = '0.01';

  var STORAGE_KEY = 'typewriter:v1';
  var PREFS_KEY = 'typewriter:prefs:v1';

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
  var slip = $('#status-slip');
  var versionPlate = $('#version-plate');

  if (versionPlate) versionPlate.textContent = 'VERSION ' + APP_VERSION;

  // Everything is announced. Only failures are also shown.
  //
  // Success already has a channel the spec is emphatic about: the key
  // stamps, the sheet visibly clears, the card shows the new setting.
  // Section 8 of docs/realism-prompt.md rules out a toast for those, and a
  // machine that popped a receipt after every keypress would be wrong.
  // Failure had no channel at all - "could not copy", or a save refused
  // because localStorage is full, reached nobody who was not running a
  // screen reader, which is precisely backwards. Those pass show=true and
  // surface as a slip of paper on the desk.
  // Two separate elements on purpose. The live region has to be rewritten
  // by every message or it stops announcing, and several handlers report a
  // failure and then immediately announce what they did anyway - toggling
  // Realism Mode saves prefs, then describes the new mode. Sharing one
  // element meant that second message tore the failure slip off the screen
  // before it could be read. The slip is written only when show is true, so
  // an announce-only message can no longer erase one.
  var statusTimer = 0;
  function say(msg, show) {
    status.textContent = msg;
    if (!show) { return; }
    slip.textContent = msg;
    slip.classList.add('is-showing');
    window.clearTimeout(statusTimer);
    // Text stays after the fade; there is nothing reading it, and clearing
    // it would make the slip empty mid-transition.
    statusTimer = window.setTimeout(function () {
      slip.classList.remove('is-showing');
    }, 3400);
  }

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
    softBreaks: Object.create(null), // row -> true when the line ended by wrapping, not by return
    sheetNo: 1
  };

  /* False only for pages restored from a save written before soft breaks were
     recorded; those fall back to a line-length guess when reflowing. */
  var softBreaksKnown = true;

  var history = [];               // undo stack
  var carriage = { row: 0, col: 0 };
  var bellRungThisLine = false;
  var automaticWrapFromRow = null;

  function setDocumentRows(requiredRows) {
    documentRows = MIN_ROWS;
    while (documentRows < requiredRows) { documentRows += ROW_GROWTH; }
    document.documentElement.style.setProperty('--rows', documentRows);
  }

  function ensureRowsFor(row) {
    // Keep ten blank lines below the carriage so growth happens off-screen.
    if (row + 10 < documentRows) { return; }
    setDocumentRows(row + 11);
  }

  function cellKey(row, col) { return row + ',' + col; }

  function getCell(row, col, create) {
    var k = cellKey(row, col);
    var c = page.cells[k];
    if (!c && create) { c = page.cells[k] = { impressions: [], patched: false }; }
    return c;
  }

  function realismOn() { return document.body.dataset.realism === 'on'; }

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

    // Ink density: mostly strong, occasionally faint.
    var roll = rand();
    var alpha = 0.72 + Math.pow(roll, 0.45) * 0.28;
    var blur = 0.3 + rand() * 0.3;

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
      if (c.patched) {
        c.patchEl = makePatchEl(c.patchRow, c.patchCol, c.patchSeed);
        patchLayer.appendChild(c.patchEl);
      } else {
        c.patchEl = null;
      }
      c.impressions.forEach(function (imp) { inkLayer.appendChild(makeImpressionEl(imp)); });
    });
  }

  /* -------------------------------------------------------------- carriage
     Fixed strike point: the active cell stays put on screen and the sheet
     translates under it. */

  // Cell metrics and the strike point both live in CSS. Measure rather than
  // duplicate the numbers, so the two files can never drift apart.
  var metrics = { cw: 19.2, ch: 32, mx: 0, my: 0, gx: 0, gy: 0, assemblyW: 0, vpW: 0 };

  // Cached because updateSheet() runs on every carriage move and must not
  // read layout. Resolved once here; relayout() refreshes them.
  var machineEl = $('#machine');
  var assemblyEl = $('#platen-assembly');
  var knobEl = $('#platen-knob');
  var viewportEl = $('#sheet-viewport');

  function measure() {
    // Do NOT read --cell-w and friends with getPropertyValue: custom
    // properties come back as the unresolved token ("calc(9.6px * 2)"), so
    // parseFloat silently returns the first number in the expression. Measure
    // the laid-out geometry instead. #ink-layer is exactly the character grid,
    // inset from the sheet by the paper margins, so it gives all four numbers.
    var sheetRect = sheet.getBoundingClientRect();
    var inkRect = inkLayer.getBoundingClientRect();
    var vp = viewportEl.getBoundingClientRect();
    var g = $('#type-guide').getBoundingClientRect();

    // Read here so updateSheet() stays write-only. These change on resize and
    // on font load, both of which already come through relayout().
    metrics.assemblyW = assemblyEl.getBoundingClientRect().width;
    metrics.vpW = vp.width;

    if (inkRect.width > 0) {
      metrics.cw = inkRect.width / COLS;
      metrics.ch = inkRect.height / documentRows;
      metrics.mx = inkRect.left - sheetRect.left;
      metrics.my = inkRect.top - sheetRect.top;
    }

    // Where the type guide sits, in viewport-local coordinates.
    if (g.width > 0) {
      metrics.gx = (g.left + g.width / 2) - vp.left;
      metrics.gy = (g.top + g.height / 2) - vp.top;
    } else {
      metrics.gx = vp.width * 0.5;
      metrics.gy = vp.height * 0.12;
    }
  }

  function updateSheet() {
    // The active cell's center is pinned to the type guide; the sheet moves.
    var x = metrics.gx - metrics.mx - (carriage.col + 0.5) * metrics.cw;
    var y = metrics.gy - metrics.my - (carriage.row + 0.5) * metrics.ch;
    sheet.style.setProperty('--sheet-x', x.toFixed(2) + 'px');
    sheet.style.setProperty('--sheet-y', y.toFixed(2) + 'px');

    // The paper and platen live on the same carriage. Align their translated
    // edges with 48px of roller hardware beyond each side of the sheet.
    // Widths come from the cache: reading them here would force a synchronous
    // layout on every keystroke, against the sub-30ms strike budget.
    var platenX = x + (metrics.assemblyW - metrics.vpW) / 2 - 48;
    // On #machine, not on the assembly: both carriage layers inherit it.
    machineEl.style.setProperty('--platen-x', platenX.toFixed(2) + 'px');
    knobEl.style.setProperty('--platen-roll', (carriage.row * 6).toFixed(1) + 'px');
  }

  function relayout() { measure(); updateSheet(); }

  // Two class names carrying two identically-shaped keyframes. Swapping
  // between them restarts the animation; removing and re-adding one class in
  // the same frame does not, which is why the old code needed an offsetWidth
  // read to force a reflow on every single strike.
  var shudderFlip = false;
  function shudder() {
    if (reduceMotion.matches) { return; }
    shudderFlip = !shudderFlip;
    sheet.classList.toggle('is-struck', shudderFlip);
    sheet.classList.toggle('is-struck-b', !shudderFlip);
  }

  function moveTo(row, col, silent, keepPaperSize) {
    row = Math.max(0, row);
    col = Math.max(0, Math.min(COLS - 1, col));
    if (!keepPaperSize) { ensureRowsFor(row); }
    if (row === carriage.row && col === carriage.col) { return; }
    if (row !== carriage.row) { bellRungThisLine = false; }
    carriage.row = row;
    carriage.col = col;
    automaticWrapFromRow = null;
    updateSheet();
    if (!silent) { Sound.play('carriageStep'); }
    // The carriage position is part of the saved page, and the early return
    // above means this only fires when it actually moved.
    scheduleAutosave();
  }

  function advance() {
    if (carriage.col >= COLS - 1) {
      // Both modes continue onto the endless sheet. The friendly mode may
      // move the trailing word on the next strike; Realism Mode leaves it
      // split exactly where the margin stopped it.
      carriageReturn(true);
      return;
    }
    carriage.col++;
    if (!bellRungThisLine && carriage.col >= BELL_AT) {
      bellRungThisLine = true;
      Sound.play('bell');
    }
    updateSheet();
  }

  function carriageReturn(automatic) {
    var previousRow = carriage.row;
    var previousCol = carriage.col;
    var previousSoft = page.softBreaks[previousRow] === true;
    carriage.col = 0;
    carriage.row++;
    ensureRowsFor(carriage.row);
    bellRungThisLine = false;
    updateSheet();
    // synthReturn / synthProfileReturn already end in lineAdvanceInto, so the
    // ratchet is part of this sample. Scheduling a second one here played
    // every carriage return twice.
    Sound.play('return');
    // Automatic wrapping is part of the strike, not a separate undo step.
    // Record where the carriage actually was, and the soft-break flag this
    // return is about to overwrite, so undo can put both back.
    if (!automatic) {
      history.push({ type: 'return', row: previousRow, col: previousCol, soft: previousSoft });
    }
    automaticWrapFromRow = automatic ? previousRow : null;
    // A wrapped line belongs to the same paragraph as the next one; a thrown
    // lever ends the line on purpose. Copy and export use this to reflow.
    if (automatic) { page.softBreaks[previousRow] = true; }
    else { delete page.softBreaks[previousRow]; }

    var lever = $('#carriage-lever');
    lever.classList.add('is-thrown');
    window.setTimeout(function () { lever.classList.remove('is-thrown'); }, 220);
    scheduleAutosave();
  }

  /* ----------------------------------------------------------------- input */

  function cellEndsWithWordCharacter(row, col) {
    var cell = getCell(row, col, false);
    if (!cell || !cell.impressions.length) { return false; }
    return cell.impressions[cell.impressions.length - 1].ch !== ' ';
  }

  // One pass over history for a whole batch of moved cells. Doing it per cell
  // made a word wrap cost O(word length x history length).
  function remapHistoryCells(map) {
    history.forEach(function (op) {
      if (op.type !== 'strike' && op.type !== 'patch') { return; }
      var to = map[cellKey(op.row, op.col)];
      if (to) { op.row = to[0]; op.col = to[1]; }
    });
  }

  // `moved` collects fromKey -> [toRow, toCol] for a later remapHistoryCells.
  function moveCell(fromRow, fromCol, toRow, toCol, moved) {
    var fromKey = cellKey(fromRow, fromCol);
    var cell = page.cells[fromKey];
    if (!cell) { return; }

    var target = getCell(toRow, toCol, true);
    target.impressions = target.impressions.concat(cell.impressions);
    cell.impressions.forEach(function (imp) {
      imp.row = toRow;
      imp.col = toCol;
      if (imp.el) {
        imp.el.style.setProperty('--row', toRow);
        imp.el.style.setProperty('--col', toCol);
      }
    });
    if (cell.patched) {
      if (target.patched) {
        // The destination already carries its own patch. Overwriting its
        // coordinates and seed would silently replace that patch's identity,
        // so drop the arriving one instead: the cell is covered either way.
        if (cell.patchEl && cell.patchEl.parentNode) { cell.patchEl.parentNode.removeChild(cell.patchEl); }
      } else {
        target.patched = true;
        target.patchRow = toRow;
        target.patchCol = toCol;
        target.patchSeed = cell.patchSeed;
        target.patchEl = cell.patchEl;
        if (target.patchEl) {
          target.patchEl.style.setProperty('--row', toRow);
          target.patchEl.style.setProperty('--col', toCol);
        }
      }
    }
    moved[fromKey] = [toRow, toCol];
    delete page.cells[fromKey];
  }

  function wrapTrailingWord(ch) {
    if (realismOn() || automaticWrapFromRow === null || carriage.col !== 0) {
      automaticWrapFromRow = null;
      return;
    }

    var sourceRow = automaticWrapFromRow;
    automaticWrapFromRow = null;
    if (ch === ' ' || !cellEndsWithWordCharacter(sourceRow, COLS - 1)) { return; }

    var start = COLS - 1;
    while (start > 0 && cellEndsWithWordCharacter(sourceRow, start - 1)) { start--; }
    if (start === 0) { return; } // A word wider than the page must be split.

    var wordLength = COLS - start;
    ensureRowsFor(carriage.row);
    var moved = Object.create(null);
    for (var col = start; col < COLS; col++) {
      moveCell(sourceRow, col, carriage.row, col - start, moved);
    }
    remapHistoryCells(moved);
    carriage.col = wordLength;
    // moveCell repositions the impression and patch nodes it moves, so there
    // is nothing left to rebuild. A full renderAll() here rebuilt the entire
    // grid mid-keystroke, against the spec's no-full-rerender rule.
    renderPatchesIfStale();
    updateSheet();
  }

  function strike(ch) {
    wrapTrailingWord(ch);
    var cell = getCell(carriage.row, carriage.col, true);
    var imp = {
      ch: ch,
      col: carriage.col,
      row: carriage.row,
      seed: newSeed(),
      ink: 'black'
    };
    cell.impressions.push(imp);
    inkLayer.appendChild(makeImpressionEl(imp));
    history.push({ type: 'strike', row: imp.row, col: imp.col });

    Sound.play(ch === ' ' ? 'space' : 'key');
    Sound.play('ribbonTick');
    shudder();
    advance();
    scheduleAutosave();
  }

  // Carriage back one cell, ink untouched.
  function carriageBack() {
    if (carriage.col === 0) { return; }
    carriage.col--;
    updateSheet();
    Sound.play('carriageStep');
    scheduleAutosave();
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
      cell.patchEl = makePatchEl(cell.patchRow, cell.patchCol, cell.patchSeed);
      patchLayer.appendChild(cell.patchEl);
    }
    history.push({ type: 'patch', row: carriage.row, col: carriage.col, covered: covered, wasPatched: wasPatched });
    Sound.play('whiteout');
    scheduleAutosave();
  }

  function undo() {
    var op = history.pop();
    if (!op) { return; }
    if (op.type === 'strike') {
      var cell = getCell(op.row, op.col, false);
      if (cell && cell.impressions.length) {
        var imp = cell.impressions.pop();
        if (imp.el && imp.el.parentNode) { imp.el.parentNode.removeChild(imp.el); }
      }
      moveTo(op.row, op.col, true);
      updateSheet();
    } else if (op.type === 'patch') {
      var c = getCell(op.row, op.col, true);
      if (!op.wasPatched) {
        c.patched = false;
        // Held directly on the cell. The old lookup matched on --col alone,
        // so two patches in different rows sharing a column made undo remove
        // whichever the selector reached first.
        if (c.patchEl && c.patchEl.parentNode) { c.patchEl.parentNode.removeChild(c.patchEl); }
        c.patchEl = null;
      }
      c.impressions = op.covered;
      c.impressions.forEach(function (i) { inkLayer.appendChild(makeImpressionEl(i)); });
      moveTo(op.row, op.col, true);
    } else if (op.type === 'return') {
      var backRow = op.row !== undefined ? op.row : carriage.row - 1;
      var backCol = op.col !== undefined ? op.col : COLS - 1;
      // The return cleared or set this flag on the way out; put it back, or
      // copy and export keep reflowing the paragraph as if the line wrapped.
      if (op.soft) { page.softBreaks[backRow] = true; }
      else { delete page.softBreaks[backRow]; }
      moveTo(backRow, backCol, true);
    }
    Sound.play('undo');
    renderPatchesIfStale();
    scheduleAutosave();
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

  var keyCatcher = $('#key-catcher');

  document.addEventListener('keydown', function (e) {
    if (!card.hidden || !carbon.hidden) { return; }              // dialogs own the keyboard
    // Mid-composition keystrokes belong to the IME, not the page. The
    // committed text arrives later as an input event on the key catcher.
    if (e.isComposing || e.keyCode === 229) { return; }
    var t = e.target;
    // The key catcher is a real <input>, but it is this app's typing surface,
    // so it must not be treated as a form field to stay out of.
    if (t && t !== keyCatcher &&
        (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) { return; }

    Sound.unlock();

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    // X-out (spec section 7): a held modifier turns x and / into overstrikes
    // laid straight over whatever is already in the cell, the traditional
    // fast correction. Alt rather than Ctrl, which is Cut.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'x' || e.key === 'X' || e.key === '/')) {
      e.preventDefault();
      strike(e.key === '/' ? '/' : 'x');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) { return; }

    switch (e.key) {
      case 'Backspace':
        e.preventDefault();
        // Realism Mode flips these two bindings. That is the whole difference.
        if (realismOn() ? e.shiftKey : !e.shiftKey) { whiteOut(); } else { carriageBack(); }
        return;
      case 'Enter':      e.preventDefault(); carriageReturn(); return;
      case 'ArrowLeft':
        e.preventDefault();
        if (carriage.col === 0 && carriage.row > 0) {
          var previousEnd = 0;
          for (var pc = COLS - 1; pc >= 0; pc--) {
            var previousCell = getCell(carriage.row - 1, pc, false);
            // A whited-out cell has no impressions but is not empty: the line
            // still runs through it, so navigation must stop there too.
            if (previousCell && (previousCell.impressions.length || previousCell.patched)) {
              previousEnd = Math.min(pc + 1, COLS - 1);
              break;
            }
          }
          moveTo(carriage.row - 1, previousEnd);
        } else {
          moveTo(carriage.row, carriage.col - 1);
        }
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (carriage.col === COLS - 1) { moveTo(carriage.row + 1, 0); }
        else { moveTo(carriage.row, carriage.col + 1); }
        return;
      case 'ArrowUp':    e.preventDefault(); moveTo(carriage.row - 1, carriage.col); return;
      case 'ArrowDown':  e.preventDefault(); moveTo(carriage.row + 1, carriage.col); return;
      case 'PageUp':     e.preventDefault(); moveTo(0, carriage.col); return;
      case 'PageDown':   e.preventDefault(); moveTo(documentRows - 1, carriage.col, false, true); return;
      case 'Home':       e.preventDefault(); moveTo(carriage.row, 0); return;
      case 'End':        e.preventDefault(); moveTo(carriage.row, COLS - 1); return;
    }

    if (isPrintable(e)) {
      // preventDefault here is also what stops the key catcher inserting the
      // character itself, so a physical keyboard never double-strikes via the
      // input handler below.
      e.preventDefault();
      strike(e.key);
    }
  });

  /* Touch input. Software keyboards do not reliably report characters through
     keydown (Android sends 'Unidentified'), and they only appear at all while
     a real editable element holds focus. The key catcher covers both: tapping
     the sheet focuses it, and whatever it receives is replayed through the
     same strike path, then cleared so it never accumulates text. */

  keyCatcher.addEventListener('beforeinput', function (e) {
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward') {
      e.preventDefault();
      // Matches the unshifted Backspace binding, which the two modes swap.
      if (realismOn()) { carriageBack(); } else { whiteOut(); }
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      carriageReturn();
    }
  });

  keyCatcher.addEventListener('input', function () {
    var text = keyCatcher.value;
    keyCatcher.value = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '\n' || ch === '\r') { carriageReturn(); }
      else { strike(ch); }
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

  // Focus must move inside the gesture itself or mobile browsers refuse to
  // raise the keyboard. Harmless on desktop: the catcher is never visible and
  // the document-level keydown handler runs the same either way.
  $('#sheet-viewport').addEventListener('pointerdown', function () {
    if (!card.hidden || !carbon.hidden) { return; }
    keyCatcher.focus({ preventScroll: true });
  });

  // ...and mousedown's default action takes that focus straight back: it
  // moves focus to the nearest focusable ancestor of the target, and the
  // sheet has none, so focus lands on <body> and the software keyboard
  // never appears. Touch devices synthesise a mousedown of their own, so
  // suppressing it here is what actually makes tapping the paper work.
  // Nothing on the sheet is selectable or draggable, so no useful default
  // is lost. Guarded like the handler above: while a dialog is open the
  // sheet must not take focus off it.
  $('#sheet-viewport').addEventListener('mousedown', function (e) {
    if (!card.hidden || !carbon.hidden) { return; }
    e.preventDefault();
  });

  // The lever activates on pointerdown, not on click.
  //
  // #carriage-lever:active swings the arm 30 degrees further than :hover
  // does (style.css), so pressing it throws the grip out from under the
  // cursor before the button is released. A click event only fires when
  // the press and the release resolve to the same element, so the press
  // animation was eating its own activation: the hover and press states
  // both kept working, because they track the box rather than the event
  // pair, and then nothing happened. Throwing the lever felt dead.
  //
  // pointerdown is also the honest moment for this control - the return
  // should go with the throw, not with letting go afterwards - and it
  // covers touch, where the same swing would break a tap the same way.
  //
  // click still has to work: this is a real <button> with an accessible
  // label, and Enter and Space must return the carriage. Those arrive as
  // clicks with detail 0, which is what tells them apart from the click a
  // mouse press generates. Without that guard a single mouse press would
  // return twice, once per handler.
  var leverEl = $('#carriage-lever');

  leverEl.addEventListener('pointerdown', function (e) {
    // Primary button only. A right or middle press is not an activation.
    if (e.button !== 0) { return; }
    Sound.unlock();
    carriageReturn();
  });

  leverEl.addEventListener('click', function (e) {
    if (e.detail !== 0) { return; }
    Sound.unlock();
    carriageReturn();
  });

  /* ------------------------------------------------------------------ text */

  function pageLines() {
    var lines = [];
    for (var r = 0; r < documentRows; r++) {
      var line = '';
      for (var c = 0; c < COLS; c++) {
        var cell = page.cells[cellKey(r, c)];
        line += (cell && cell.impressions.length) ? cell.impressions[cell.impressions.length - 1].ch : ' ';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
    return lines;
  }

  // Line ended because the carriage hit the margin, not because the lever was
  // thrown. Pages saved before soft breaks were recorded fall back to a guess:
  // a line typed out to (or near) the margin was almost certainly wrapped.
  function isSoftBreak(row, line) {
    if (softBreaksKnown) { return !!page.softBreaks[row]; }
    return line.length >= COLS - 10;
  }

  /* Paper wraps, prose does not. A paragraph is emitted as one long line so
     whatever the text lands in does its own wrapping; blank lines and thrown
     levers stay as real breaks. */
  function pageText() {
    var lines = pageLines();
    var out = [];
    var paragraph = null;

    for (var r = 0; r < lines.length; r++) {
      var line = lines[r];
      if (line === '') {
        if (paragraph !== null) { out.push(paragraph); paragraph = null; }
        out.push('');
        continue;
      }

      if (paragraph === null) { paragraph = line; }
      else {
        // Realism Mode splits a word at the margin, so the halves rejoin with
        // no space between them; the friendly mode moves the whole word down.
        var glue = (/\S$/.test(paragraph) && /^\S/.test(line) && lines[r - 1].length === COLS) ? '' : ' ';
        paragraph += glue + line;
      }

      var next = lines[r + 1];
      if (!isSoftBreak(r, line) || next === undefined || next === '') {
        out.push(paragraph);
        paragraph = null;
      }
    }
    if (paragraph !== null) { out.push(paragraph); }

    return out.join('\n');
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeRtf(text) {
    return text.replace(/[\\{}]/g, '\\$&').replace(/\r?\n/g, '\\par\n').replace(/[^\x00-\x7f]/g, function (ch) {
      var code = ch.charCodeAt(0);
      return '\\u' + (code > 32767 ? code - 65536 : code) + '?';
    });
  }

  function exportDocument(format) {
    var text = pageText();
    var body = text + (text ? '\n' : '');
    var mime = 'text/markdown;charset=utf-8';

    if (format === 'html') {
      mime = 'text/html;charset=utf-8';
      body = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
        '<title>Typewriter page ' + page.sheetNo + '</title>\n' +
        '<style>body{max-width:65ch;margin:3rem auto;padding:0 1rem;font:16px/1.6 monospace;white-space:pre-wrap}</style>\n' +
        '</head>\n<body>' + escapeHtml(text) + '</body>\n</html>\n';
    } else if (format === 'rtf') {
      mime = 'application/rtf';
      body = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Courier New;}}\\f0\\fs24\n' + escapeRtf(text) + '\n}';
    } else if (format === 'txt') {
      mime = 'text/plain;charset=utf-8';
    } else {
      format = 'md';
    }

    var blob = new Blob([body], { type: mime });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'typewriter-page-' + page.sheetNo + '.' + format;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
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
      // An undone patch leaves a cell with no ink and no patch. Persisting
      // those grows the saved page forever over a long session.
      if (!c.impressions.length && !c.patched) { return; }
      cells[k] = {
        i: c.impressions.map(function (m) { return [m.ch, m.col, m.row, m.seed, 0, m.ink]; }),
        p: c.patched ? [c.patchRow, c.patchCol, c.patchSeed] : null
      };
    });
    var soft = Object.keys(page.softBreaks).map(Number).filter(isFinite);
    return { v: 1, sheetNo: page.sheetNo, rows: documentRows, cells: cells, soft: soft, carriage: carriage };
  }

  function savePage(quiet) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
      if (!quiet) { say('Saved.'); }
      return true;
    } catch (err) {
      say('Could not save.', true);
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
    page.softBreaks = Object.create(null);
    softBreaksKnown = Array.isArray(data.soft);
    if (softBreaksKnown) {
      data.soft.forEach(function (r) {
        if (typeof r === 'number' && isFinite(r) && r >= 0) { page.softBreaks[r] = true; }
      });
    }
    page.sheetNo = data.sheetNo || 1;
    var highestRow = data.carriage && data.carriage.row ? data.carriage.row : 0;

    // Anything reaching here was written by an older build of this app or
    // edited by hand. Validate each record rather than trusting the shape:
    // one bad entry should cost that cell, not the whole page.
    function validNumber(n, max) { return typeof n === 'number' && isFinite(n) && n >= 0 && n <= max; }

    Object.keys(data.cells || {}).forEach(function (k) {
      var src = data.cells[k];
      if (!src || typeof src !== 'object') { return; }
      var storedRow = parseInt(k.split(',')[0], 10);
      var storedCol = parseInt(k.split(',')[1], 10);
      if (!isFinite(storedRow) || !isFinite(storedCol) || storedRow < 0 || storedCol < 0 || storedCol >= COLS) { return; }

      var cell = { impressions: [], patched: false, patchEl: null };
      if (Array.isArray(src.i)) {
        src.i.forEach(function (a) {
          if (!Array.isArray(a) || typeof a[0] !== 'string' || a[0].length !== 1) { return; }
          if (!validNumber(a[1], COLS - 1) || !validNumber(a[2], 1e6) || typeof a[3] !== 'number') { return; }
          cell.impressions.push({ ch: a[0], col: a[1], row: a[2], seed: a[3], ink: a[5] === 'red' ? 'red' : 'black' });
        });
      }
      if (Array.isArray(src.p) && validNumber(src.p[0], 1e6) && validNumber(src.p[1], COLS - 1) && typeof src.p[2] === 'number') {
        cell.patched = true;
        cell.patchRow = src.p[0];
        cell.patchCol = src.p[1];
        cell.patchSeed = src.p[2];
      }
      if (!cell.impressions.length && !cell.patched) { return; }
      page.cells[k] = cell;
      if (storedRow > highestRow) { highestRow = storedRow; }
    });

    if (data.carriage) {
      carriage.row = validNumber(data.carriage.row, 1e6) ? data.carriage.row : 0;
      carriage.col = validNumber(data.carriage.col, COLS - 1) ? data.carriage.col : 0;
    }
    setDocumentRows(Math.max(data.rows || MIN_ROWS, highestRow + 1));
  }

  /* -------------------------------------------------------------- settings */

  var prefs = { realism: false, sound: true, volume: 0.55, soundProfile: 'classic', typeface: 'tt2020', exportFormat: 'md' };

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
        if (['classic', 'chrome', 'foundry', 'teleprinter', 'portable'].indexOf(p.soundProfile) !== -1) { prefs.soundProfile = p.soundProfile; }
        if (typeof p.typeface === 'string') { prefs.typeface = p.typeface; }
        if (['md', 'txt', 'html', 'rtf'].indexOf(p.exportFormat) !== -1) { prefs.exportFormat = p.exportFormat; }
      }
    } catch (err) { /* corrupt prefs, keep defaults */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (err) {
      // Silently swallowing this left settings looking applied but gone on
      // the next reload, with nothing to explain it.
      say('Settings changed, but could not be saved.', true);
    }
  }

  function applyPrefs() {
    document.body.dataset.realism = prefs.realism ? 'on' : 'off';
    document.body.dataset.sound = prefs.sound ? 'on' : 'off';
    document.body.dataset.typeface = prefs.typeface;
    $('#opt-realism').checked = prefs.realism;
    $('#opt-sound').checked = prefs.sound;
    $('#opt-volume').value = Math.round(prefs.volume * 100);
    $('#opt-sound-profile').value = prefs.soundProfile;
    $('#opt-typeface').value = prefs.typeface;
    $('#opt-export-format').value = prefs.exportFormat;
    syncSelectFaces();
    // Realism Mode must be readable without opening settings: the Settings
    // key carries a latch mark driven by body[data-realism].
    Sound.setEnabled(prefs.sound);
    Sound.setVolume(prefs.volume);
    Sound.setProfile(prefs.soundProfile);
  }

  $('#opt-realism').addEventListener('change', function (e) {
    Sound.unlock();
    prefs.realism = e.target.checked;
    savePrefs();
    applyPrefs();
    Sound.play('leverToggle');
    say(prefs.realism
      ? 'Realism Mode on. Words split at the margin. Backspace moves the carriage; Shift plus Backspace whites out.'
      : 'Realism Mode off. Words wrap at the margin. Backspace whites out.');
  });

  $('#opt-sound').addEventListener('change', function (e) {
    Sound.unlock();
    prefs.sound = e.target.checked;
    savePrefs();
    applyPrefs();
    Sound.play('leverToggle');
  });

  $('#opt-volume').addEventListener('input', function (e) {
    prefs.volume = e.target.value / 100;
    Sound.setVolume(prefs.volume);
    Sound.unlock();
    Sound.play('key');
    savePrefs();
  });

  $('#opt-sound-profile').addEventListener('change', function (e) {
    prefs.soundProfile = e.target.value;
    savePrefs();
    Sound.setProfile(prefs.soundProfile);
    Sound.unlock();
    Sound.play('key');
  });

  $('#opt-typeface').addEventListener('change', function (e) {
    prefs.typeface = e.target.value;
    savePrefs();
    applyPrefs();
    // Seeds are frozen per impression, so the page keeps its character.
  });

  $('#opt-export-format').addEventListener('change', function (e) {
    prefs.exportFormat = e.target.value;
    savePrefs();
  });


  /* The card sits at a slight rotation and a native dropdown popup cannot be
     rotated with it, so the select is kept in the DOM as the source of truth
     and driven by a listbox that inherits the card's transform. */
  var syncSelectFaces = function () {};

  (function buildSelectListboxes() {
    var syncers = [];

    function buildSelectListbox(selectId) {
    var select = $('#' + selectId);
    select.tabIndex = -1;               // the listbox owns the tab stop
    var shell = document.createElement('div');
    shell.className = 'select-shell';
    select.parentNode.insertBefore(shell, select);
    shell.appendChild(select);

    var face = document.createElement('button');
    face.type = 'button';
    face.className = 'select-face';
    face.setAttribute('aria-haspopup', 'listbox');
    face.setAttribute('aria-expanded', 'false');
    face.id = selectId + '-face';
    shell.appendChild(face);

    var list = document.createElement('ul');
    list.className = 'select-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-labelledby', face.id);
    list.hidden = true;
    shell.appendChild(list);

    var options = Array.prototype.slice.call(select.options);
    var items = options.map(function (opt) {
      var li = document.createElement('li');
      li.className = 'select-option';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      li.textContent = opt.textContent;
      li.id = selectId + '-opt-' + opt.value;
      list.appendChild(li);
      return li;
    });

    var activeIndex = 0;

    function syncFace() {
      var i = select.selectedIndex < 0 ? 0 : select.selectedIndex;
      face.textContent = options[i].textContent;
      items.forEach(function (li, n) {
        li.setAttribute('aria-selected', String(n === i));
        li.classList.toggle('is-selected', n === i);
      });
      list.setAttribute('aria-activedescendant', items[i].id);
    }

    function setActive(n) {
      activeIndex = Math.max(0, Math.min(items.length - 1, n));
      items.forEach(function (li, i) { li.classList.toggle('is-active', i === activeIndex); });
      list.setAttribute('aria-activedescendant', items[activeIndex].id);
    }

    function open() {
      list.hidden = false;
      face.setAttribute('aria-expanded', 'true');
      setActive(select.selectedIndex < 0 ? 0 : select.selectedIndex);
      list.focus();
    }

    function close(refocus) {
      list.hidden = true;
      face.setAttribute('aria-expanded', 'false');
      if (refocus) { face.focus(); }
    }

    function choose(n) {
      select.value = options[n].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncFace();
      close(true);
    }

    list.tabIndex = -1;

    face.addEventListener('click', function () {
      if (list.hidden) { open(); } else { close(true); }
    });

    list.addEventListener('click', function (e) {
      var li = e.target.closest('.select-option');
      if (li) { choose(items.indexOf(li)); }
    });

    list.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
      else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
      else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(activeIndex); }
    });

    document.addEventListener('pointerdown', function (e) {
      if (!list.hidden && !shell.contains(e.target)) { close(false); }
    });

    // Keep the face honest if anything sets select.value directly.
    select.addEventListener('change', syncFace);
    syncers.push(syncFace);
    syncFace();
    }

    buildSelectListbox('opt-typeface');
    buildSelectListbox('opt-export-format');
    buildSelectListbox('opt-sound-profile');
    syncSelectFaces = function () { syncers.forEach(function (sync) { sync(); }); };
  })();

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
    var items = Array.prototype.filter.call(
      el.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])'),
      function (n) { return n.tabIndex >= 0 && !n.hidden && n.offsetParent !== null; }
    );
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
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(carbon, 'cardShuffle'); }
    trapFocus(carbon, e);
  });

  $('#card-close').addEventListener('click', function () { closeDialog(card, 'cardShuffle'); });

  document.addEventListener('pointerdown', function (e) {
    if (!card.hidden && !card.contains(e.target) && !e.target.closest('.rail-key[data-action="settings"]')) {
      closeDialog(card, 'cardShuffle');
    }
    if (!carbon.hidden && !carbon.contains(e.target) && !e.target.closest('.rail-key[data-action="erase"]')) {
      closeDialog(carbon, 'cardShuffle');
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
        // Export first. A full localStorage is exactly when getting the page
        // out of the browser matters most, so it must not gate the download.
        exportDocument(prefs.exportFormat);
        flashKey(btn);
        say('Downloaded ' + prefs.exportFormat.toUpperCase() + '.');
        savePage(true);

      } else if (action === 'copy') {
        var text = pageText();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            flashKey(btn);
            say('Page copied.');
          }, function () { say('Could not copy.', true); });
        } else {
          say('Clipboard not available.', true);
        }

      } else if (action === 'erase') {
        openDialog(carbon, $('#erase-no'), 'cardShuffle');
      }
    });
  });

  $('#erase-no').addEventListener('click', function () { closeDialog(carbon, 'cardShuffle'); });
  $('#erase-close').addEventListener('click', function () { closeDialog(carbon, 'cardShuffle'); });

  $('#erase-yes').addEventListener('click', function () {
    closeDialog(carbon);
    page.cells = Object.create(null);
    page.softBreaks = Object.create(null);
    softBreaksKnown = true;
    history.length = 0;
    carriage.row = 0;
    carriage.col = 0;
    bellRungThisLine = false;
    setDocumentRows(MIN_ROWS);
    renderAll();
    updateSheet();
    Sound.play('paperFeed');
    savePage(true);
    say('Page cleared.');
  });

  /* ------------------------------------------------------------------ boot */

  window.addEventListener('beforeunload', function () { savePage(true); });
  // beforeunload does not fire when a mobile browser backgrounds or discards
  // the tab. visibilitychange and pagehide are the ones that do.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { savePage(true); }
  });
  window.addEventListener('pagehide', function () { savePage(true); });

  // Resize fires in bursts while a window is dragged; one relayout per frame
  // is all the layout that can actually be shown.
  var resizeFrame = 0;
  window.addEventListener('resize', function () {
    if (resizeFrame) { return; }
    resizeFrame = window.requestAnimationFrame(function () {
      resizeFrame = 0;
      relayout();
    });
  });
  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(relayout); }

  loadPrefs();
  loadPage();
  applyPrefs();
  renderAll();
  relayout();

})();
