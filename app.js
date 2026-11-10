/* SAHAJ Lab user interface: microphone, camera, the mock screen and the log. Decision logic lives in core.js. */
(function () {
  'use strict';
  var C = SahajCore;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function say(text) { $('says').textContent = text; }

  // ---------- State ----------
  var SLIDES = [
    ['SAHAJ', 'Voice, gesture and natural control, on the AI PC'],
    ['Wakes only when called', 'A hotkey, a wake phrase, an open palm or one button'],
    ['Knows a command from content', 'A command is a phrase said alone between two pauses'],
    ['Asks before risky actions', 'Everything else can be undone'],
    ['Nothing leaves the laptop', 'Audio and camera frames are processed and discarded']
  ];
  var desk = { front: 'notes', open: { notes: true, slides: true }, slide: 1 };
  var session = C.dictate('Things to buy for the lab [pause] start bullet list [pause] copper wire [pause] next item [pause] three multimeters [pause] end list');
  var lastEntry = null, undoStack = [], pending = null, offer = null, offerTimer = null;
  var listening = false, muted = false, camOn = false, camBusy = false;
  var tracker = new C.Tracker(), disarmTimer = null;
  var stats = { ms: [], rate: 0, decide: null, speech: 'not started' };

  // ---------- Rendering ----------
  function renderSensors() {
    var mic = !listening ? 'off' : (muted ? 'paused while reading' : 'listening');
    var cam = !camOn ? 'off' : (tracker.armed ? 'gestures on' : 'waiting for an open palm');
    var s = $('sensors'); s.textContent = '';
    s.appendChild(document.createTextNode('Mic ')); s.appendChild(el('b', '', mic));
    s.appendChild(document.createTextNode('  Camera ')); s.appendChild(el('b', '', cam));
    $('micBtn').textContent = listening ? 'Stop listening' : 'Start listening'; $('micBtn').setAttribute('aria-pressed', String(listening));
    $('camBtn').textContent = camOn ? 'Stop camera' : (camBusy ? 'Starting camera' : 'Start camera'); $('camBtn').setAttribute('aria-pressed', String(camOn));
  }
  function renderDesk() {
    ['notes', 'slides'].forEach(function (app) {
      var b = $(app === 'notes' ? 'appNotes' : 'appSlides');
      b.setAttribute('aria-pressed', String(desk.front === app)); b.className = desk.open[app] ? '' : 'closed';
    });
    var w = $('window'); w.textContent = '';
    if (desk.front === 'notes') {
      w.appendChild(el('p', 'title', 'Notes' + (session.clean ? '' : ' (verbatim mode)')));
      var view = session.view();
      if (!view.length) w.appendChild(el('p', 'empty', 'Empty. Start talking, or try: start bullet list.'));
      view.forEach(function (b) {
        if (b.type === 'p') { w.appendChild(el('p', '', b.text)); return; }
        var list = el(b.type); b.items.forEach(function (it) { list.appendChild(el('li', '', it)); }); w.appendChild(list);
      });
      var c = lastEntry && lastEntry.clean;
      if (c && !c.verbatim && (c.removed || c.usedFallback)) {
        var d = el('p', 'detail');
        d.appendChild(document.createTextNode('Heard: '));
        c.toks.forEach(function (t, i) { if (i) d.appendChild(document.createTextNode(' ')); d.appendChild(t.keep ? document.createTextNode(t.w) : el('del', '', t.w)); });
        d.appendChild(document.createTextNode(c.usedFallback ? '. The cleanup was unsure, so your words were kept.' : '. Crossed out words were removed, and the meaning guard passed.'));
        w.appendChild(d);
      }
    } else if (desk.front === 'slides') {
      w.appendChild(el('p', 'title', 'Slides'));
      var s = el('div', 'slide'); s.appendChild(el('b', '', SLIDES[desk.slide - 1][0])); s.appendChild(el('span', '', SLIDES[desk.slide - 1][1])); w.appendChild(s);
      var nav = el('div', 'slidenav');
      var prev = el('button', '', 'Previous'); prev.addEventListener('click', function () { handle('previous slide', 'button'); });
      var next = el('button', '', 'Next'); next.addEventListener('click', function () { handle('next slide', 'button'); });
      nav.appendChild(prev); nav.appendChild(next); nav.appendChild(el('span', '', 'Slide ' + desk.slide + ' of ' + SLIDES.length)); w.appendChild(nav);
    } else {
      w.appendChild(el('p', 'empty', 'No window is open. Say "open notes" or "open slides".'));
    }
  }
  function renderBanner() {
    var b = $('banner'); b.textContent = ''; b.className = 'banner';
    if (pending) {
      b.hidden = false; b.appendChild(el('span', '', pending.label + '? Say yes, show a thumb up, or press Yes.'));
      var y = el('button', '', 'Yes'); y.addEventListener('click', function () { handle('yes', 'button'); });
      var n = el('button', '', 'No'); n.addEventListener('click', function () { handle('cancel', 'button'); });
      b.appendChild(y); b.appendChild(n);
    } else if (offer) {
      b.hidden = false; b.className = 'banner undo'; b.appendChild(el('span', '', offer.label + '. Undo is offered for ' + offer.left + (offer.left === 1 ? ' more second.' : ' more seconds.')));
      var u = el('button', '', 'Undo'); u.addEventListener('click', function () { handle('undo that', 'button'); }); b.appendChild(u);
    } else b.hidden = true;
  }
  function log(source, phrase, tier, how) {
    var l = $('log'); if (l.firstChild && l.firstChild.className === 'empty') l.textContent = '';
    var li = el('li', tier); li.appendChild(el('b', '', source + ': '));
    li.appendChild(document.createTextNode('"' + phrase + '"')); li.appendChild(el('span', 'how', how));
    l.insertBefore(li, l.firstChild); while (l.children.length > 6) l.removeChild(l.lastChild);
  }
  function closeOffer() { clearInterval(offerTimer); offer = null; }

  // ---------- One phrase in, one decision out ----------
  function pushUndo(label, fn) { undoStack.push({ label: label, fn: fn }); if (undoStack.length > 20) undoStack.shift(); }
  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) return false;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      muted = true; renderSensors();
      u.onend = u.onerror = function () { setTimeout(function () { muted = false; renderSensors(); }, 300); };
      window.speechSynthesis.speak(u); return true;
    } catch (e) { muted = false; return false; }
  }
  function stopSpeaking() { try { window.speechSynthesis.cancel(); } catch (e) {} muted = false; }

  function handle(phrase, source) {
    var t0 = performance.now();
    var who = { voice: 'Voice', typed: 'Typed', gesture: 'Gesture', button: 'Button' }[source];
    var r = C.route(phrase, { front: desk.front, pending: !!pending, source: source });
    var done = function (tier, how, said) { stats.decide = performance.now() - t0; log(who, phrase, tier, how); say(said || how); renderAll(); };

    if (r.kind === 'ignored') return done('ignored', 'Ignored. ' + r.reason);
    if (r.kind === 'confirm') { var p = pending; pending = null; p.run(); return done('risky', 'Confirmed and done. "Undo that" still brings it back.', p.label + '. Done.'); }
    if (r.kind === 'cancel') { pending = null; return done('ignored', 'Cancelled. Nothing was changed.'); }

    if (r.kind === 'dictation') {
      closeOffer();
      var before = session.history.length;
      var e = session.feed(r.literal ? r.literal : phrase); lastEntry = e;
      if (r.literal) { e.kind = 'escaped'; }
      if (session.history.length > before) pushUndo('dictation', function () { session.feed('undo that'); lastEntry = null; });
      if (e.kind === 'command') return done('typed', 'Formatting command. ' + e.chip + '.', e.chip + '.');
      if (e.kind === 'ignored') return done('ignored', 'Only filler sounds. Nothing was typed.');
      if (e.kind === 'escaped') return done('typed', 'Said after "type", so the words were written.', 'Typed.');
      if (e.clean && e.clean.usedFallback) return done('typed', 'Typed as spoken. The cleanup was unsure, so your words were kept.');
      return done('typed', e.note ? 'Typed as content. ' + e.note : (e.clean && e.clean.removed ? 'Typed, with ' + e.clean.removed + (e.clean.removed === 1 ? ' word' : ' words') + ' cleaned up.' : 'Typed as content.'), 'Typed.');
    }

    // Commands
    closeOffer();
    var other = function (app) { return app === 'notes' ? 'slides' : 'notes'; };
    var name = function (app) { return app === 'notes' ? 'Notes' : 'Slides'; };
    switch (r.act) {
      case 'open':
        desk.open[r.arg] = true; desk.front = r.arg;
        return done('safe', 'Done at once. Opening an app is harmless.', name(r.arg) + ' is open.');
      case 'next': case 'prev':
        desk.open.slides = true; desk.front = 'slides';
        var to = desk.slide + (r.act === 'next' ? 1 : -1);
        if (to < 1 || to > SLIDES.length) return done('safe', 'Nothing to do. Already on the ' + (to < 1 ? 'first' : 'last') + ' slide.');
        desk.slide = to;
        return done('safe', 'Done at once. Easy to reverse.', 'Slide ' + to + ' of ' + SLIDES.length + '.');
      case 'read':
        var text = session.plain().replace(/• /g, '');
        if (!text) return done('safe', 'Notes is empty, so there is nothing to read.');
        return done('safe', speak(text) ? 'Reading the notes aloud. The microphone pauses so SAHAJ does not hear itself.' : 'This browser cannot play speech.');
      case 'stop':
        stopSpeaking();
        return done('safe', 'Stopped.');
      case 'micOff':
        stopMic();
        return done('safe', 'Microphone is off.');
      case 'undo':
        var u = undoStack.pop();
        if (!u) return done('ignored', 'Nothing to undo.');
        u.fn();
        return done('safe', 'Undone: ' + u.label + '.');
      case 'close':
        if (!desk.open[r.arg]) return done('ignored', name(r.arg) + ' is already closed.');
        var snap = JSON.parse(JSON.stringify(desk));
        desk.open[r.arg] = false; if (desk.front === r.arg) desk.front = desk.open[other(r.arg)] ? other(r.arg) : null;
        pushUndo('closing ' + name(r.arg), function () { desk = snap; });
        offer = { label: name(r.arg) + ' closed', left: 5 };
        offerTimer = setInterval(function () { offer.left--; if (offer.left <= 0) closeOffer(); renderBanner(); }, 1000);
        return done('medium', 'Done, with a 5 second undo. Closing loses nothing, but it interrupts.', name(r.arg) + ' closed. Say undo that to reopen it.');
      case 'clear':
        if (!session.view().length) return done('ignored', 'Notes is already empty.');
        pending = { label: 'Clear all notes', run: function () {
          var old = session, oldEntry = lastEntry; session = new C.Session(); lastEntry = null;
          pushUndo('clearing the notes', function () { session = old; lastEntry = oldEntry; });
        } };
        desk.open.notes = true; desk.front = 'notes';
        return done('risky', 'Asked first. Deleting text is hard to reverse.', 'Clear all notes? Say yes to confirm.');
    }
  }
  function renderAll() { renderDesk(); renderBanner(); renderSensors(); renderLive(); }

  // ---------- Microphone ----------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition, rec = null;
  var LANG = /^en/i.test(navigator.language || '') ? navigator.language : 'en-US';
  function startMic() {
    if (!SR) { say('Voice input needs Chrome or Edge. You can still type phrases below.'); return; }
    rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = LANG;
    stats.speech = 'browser speech service';
    rec.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var res = ev.results[i], text = res[0].transcript.trim();
        if (!res.isFinal) { interim += text + ' '; continue; }
        if (!text) continue;
        if (muted && !/^stop( reading)?[.!]?$/i.test(text)) continue;
        handle(text, 'voice');
      }
      $('heard').textContent = muted ? '' : interim;
    };
    rec.onerror = function (ev) {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { listening = false; say('The browser blocked the microphone. Allow it in the address bar, or type phrases below.'); renderSensors(); }
      else if (ev.error === 'network') { listening = false; say('Speech recognition could not reach its service. You can type phrases below.'); renderSensors(); }
      else if (ev.error === 'audio-capture') { listening = false; say('No microphone was found. You can type phrases below.'); renderSensors(); }
    };
    rec.onend = function () { if (listening) { try { rec.start(); } catch (e) {} } };
    listening = true; renderSensors(); say('Listening. Try "open slides", or just talk while Notes is open.');
    var begin = function () { try { rec.start(); } catch (e) {} };
    // Newer Chrome can recognise speech on the device itself. Use that when it is already installed.
    try {
      if (typeof SR.available === 'function') {
        Promise.race([SR.available({ langs: [LANG], processLocally: true }), new Promise(function (ok) { setTimeout(function () { ok('timeout'); }, 800); })])
          .then(function (a) { if (a === 'available') { rec.processLocally = true; stats.speech = 'on device (browser local model)'; } }, function () {})
          .then(function () { begin(); renderLive(); });
      } else begin();
    } catch (e) { begin(); }
  }
  function stopMic() { listening = false; try { if (rec) rec.stop(); } catch (e) {} $('heard').textContent = ''; renderSensors(); }
  $('micBtn').addEventListener('click', function () { if (listening) { stopMic(); say('Microphone is off.'); } else startMic(); });

  // ---------- Camera and hand gestures ----------
  var MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3';
  var MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
  var BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  var BOX = { x0: 0.12, x1: 0.88, y0: 0.08, y1: 0.92 };
  var recognizer = null, stream = null, lastFrame = 0, video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');

  var lastStamp = 0;
  function stamp() { lastStamp = Math.max(lastStamp + 1, performance.now()); return lastStamp; } // timestamps must always increase
  function loadRecognizer() {
    if (recognizer) return Promise.resolve(recognizer);
    return import(MP + '/vision_bundle.mjs').catch(function () { return import(MP); }).then(function (mp) {
      return mp.FilesetResolver.forVisionTasks(MP + '/wasm').then(function (files) {
        var make = function (delegate) {
          return mp.GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL, delegate: delegate }, runningMode: 'VIDEO', numHands: 1 });
        };
        return make('GPU').catch(function () { return make('CPU'); });
      });
    }).then(function (g) {
      // Warm up once on a blank frame, so the first real frame is not slow.
      try { var blank = document.createElement('canvas'); blank.width = 320; blank.height = 240; blank.getContext('2d').fillRect(0, 0, 320, 240); g.recognizeForVideo(blank, stamp()); } catch (e) {}
      recognizer = g; return g;
    });
  }
  function startCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say('This browser cannot open a camera. Use the pose buttons instead.'); return; }
    camBusy = true; renderSensors(); say('Starting the camera and loading the hand model. The first time takes a few seconds.');
    navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false }).then(function (s) {
      stream = s; video.srcObject = s; return video.play();
    }).then(loadRecognizer).then(function () {
      camBusy = false; camOn = true; $('cam').className = 'cam on'; renderSensors();
      say('Camera is on. Hold an open palm for one second to turn gestures on.');
      requestAnimationFrame(loop);
    }).catch(function (err) {
      stopCam();
      var why = err && err.name === 'NotAllowedError' ? 'The browser blocked the camera. Allow it in the address bar.' : (err && err.name === 'NotFoundError' ? 'No camera was found.' : 'The camera or the hand model could not start.');
      say(why + ' You can use the pose buttons instead.');
    });
  }
  function stopCam() {
    camOn = false; camBusy = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; video.srcObject = null; $('cam').className = 'cam';
    setArmed(false); tracker.reset(); renderSensors();
    $('pose').textContent = 'Hold an open palm for one second to turn gestures on.';
  }
  $('camBtn').addEventListener('click', function () { if (camOn) { stopCam(); say('Camera is off.'); } else if (!camBusy) startCam(); });

  function setArmed(on) {
    tracker.armed = on; clearTimeout(disarmTimer);
    if (on) disarmTimer = setTimeout(function () { setArmed(false); say('Gestures turned themselves off after 30 seconds without use.'); renderSensors(); }, 30000);
  }
  function loop(now) {
    if (!camOn) return;
    var gap = tracker.armed ? 66 : 200; // 15 frames a second when armed, 5 when only waiting for a palm
    if (now - lastFrame >= gap && video.readyState >= 2) {
      lastFrame = now; stats.rate = Math.round(1000 / gap);
      var t0 = performance.now(), res = null;
      try { res = recognizer.recognizeForVideo(video, stamp()); } catch (e) { res = null; }
      stats.ms.push(performance.now() - t0); if (stats.ms.length > 30) stats.ms.shift();
      var g = res && res.gestures && res.gestures[0] && res.gestures[0][0], lm = res && res.landmarks && res.landmarks[0];
      var inBox = false;
      if (lm) { var cx = (lm[0].x + lm[5].x + lm[17].x) / 3, cy = (lm[0].y + lm[5].y + lm[17].y) / 3; inBox = cx > BOX.x0 && cx < BOX.x1 && cy > BOX.y0 && cy < BOX.y1; }
      draw(lm, inBox);
      onGesture(tracker.feed({ pose: g ? g.categoryName : null, score: g ? g.score : 0, inBox: inBox, t: now }), inBox);
    }
    requestAnimationFrame(loop);
  }
  function draw(lm, inBox) {
    var w = canvas.width, h = canvas.height, css = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.strokeStyle = tracker.armed ? css.getPropertyValue('--ok') : '#ffffff';
    ctx.strokeRect(BOX.x0 * w, BOX.y0 * h, (BOX.x1 - BOX.x0) * w, (BOX.y1 - BOX.y0) * h); ctx.setLineDash([]);
    if (!lm) return;
    ctx.strokeStyle = ctx.fillStyle = inBox ? css.getPropertyValue('--accent') : '#999999';
    BONES.forEach(function (b) { ctx.beginPath(); ctx.moveTo(lm[b[0]].x * w, lm[b[0]].y * h); ctx.lineTo(lm[b[1]].x * w, lm[b[1]].y * h); ctx.stroke(); });
    lm.forEach(function (p) { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 3, 0, 6.3); ctx.fill(); });
  }
  function onGesture(ev, inBox) {
    var pose = $('pose');
    if (ev.type === 'none') { pose.textContent = tracker.armed ? 'Gestures are on. Show a pose inside the dashed box.' : 'Hold an open palm for one second to turn gestures on.'; return; }
    var p = C.POSES[ev.pose], line = p.label + ', confidence ' + ev.score.toFixed(2) + ', held ' + Math.round(ev.heldMs) + ' ms. ';
    if (ev.type === 'arm') { setArmed(ev.armed); renderSensors(); say(ev.armed ? 'Gestures are on. Point up for the next slide.' : 'Gestures are off.'); log('Gesture', p.label, 'safe', ev.armed ? 'Held for one second, so gestures turned on.' : 'Held for one second, so gestures turned off.'); }
    else if (ev.type === 'act') { setArmed(true); handle(p.phrase, 'gesture'); line += ev.reason; }
    else if (ev.type === 'hint') { say(p.label + ': ' + p.does + '? Keep holding to confirm.'); line += ev.reason; }
    else if (ev.reason) line += ev.reason;
    pose.textContent = line;
  }
  // Pose buttons, for people without a camera. They pass through the same armed rule.
  Object.keys(C.POSES).forEach(function (k) {
    var p = C.POSES[k], b = el('button', '', p.label); b.title = p.label + ': ' + p.does;
    b.addEventListener('click', function () {
      if (k === 'Open_Palm') { setArmed(!tracker.armed); renderSensors(); say(tracker.armed ? 'Gestures are on. Point up for the next slide.' : 'Gestures are off.'); log('Gesture', p.label, 'safe', tracker.armed ? 'Gestures turned on.' : 'Gestures turned off.'); return; }
      if (!tracker.armed) { log('Gesture', p.label, 'ignored', 'Ignored. Gestures are off, so a stray hand cannot trigger anything.'); say('Gestures are off. Show an open palm first.'); return; }
      setArmed(true); handle(p.phrase, 'gesture');
    });
    $('poseBtns').appendChild(b);
  });

  // ---------- Typed phrases and phrase buttons ----------
  $('typeForm').addEventListener('submit', function (e) { e.preventDefault(); var v = $('typeIn').value.trim(); if (v) { handle(v, 'typed'); $('typeIn').value = ''; } });
  document.querySelectorAll('[data-say]').forEach(function (b) { b.addEventListener('click', function () { handle(b.dataset.say, 'button'); }); });

  // ---------- Under the hood ----------
  function row(dl, k, v, cls) { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', cls || '', v)); }
  function renderSteps() {
    var raw = $('stepIn').value, c = C.cleanup(raw, { breakModel: $('stepBreak').checked }), dl = $('steps'); dl.textContent = '';
    row(dl, 'Heard', raw);
    row(dl, 'After rules', c.rules || '(nothing left)');
    row(dl, 'After model', c.model || '(nothing left)');
    row(dl, 'Meaning guard', c.guardOk ? 'Passed. Nothing added, nothing reordered, no protected word lost.' : 'Rejected. ' + c.reason, c.guardOk ? 'good' : 'bad');
    row(dl, 'Typed', c.final || '(nothing typed)');
  }
  $('stepIn').addEventListener('input', renderSteps); $('stepBreak').addEventListener('change', renderSteps);

  var testResult = null;
  function renderTests() {
    var r = testResult = C.selfTest(), tb = $('tests').tBodies[0], pass = 0, total = 0; tb.textContent = '';
    r.groups.forEach(function (g) {
      pass += g.pass; total += g.total;
      var tr = el('tr'); tr.appendChild(el('td', '', g.name)); tr.appendChild(el('td', 'num' + (g.pass === g.total ? '' : ' some'), g.pass + ' of ' + g.total)); tb.appendChild(tr);
    });
    var tr = el('tr'); tr.appendChild(el('td', '', 'All checks')); tr.appendChild(el('td', 'num' + (pass === total ? '' : ' some'), pass + ' of ' + total)); tb.appendChild(tr);
    $('kept').textContent = r.misses.length + ' sentences were left as spoken on purpose, because the rules were not sure. They need the on device language model. For example: "' + r.misses[0].said + '".';
  }
  function renderShed() {
    var mem = +$('mem').value, load = +$('load').value;
    $('memV').textContent = mem >= 1000 ? (mem / 1000).toFixed(1) + ' GB' : mem + ' MB'; $('loadV').textContent = load + '%';
    var r = C.shed({ freeMemMB: mem, load: load, batterySaver: $('saver').checked }), tb = $('shed').tBodies[0]; tb.textContent = '';
    ['core', 'describe', 'cleanup', 'gestures', 'speech'].forEach(function (k) {
      var f = r.features[k], tr = el('tr'); tr.appendChild(el('td', '', f.name)); tr.appendChild(el('td', f.kind === 'always' ? 'full' : f.kind, f.state)); tb.appendChild(tr);
    });
    $('told').textContent = r.message || 'Nothing. Everything runs in full.';
  }
  ['mem', 'load', 'saver'].forEach(function (id) { $(id).addEventListener('input', renderShed); });
  function renderBudget() {
    var b = { dictH: +$('dictH').value, gestH: +$('gestH').value, idleH: +$('idleH').value, batteryWh: 55, fps: 15, ramGB: 16 }, r = C.budget(b), P = C.POWER;
    $('dictHV').textContent = b.dictH + ' h'; $('gestHV').textContent = b.gestH + ' h'; $('idleHV').textContent = b.idleH + ' h';
    $('math').textContent =
      'Dictation  ' + b.dictH.toFixed(1) + ' h x ' + (P.speech + P.idle).toFixed(1) + ' W = ' + r.dict.toFixed(2) + ' Wh\n' +
      'Gestures   ' + b.gestH.toFixed(1) + ' h x ' + P.gestures.toFixed(1) + ' W = ' + r.gest.toFixed(2) + ' Wh\n' +
      'Idle       ' + b.idleH.toFixed(1) + ' h x ' + P.idle.toFixed(1) + ' W = ' + r.idle.toFixed(2) + ' Wh\n' +
      'Total      ' + r.total.toFixed(2) + ' Wh = ' + r.pct.toFixed(1) + '% of a 55 Wh battery';
  }
  ['dictH', 'gestH', 'idleH'].forEach(function (id) { $(id).addEventListener('input', renderBudget); });
  function renderLive() {
    var dl = $('live'); dl.textContent = '';
    row(dl, 'Cleanup rules', testResult ? 'about ' + Math.max(1, Math.round(testResult.msPerSentence * 1000)) + ' microseconds per sentence' : 'not measured yet');
    row(dl, 'Last decision', stats.decide == null ? 'say or type something first' : (stats.decide < 0.1 ? 'under 0.1' : stats.decide.toFixed(1)) + ' ms from phrase to action');
    if (stats.ms.length) {
      var avg = stats.ms.reduce(function (a, b) { return a + b; }, 0) / stats.ms.length;
      row(dl, 'Hand model', avg.toFixed(1) + ' ms per frame at ' + stats.rate + ' frames a second, so busy ' + (avg * stats.rate / 10).toFixed(0) + '% of the time');
    } else row(dl, 'Hand model', 'start the camera to measure it');
    row(dl, 'Speech engine', stats.speech);
  }
  setInterval(function () { if (camOn && !$('view-inside').hidden) renderLive(); }, 1000);

  // ---------- Views ----------
  function showView() {
    var inside = location.hash === '#inside';
    $('view-try').hidden = inside; $('view-inside').hidden = !inside;
    $('tab-try').setAttribute('aria-current', inside ? 'false' : 'page'); $('tab-inside').setAttribute('aria-current', inside ? 'page' : 'false');
    if (inside) renderLive();
  }
  window.addEventListener('hashchange', showView);

  renderTests(); renderSteps(); renderShed(); renderBudget(); renderAll(); showView();
})();
