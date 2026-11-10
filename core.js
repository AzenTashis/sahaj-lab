/* SAHAJ core logic. Plain JavaScript, no libraries. Runs in a browser and in Node. */
(function (root) {
  'use strict';

  // ---------- 1. Speech cleanup ----------
  var FILLERS = new Set(['uh', 'uhh', 'um', 'umm', 'uhm', 'ah', 'ahh', 'er', 'erm', 'hmm', 'mm']);
  var STUTTER = new Set(['i', 'the', 'a', 'an', 'to', 'and', 'we', 'it', 'is', 'of', 'in', 'on', 'my', 'you',
    'he', 'she', 'they', 'this', 'for', 'with', 'can', 'will']);
  var DAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'yesterday']);
  var MONTHS = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
  var NUMWORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred']);
  var MARKERS = [['no', 'wait'], ['i', 'mean'], ['no'], ['sorry'], ['rather'], ['actually']];
  var COMMA_FILLERS = [['you', 'know'], ['like']];

  function norm(w) { return w.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''); }
  function tokens(text) {
    return text.trim().split(/\s+/).filter(Boolean).map(function (w) { return { w: w, n: norm(w), keep: true, why: '' }; });
  }
  function category(n) {
    if (DAYS.has(n)) return 'day';
    if (MONTHS.has(n)) return 'month';
    if (/^\d+([.:]\d+)?$/.test(n) || NUMWORDS.has(n)) return 'number';
    return null;
  }
  function endsComma(w) { return /,$/.test(w); }
  function endsHard(w) { return /[.?!;:]$/.test(w); }

  // Pass 1: rules. Removes standalone fillers and stutters.
  function rulesPass(toks) {
    var prev = null;
    toks.forEach(function (t) {
      if (FILLERS.has(t.n)) { t.keep = false; t.why = 'filler'; return; }
      if (prev && prev.n === t.n && STUTTER.has(t.n) && !endsHard(prev.w)) { prev.keep = false; prev.why = 'repeat'; }
      prev = t;
    });
    return toks;
  }

  // Pass 2: stand-in for the on device language model. Handles self corrections and comma fillers.
  // It may only delete words. When unsure it keeps the word.
  function modelPass(toks) {
    var K = []; toks.forEach(function (t, i) { if (t.keep) K.push(i); });
    function T(j) { return j >= 0 && j < K.length ? toks[K[j]] : null; }
    function matchAt(j, phrase) {
      for (var m = 0; m < phrase.length; m++) { var t = T(j + m); if (!t || !t.keep || t.n !== phrase[m]) return false; }
      return true;
    }
    for (var j = 0; j < K.length; j++) {
      if (!T(j).keep) continue;
      var done = false;
      for (var a = 0; a < MARKERS.length && !done; a++) {
        var mk = MARKERS[a];
        if (!matchAt(j, mk)) continue;
        var before = T(j - 1), after = T(j + mk.length);
        if (!before || !before.keep || !after) continue;
        var drop = null;
        if (category(before.n) && category(before.n) === category(after.n)) drop = [j - 1];
        else {
          var before2 = T(j - 2), after2 = T(j + mk.length + 1);
          if (before2 && before2.keep && after2 && before.n === after2.n && category(before2.n) && category(before2.n) === category(after.n)) drop = [j - 2, j - 1];
        }
        if (drop) {
          drop.forEach(function (d) { T(d).keep = false; T(d).why = 'self correction'; });
          for (var m = 0; m < mk.length; m++) { T(j + m).keep = false; T(j + m).why = 'self correction'; }
          done = true;
        }
      }
      if (done) continue;
      // "I mean," only at the very start of a phrase
      if (j === 0 && matchAt(0, ['i', 'mean']) && endsComma(T(1).w)) { T(0).keep = false; T(1).keep = false; T(0).why = T(1).why = 'filler phrase'; continue; }
      for (var b = 0; b < COMMA_FILLERS.length; b++) {
        var ph = COMMA_FILLERS[b];
        if (!matchAt(j, ph)) continue;
        var bef = T(j - 1), last = T(j + ph.length - 1);
        if ((j === 0 || (bef && endsComma(bef.w))) && endsComma(last.w)) {
          for (var q = 0; q < ph.length; q++) { T(j + q).keep = false; T(j + q).why = 'filler phrase'; }
          if (bef) bef.strip = true;
          break;
        }
      }
    }
    return toks;
  }

  function build(toks) {
    var out = [], firstRawCap = toks.length && /^[A-Z]/.test(toks[0].w);
    toks.forEach(function (t) {
      if (t.keep) { out.push(t.strip ? t.w.replace(/,$/, '') : t.w); return; }
      var m = /[.?!]$/.exec(t.w);
      if (m && out.length && !/[.?!,;:]$/.test(out[out.length - 1])) out[out.length - 1] += m[0];
    });
    if (out.length && firstRawCap) out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
    return out.join(' ');
  }

  // Meaning guard. Two checks on any cleaned text before it is typed:
  // 1. Nothing added or reordered: every cleaned word appears in the raw text, in the same order.
  // 2. Protected words (negations, numbers, dates) can be removed only inside a spoken correction,
  //    for example "Tuesday, no, Wednesday". Deleting "not" on its own would flip the meaning.
  var NEG = new Set(['not', 'no', 'never', 'none', 'nothing', 'without', 'nor', 'neither', 'cannot', "don't", "doesn't", "didn't",
    "can't", "won't", "isn't", "aren't", "wasn't", "weren't", "shouldn't", "couldn't", "wouldn't"]);
  function isProtected(n) { return NEG.has(n) || !!category(n); }
  function isMarker(arr) {
    return MARKERS.some(function (m) { return m.length === arr.length && m.every(function (w, i) { return w === arr[i]; }); });
  }
  function guard(raw, cleaned) {
    var r = tokens(raw).map(function (t) { return t.n; }).filter(Boolean);
    var c = tokens(cleaned).map(function (t) { return t.n; }).filter(Boolean);
    var i = 0, kept = new Array(r.length).fill(false);
    for (var k = 0; k < c.length; k++) {
      while (i < r.length && r[i] !== c[k]) i++;
      if (i === r.length) return { ok: false, word: c[k], reason: 'The word "' + c[k] + '" was never said at that point.' };
      kept[i] = true; i++;
    }
    for (var a = 0; a < r.length; a++) {
      if (kept[a]) continue;
      var b = a; while (b < r.length && !kept[b]) b++;
      var run = r.slice(a, b).filter(function (n) { return !FILLERS.has(n); });
      var p = -1;
      for (var q = 0; q < run.length; q++) if (isProtected(run[q])) { p = q; break; }
      if (p !== -1) {
        var pat = run.slice(p), cat = category(pat[0]), rest = pat.slice(1), unit = null, ok = !!cat;
        if (ok && !isMarker(rest)) { unit = rest[0]; rest = rest.slice(1); ok = isMarker(rest); }
        if (ok && !(b < r.length && category(r[b]) === cat)) ok = false;
        if (ok && unit && r[b + 1] !== unit) ok = false;
        if (!ok) return { ok: false, word: pat[0], reason: 'It would remove "' + pat[0] + '", a protected word (negation, number or date).' };
      }
      a = b;
    }
    return { ok: true };
  }

  // Used only by the demo switch that makes the model pass misbehave.
  function sabotage(text) {
    var words = text.split(' ').filter(Boolean), i;
    for (i = 0; i < words.length; i++) if (NEG.has(norm(words[i]))) { words.splice(i, 1); return cap0(words.join(' ')); }
    for (i = 0; i < words.length; i++) {
      var n = norm(words[i]);
      if (DAYS.has(n) && n !== 'thursday') { words[i] = words[i].replace(/[A-Za-z]+/, 'Thursday'); return words.join(' '); }
      if (/^\d+$/.test(n)) { words[i] = words[i].replace(/\d+/, String(Number(n) + 1)); return words.join(' '); }
    }
    words.splice(Math.min(1, words.length), 0, 'definitely');
    return words.join(' ');
  }
  function cap0(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function cleanup(raw, opts) {
    opts = opts || {};
    if (opts.mode === 'verbatim') return { raw: raw, final: raw, verbatim: true, guardOk: true, usedFallback: false, toks: tokens(raw), removed: 0 };
    var rt = rulesPass(tokens(raw));
    var rulesText = build(rt);
    var mt = modelPass(rt.map(function (t) { return { w: t.w, n: t.n, keep: t.keep, why: t.why }; }));
    var modelText = build(mt);
    if (opts.breakModel) modelText = sabotage(modelText);
    var g = guard(raw, modelText);
    var show = g.ok ? mt : rt;
    return {
      raw: raw, rules: rulesText, model: modelText, guardOk: g.ok, badWord: g.word, reason: g.reason, usedFallback: !g.ok,
      final: g.ok ? modelText : rulesText, toks: show,
      removed: show.filter(function (t) { return !t.keep; }).length
    };
  }

  // ---------- 2. Formatting by voice ----------
  var COMMANDS = {
    'start bullet list': 'ul', 'start bulleted list': 'ul', 'start numbered list': 'ol', 'start number list': 'ol',
    'next item': 'next', 'new item': 'next', 'end list': 'end', 'stop list': 'end',
    'new paragraph': 'para', 'next paragraph': 'para', 'undo that': 'undo',
    'verbatim mode': 'verbatim', 'clean mode': 'clean'
  };
  function cmdKey(seg) { return seg.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function parseScript(script) {
    return script.split(/\[pause\]|\n/i).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function cap(s) { return s.replace(/[A-Za-z]/, function (c) { return c.toUpperCase(); }); }

  function Session(opts) {
    opts = opts || {};
    this.blocks = []; this.mode = 'para'; this.closed = true;
    this.clean = opts.mode !== 'verbatim'; this.breakModel = !!opts.breakModel;
    this.history = []; this.raw = []; this.log = [];
  }
  Session.prototype.snap = function (label) {
    this.history.push({ label: label, blocks: JSON.parse(JSON.stringify(this.blocks)), mode: this.mode, closed: this.closed, clean: this.clean });
    if (this.history.length > 20) this.history.shift();
  };
  Session.prototype.addText = function (text) {
    var b = this.blocks[this.blocks.length - 1];
    if (this.mode === 'para') {
      if (!b || b.type !== 'p' || this.closed) { this.blocks.push({ type: 'p', text: cap(text) }); this.closed = false; }
      else b.text += ' ' + (/[.?!]$/.test(b.text) ? cap(text) : text);
    } else {
      var i = b.items.length - 1;
      b.items[i] = b.items[i] ? b.items[i] + ' ' + text : cap(text);
    }
  };
  Session.prototype.feed = function (seg) {
    this.raw.push(seg);
    var key = cmdKey(seg), entry = { said: seg };
    var cmd = COMMANDS[key];
    if (cmd) {
      entry.kind = 'command';
      var b = this.blocks[this.blocks.length - 1];
      if (cmd === 'undo') {
        var h = this.history.pop();
        if (h) { this.blocks = h.blocks; this.mode = h.mode; this.closed = h.closed; this.clean = h.clean; entry.chip = 'Undone: ' + h.label; }
        else { entry.chip = 'Nothing to undo'; entry.warn = true; }
      } else if (cmd === 'ul' || cmd === 'ol') {
        this.snap(cmd === 'ul' ? 'bullet list' : 'numbered list');
        if (this.mode !== 'para') this.endList();
        b = this.blocks[this.blocks.length - 1];
        if (b && b.type === 'p' && !this.closed) b.lead = true;
        this.blocks.push({ type: cmd, items: [''] }); this.mode = cmd;
        entry.chip = cmd === 'ul' ? 'Bullet list started' : 'Numbered list started';
      } else if (cmd === 'next') {
        if (this.mode === 'para') { entry.chip = 'No list is open. Say "start bullet list" first.'; entry.warn = true; }
        else if (!b.items[b.items.length - 1]) { entry.chip = 'Already on a new item'; entry.warn = true; }
        else { this.snap('new item'); b.items.push(''); entry.chip = 'New item'; }
      } else if (cmd === 'end') {
        if (this.mode === 'para') { entry.chip = 'No list is open'; entry.warn = true; }
        else { this.snap('end of list'); this.endList(); entry.chip = 'List ended, back to paragraph'; }
      } else if (cmd === 'para') {
        this.snap('new paragraph');
        if (this.mode !== 'para') this.endList();
        this.closed = true; entry.chip = 'New paragraph';
      } else {
        this.snap('mode change'); this.clean = cmd === 'clean';
        entry.chip = this.clean ? 'Clean mode on' : 'Verbatim mode on';
      }
      this.log.push(entry); return entry;
    }
    var text = seg;
    if (key.indexOf('type ') === 0 && COMMANDS[key.slice(5)]) {
      entry.kind = 'escaped'; text = seg.replace(/^\s*type\s+/i, '');
      entry.note = 'Said with the escape word "type", so the words are written.';
      entry.final = text;
    } else {
      entry.kind = 'text';
      var c = cleanup(seg, { mode: this.clean ? 'clean' : 'verbatim', breakModel: this.breakModel });
      entry.clean = c; text = c.final; entry.final = text;
      var inside = Object.keys(COMMANDS).filter(function (k) { return key.indexOf(k) !== -1; })[0];
      if (inside) entry.note = 'Contains "' + inside + '" but it was not said alone, so it stays as text.';
    }
    if (!text.trim()) { entry.kind = 'ignored'; entry.note = 'Only filler sounds. Nothing typed.'; this.log.push(entry); return entry; }
    this.snap('"' + text + '"');
    this.addText(text);
    this.log.push(entry); return entry;
  };
  Session.prototype.endList = function () {
    var b = this.blocks[this.blocks.length - 1];
    if (b && b.items) {
      if (!b.items[b.items.length - 1]) b.items.pop();
      if (!b.items.length) this.blocks.pop();
    }
    this.mode = 'para'; this.closed = true;
  };
  function paraText(b) {
    if (b.lead) return b.text.replace(/[.,;:]$/, '') + ':';
    return /[.?!:]$/.test(b.text) ? b.text : b.text + '.';
  }
  Session.prototype.view = function () {
    return this.blocks.map(function (b) {
      if (b.type === 'p') return { type: 'p', text: paraText(b) };
      return { type: b.type, items: b.items.filter(Boolean) };
    }).filter(function (b) { return b.type === 'p' || b.items.length; });
  };
  Session.prototype.plain = function () {
    return this.view().map(function (b) {
      if (b.type === 'p') return b.text;
      return b.items.map(function (it, i) { return (b.type === 'ul' ? '• ' : (i + 1) + '. ') + it; }).join('\n');
    }).join('\n');
  };
  function dictate(script, opts) {
    var s = new Session(opts);
    parseScript(script).forEach(function (seg) { s.feed(seg); });
    return s;
  }

  // ---------- 3. Router: one phrase in, one decision out ----------
  // Tiers: safe = done at once, medium = done with a 5 second undo, risky = always asks first.
  var GLOBAL = [
    { re: /^open (the )?(notes|slides)( app)?$/, act: 'open', tier: 'safe' },
    { re: /^(go to )?(the )?next slide$/, act: 'next', tier: 'safe' },
    { re: /^(go to )?(the )?previous slide$|^go back$/, act: 'prev', tier: 'safe' },
    { re: /^read (it|that|this) (back|aloud)$|^read aloud$|^read my notes$/, act: 'read', tier: 'safe' },
    { re: /^stop listening$/, act: 'micOff', tier: 'safe' },
    { re: /^stop( reading)?$/, act: 'stop', tier: 'safe' },
    { re: /^undo( that)?$/, act: 'undo', tier: 'safe' },
    { re: /^close (the )?(notes|slides)$/, act: 'close', tier: 'medium' },
    { re: /^(clear|delete|erase) (my |the |all )?(notes?|everything)$/, act: 'clear', tier: 'risky' }
  ];
  var YES = /^(yes|yes do it|do it|confirm)$/, NO = /^(no|cancel|stop|never mind)$/;
  function matchGlobal(key) {
    for (var i = 0; i < GLOBAL.length; i++) {
      var m = GLOBAL[i].re.exec(key);
      if (m) return { kind: 'command', act: GLOBAL[i].act, tier: GLOBAL[i].tier, arg: m[2] === 'notes' || m[2] === 'slides' ? m[2] : '' };
    }
    return null;
  }
  // ctx: { front: 'notes' | 'slides' | null, pending: bool, source: 'voice' | 'gesture' | 'typed' }
  function route(phrase, ctx) {
    var key = cmdKey(phrase);
    if (!key) return { kind: 'ignored', reason: 'Nothing was said.' };
    if (ctx.pending) {
      if (YES.test(key)) return { kind: 'confirm' };
      if (NO.test(key)) return { kind: 'cancel' };
      return { kind: 'ignored', reason: 'Waiting for a yes or a no.' };
    }
    var g = matchGlobal(key);
    if (g) return g;
    if (ctx.source === 'gesture') return { kind: 'ignored', reason: 'Nothing is waiting for an answer.' };
    if (ctx.front === 'notes') {
      if (key.indexOf('type ') === 0 && matchGlobal(key.slice(5))) return { kind: 'dictation', literal: phrase.replace(/^\s*type\s+/i, '') };
      return { kind: 'dictation' };
    }
    return { kind: 'ignored', reason: 'Not a command, and Notes is not in front, so nothing was typed.' };
  }

  // ---------- 4. Gesture gate ----------
  var POSES = {
    Open_Palm: { label: 'Open palm', does: 'turns gestures on or off' },
    Pointing_Up: { label: 'Point up', phrase: 'next slide', does: 'next slide' },
    Victory: { label: 'Victory sign', phrase: 'previous slide', does: 'previous slide' },
    Thumb_Up: { label: 'Thumb up', phrase: 'yes', does: 'yes' },
    Thumb_Down: { label: 'Thumb down', phrase: 'cancel', does: 'no' },
    Closed_Fist: { label: 'Closed fist', phrase: 'stop', does: 'stop' }
  };
  var GATE = { fps: 15, stableFrames: 4, confirmFrames: 15, actAbove: 0.8, ignoreBelow: 0.5, armMs: 1000 };
  function gestureGate(g) {
    if (!g.armed) return { decision: 'ignore', reason: 'Gestures are off. Hold an open palm for one second to turn them on.' };
    if (!g.inBox) return { decision: 'ignore', reason: 'The hand is outside the active box.' };
    if (g.confidence < GATE.ignoreBelow) return { decision: 'ignore', reason: 'Too unsure (' + g.confidence.toFixed(2) + '). Treated as an accidental movement.' };
    if (g.frames < GATE.stableFrames) return { decision: 'ignore', reason: 'Not held long enough yet. A pose must hold for 4 frames, about 270 ms.' };
    if (g.confidence < GATE.actAbove) {
      if (g.frames >= GATE.confirmFrames) return { decision: 'act', reason: 'Unsure at first (' + g.confidence.toFixed(2) + '), then held for one second to confirm.' };
      return { decision: 'hint', reason: 'A little unsure (' + g.confidence.toFixed(2) + '). Keep holding to confirm.' };
    }
    return { decision: 'act', reason: 'Clear pose (' + g.confidence.toFixed(2) + '), held steady.' };
  }
  // Tracker: fed one camera frame at a time. Fires at most one action per hold.
  function Tracker() { this.armed = false; this.reset(); }
  Tracker.prototype.reset = function () { this.pose = null; this.start = 0; this.fired = false; this.min = 1; };
  Tracker.prototype.feed = function (f) { // f: { pose, score, inBox, t }
    if (!f.pose || f.pose === 'None' || !POSES[f.pose] || f.score < GATE.ignoreBelow) { this.reset(); return { type: 'none' }; }
    if (f.pose !== this.pose) { this.reset(); this.pose = f.pose; this.start = f.t; }
    this.min = Math.min(this.min, f.score);
    var held = f.t - this.start, ev = { type: 'holding', pose: f.pose, heldMs: held, score: this.min };
    if (this.fired) return ev;
    if (f.pose === 'Open_Palm') {
      if (f.inBox && held >= GATE.armMs) { this.fired = true; this.armed = !this.armed; ev.type = 'arm'; ev.armed = this.armed; }
      return ev;
    }
    var r = gestureGate({ armed: this.armed, inBox: f.inBox, confidence: this.min, frames: Math.floor(held * GATE.fps / 1000) });
    ev.reason = r.reason;
    if (r.decision === 'act') { this.fired = true; ev.type = 'act'; }
    else if (r.decision === 'hint') ev.type = 'hint';
    return ev;
  };

  // ---------- 5. Resource ladder and budget ----------
  function shed(r) {
    var mem = r.freeMemMB, load = r.load, lvl = 0;
    if (mem < 2000 || load >= 70) lvl = 1;
    if (mem < 1500 || load >= 80) lvl = 2;
    if (mem < 1100 || load >= 88) lvl = 3;
    if (mem < 800 || load >= 93) lvl = 4;
    if (mem < 500 || load >= 97) lvl = 5;
    var f = {
      core: { name: 'Hotkey, stop, undo, basic voice commands, screen reader support', state: 'Always on', kind: 'always' },
      describe: { name: 'Image description and simplify text', state: 'Full', kind: 'full' },
      cleanup: { name: 'Speech cleanup', state: 'Rules and model', kind: 'full' },
      gestures: { name: 'Gestures', state: '15 frames per second', kind: 'full' },
      speech: { name: 'Speech recognition', state: 'Base model (about 388 MB)', kind: 'full' }
    };
    var said = [];
    if (r.batterySaver) {
      f.cleanup.state = 'Rules only'; f.cleanup.kind = 'reduced';
      f.gestures.state = '10 frames per second'; f.gestures.kind = 'reduced';
    }
    if (lvl >= 1) { f.describe.state = 'Queued until the laptop is free'; f.describe.kind = 'queued'; said.push('Image descriptions will wait.'); }
    if (lvl >= 2) { f.cleanup.state = 'Rules only'; f.cleanup.kind = 'reduced'; }
    if (lvl >= 3) { f.gestures.state = '5 frames per second'; f.gestures.kind = 'reduced'; said = ['Gestures are slower.']; }
    if (lvl >= 4) { f.gestures.state = 'Paused'; f.gestures.kind = 'paused'; said = ['Gestures paused.']; }
    if (lvl >= 5) { f.speech.state = 'Tiny model (about 273 MB)'; f.speech.kind = 'reduced'; said = ['Gestures paused.', 'Dictation may be less accurate.']; }
    var message = lvl === 0 ? (r.batterySaver ? 'On battery saver. Everything still works.' : '') : 'Laptop is busy. ' + said.join(' ') + ' Voice still works.';
    return { level: lvl, features: f, message: message };
  }
  var POWER = { idle: 0.1, speech: 1.0, gestures: 1.5 };
  function budget(b) {
    var dict = b.dictH * (POWER.speech + POWER.idle), gest = b.gestH * POWER.gestures, idle = b.idleH * POWER.idle;
    var total = dict + gest + idle;
    var npuMs = b.fps * 2 * 7;
    return { dict: dict, gest: gest, idle: idle, total: total, pct: 100 * total / b.batteryWh, npuMs: npuMs, npuPct: npuMs / 10,
      peakMB: 60 + 388 + 30 + 50, peakPct: 100 * (60 + 388 + 30 + 50) / (b.ramGB * 1024) };
  }

  // ---------- 6. Self test ----------
  var CLEAN_CASES = [
    ['Um so the meeting is on uh Tuesday, no, Wednesday at 3.', 'So the meeting is on Wednesday at 3.'],
    ['I I think we should uh start now', 'I think we should start now'],
    ['The the report is ready', 'The report is ready'],
    ['Please send it by um Friday', 'Please send it by Friday'],
    ['Yes, um, I agree', 'Yes, I agree'],
    ['Ah I forgot the charger', 'I forgot the charger'],
    ['We need uh three no four chairs', 'We need four chairs'],
    ['Call me at 3 pm no 4 pm tomorrow', 'Call me at 4 pm tomorrow'],
    ['The deadline is March I mean April', 'The deadline is April'],
    ['Set the timer for uh 10 no wait 15 minutes', 'Set the timer for 15 minutes'],
    ['Hmm let me check the the file', 'Let me check the file'],
    ['Meet on Monday sorry Tuesday morning', 'Meet on Tuesday morning'],
    ['Book two tickets for May no June', 'Book two tickets for June'],
    ['Umm can you uh open the uh browser', 'Can you open the browser'],
    ['We will will meet at five', 'We will meet at five'],
    ['I mean, we could try again', 'We could try again'],
    ['Er the battery is at 20 percent no 30 percent', 'The battery is at 30 percent'],
    ['The rent is 12000 rupees no 13000 rupees', 'The rent is 13000 rupees'],
    ['Let us meet tomorrow no Friday', 'Let us meet Friday'],
    ['Chapter 3 no 4 is harder', 'Chapter 4 is harder'],
    ['The uh um ah plan is fine', 'The plan is fine'],
    ['It starts at 9 I mean 10 sharp', 'It starts at 10 sharp'],
    ['Well, like, I am not sure', 'Well, I am not sure'],
    ['We ship on Monday actually Tuesday', 'We ship on Tuesday'],
    ['Add milk eggs and um bread', 'Add milk eggs and bread'],
    ['It was, you know, a long day', 'It was a long day'],
    ['Uh', ''],
    // Traps: these must come out unchanged
    ['I mean it', 'I mean it'],
    ['You know the answer', 'You know the answer'],
    ['I had had enough of it', 'I had had enough of it'],
    ['There is no Tuesday class this week', 'There is no Tuesday class this week'],
    ['So basically we are done', 'So basically we are done'],
    ['I like the blue one', 'I like the blue one'],
    ['Sorry I am late', 'Sorry I am late'],
    ['No I do not agree', 'No I do not agree'],
    ['The answer is no', 'The answer is no'],
    ['It is very very important', 'It is very very important'],
    ['He said no and left', 'He said no and left'],
    ['I want one no sugar tea', 'I want one no sugar tea'],
    ['Actually I prefer tea', 'Actually I prefer tea'],
    ['Tuesday actually works for me', 'Tuesday actually works for me'],
    // Hard cases that need the real language model
    ['It was like really good', 'It was really good'],
    ['Send the file to Ravi, I mean, to Arun', 'Send the file to Arun'],
    ['I think um I think we should go', 'I think we should go'],
    ['Turn left no right at the signal', 'Turn right at the signal']
  ];
  var FORMAT_CASES = [
    ['Lab list', 'Things to buy for the lab [pause] start bullet list [pause] copper wire [pause] next item [pause] two multimeters [pause] next item [pause] solder [pause] end list [pause] I will order these by Friday.',
      'Things to buy for the lab:\n• Copper wire\n• Two multimeters\n• Solder\nI will order these by Friday.'],
    ['Command words inside a sentence', 'The next item on the agenda is the budget', 'The next item on the agenda is the budget.'],
    ['Escape word', 'start numbered list [pause] say start bullet list to begin [pause] next item [pause] type next item [pause] end list', '1. Say start bullet list to begin\n2. Next item'],
    ['Undo a command', 'Buy milk [pause] start bullet list [pause] undo that [pause] and eggs', 'Buy milk and eggs.'],
    ['Numbered list', 'Steps to submit [pause] start numbered list [pause] register [pause] next item [pause] upload the file [pause] end list', 'Steps to submit:\n1. Register\n2. Upload the file'],
    ['Next item with no list', 'next item [pause] hello there', 'Hello there.'],
    ['New paragraph', 'First point [pause] new paragraph [pause] second point', 'First point.\nSecond point.'],
    ['Cleanup inside a list', 'start bullet list [pause] um copper wire [pause] next item [pause] two no three multimeters [pause] end list', '• Copper wire\n• Three multimeters'],
    ['Verbatim then clean', 'verbatim mode [pause] um I think so [pause] clean mode [pause] um yes', 'Um I think so yes.'],
    ['Two phrases in one item', 'start bullet list [pause] copper wire [pause] two metres [pause] end list', '• Copper wire two metres'],
    ['Filler only phrase', 'uh [pause] hello', 'Hello.'],
    ['Undo twice', 'one [pause] new paragraph [pause] two [pause] undo that [pause] undo that [pause] three', 'One three.']
  ];
  var ROUTE_CASES = [
    ['open slides', { front: 'notes' }, 'command', 'open', 'safe'], ['Open Notes.', { front: 'slides' }, 'command', 'open', 'safe'],
    ['next slide', { front: 'notes' }, 'command', 'next', 'safe'], ['read it back', { front: 'notes' }, 'command', 'read', 'safe'],
    ['undo that', { front: 'notes' }, 'command', 'undo', 'safe'], ['close notes', { front: 'notes' }, 'command', 'close', 'medium'],
    ['clear notes', { front: 'notes' }, 'command', 'clear', 'risky'], ['delete everything', { front: 'slides' }, 'command', 'clear', 'risky'],
    ['The next slide is about cost', { front: 'notes' }, 'dictation'], ['hello there', { front: 'slides' }, 'ignored'],
    ['type clear notes', { front: 'notes' }, 'dictation'], ['yes', { front: 'notes' }, 'dictation'],
    ['yes', { front: 'notes', pending: true }, 'confirm'], ['cancel', { front: 'notes', pending: true }, 'cancel'],
    ['open slides', { front: 'notes', pending: true }, 'ignored'], ['yes', { front: 'slides', source: 'gesture' }, 'ignored']
  ];
  var GATE_CASES = [
    [{ armed: false, inBox: true, confidence: 0.95, frames: 8 }, 'ignore'],
    [{ armed: true, inBox: false, confidence: 0.95, frames: 8 }, 'ignore'],
    [{ armed: true, inBox: true, confidence: 0.9, frames: 2 }, 'ignore'],
    [{ armed: true, inBox: true, confidence: 0.4, frames: 10 }, 'ignore'],
    [{ armed: true, inBox: true, confidence: 0.65, frames: 6 }, 'hint'],
    [{ armed: true, inBox: true, confidence: 0.65, frames: 15 }, 'act'],
    [{ armed: true, inBox: true, confidence: 0.92, frames: 4 }, 'act'],
    [{ armed: true, inBox: true, confidence: 0.8, frames: 4 }, 'act']
  ];
  var GUARD_CASES = [
    ['I do not agree', 'I do agree', false],
    ['Pay 500 rupees to Arun', 'Pay rupees to Arun', false],
    ['Meet on Tuesday, no, Wednesday', 'Meet on Tuesday', false],
    ['Meet on Tuesday, no, Wednesday', 'Meet on Wednesday', true],
    ['um hello there', 'hello there', true],
    ['hello there', 'hello there friend', false],
    ['send it to Arun not Ravi', 'send it to Ravi not Arun', false],
    ['Call me at 3 pm no 4 pm', 'Call me at 4 pm', true],
    ['I will never be late', 'I will be late', false],
    ['The the plan is fine', 'The plan is fine', true]
  ];
  // Frame sequences: pose, score, how long it is held, frame gap. "want" lists the events that must fire.
  var TRACK_CASES = [
    { armed: false, pose: 'Open_Palm', score: 0.9, ms: 1200, step: 200, want: 'arm' },
    { armed: true, pose: 'Pointing_Up', score: 0.9, ms: 900, step: 66, want: 'act' },
    { armed: true, pose: 'Pointing_Up', score: 0.9, ms: 130, step: 66, want: '' },
    { armed: false, pose: 'Pointing_Up', score: 0.9, ms: 900, step: 66, want: '' },
    { armed: true, pose: 'Victory', score: 0.65, ms: 600, step: 66, want: '' },
    { armed: true, pose: 'Victory', score: 0.65, ms: 1200, step: 66, want: 'act' },
    { armed: true, pose: 'Thumb_Up', score: 0.9, ms: 900, step: 66, out: true, want: '' },
    { armed: true, pose: 'Thumb_Up', score: 0.4, ms: 900, step: 66, want: '' }
  ];
  function trackRun(c) {
    var tr = new Tracker(), fired = []; tr.armed = c.armed;
    for (var t = 0; t <= c.ms; t += c.step) { var ev = tr.feed({ pose: c.pose, score: c.score, inBox: !c.out, t: 1000 + t }); if (ev.type === 'act' || ev.type === 'arm') fired.push(ev.type); }
    return fired.join(',');
  }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function selfTest() {
    var out = { groups: [], misses: [] };
    var ideal = 0, safe = 0, trapsOk = true;
    CLEAN_CASES.forEach(function (c) {
      var r = cleanup(c[0]);
      var words = function (s) { return tokens(s).map(function (t) { return t.n; }).filter(Boolean).join(' '); };
      var match = words(r.final) === words(c[1]);
      if (match) ideal++; else out.misses.push({ said: c[0], got: r.final, ideal: c[1] });
      if (guard(c[0], r.final).ok) safe++;
    });
    out.clean = { total: CLEAN_CASES.length, ideal: ideal, safe: safe };
    out.groups.push({ name: 'Cleanup matches a human edit, word for word', pass: ideal, total: CLEAN_CASES.length });
    out.groups.push({ name: 'Cleanup never adds or reorders a word', pass: safe, total: CLEAN_CASES.length });
    var caught = 0;
    CLEAN_CASES.forEach(function (c) { var r = cleanup(c[0], { breakModel: true }); if (r.usedFallback && guard(c[0], r.final).ok) caught++; });
    out.groups.push({ name: 'Meaning guard catches a misbehaving model', pass: caught, total: CLEAN_CASES.length });
    var gd = 0; GUARD_CASES.forEach(function (c) { if (guard(c[0], c[1]).ok === c[2]) gd++; });
    out.groups.push({ name: 'Meaning guard accepts safe edits and rejects unsafe ones', pass: gd, total: GUARD_CASES.length });
    var f = 0; FORMAT_CASES.forEach(function (c) { var got = dictate(c[1]).plain(); if (got === c[2]) f++; else out.misses.push({ said: c[1], got: got, ideal: c[2] }); });
    out.groups.push({ name: 'Formatting by voice', pass: f, total: FORMAT_CASES.length });
    var l = 0; ROUTE_CASES.forEach(function (c) { var r = route(c[0], c[1]); if (r.kind === c[2] && (!c[3] || (r.act === c[3] && r.tier === c[4]))) l++; });
    out.groups.push({ name: 'Commands, dictation and the safety ladder are told apart', pass: l, total: ROUTE_CASES.length });
    var g = 0; GATE_CASES.forEach(function (c) { if (gestureGate(c[0]).decision === c[1]) g++; });
    TRACK_CASES.forEach(function (c) { if (trackRun(c) === c.want) g++; });
    out.groups.push({ name: 'Gesture gate ignores accidents and fires once per hold', pass: g, total: GATE_CASES.length + TRACK_CASES.length });
    var b = budget({ dictH: 1, gestH: 1, idleH: 8, batteryWh: 55, fps: 15, ramGB: 16 });
    var bOk = Math.abs(b.total - 3.4) < 1e-9 && Math.round(b.pct) === 6 && b.npuPct === 21 && b.peakMB === 528;
    var s1 = shed({ freeMemMB: 4000, load: 30 }).level === 0, s2 = shed({ freeMemMB: 700, load: 30 }).features.gestures.kind === 'paused',
      s3 = shed({ freeMemMB: 300, load: 99 }).features.core.kind === 'always';
    out.groups.push({ name: 'Budget arithmetic and resource ladder', pass: [bOk, s1, s2, s3].filter(Boolean).length, total: 4 });
    var reps = 200, t0 = now();
    for (var i = 0; i < reps; i++) CLEAN_CASES.forEach(function (c) { cleanup(c[0]); });
    out.msPerSentence = (now() - t0) / (reps * CLEAN_CASES.length);
    return out;
  }

  var api = { cleanup: cleanup, guard: guard, parseScript: parseScript, Session: Session, dictate: dictate, route: route,
    gestureGate: gestureGate, Tracker: Tracker, POSES: POSES, GATE: GATE, shed: shed, budget: budget,
    POWER: POWER, selfTest: selfTest, CLEAN_CASES: CLEAN_CASES, FORMAT_CASES: FORMAT_CASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SahajCore = api;
})(typeof self !== 'undefined' ? self : this);
