# SAHAJ Lab

Working prototype of SAHAJ, an assistant for voice, gesture and natural control of a PC.
Built for Problem B, AI PC Accessibility Assistant.

**Open it:** https://azentashis.github.io/sahaj-lab/

## What you can do

- Speak commands: open notes, open slides, next slide, read it back, undo that.
- Dictate into Notes. Fillers and self corrections are cleaned up, and lists are made by voice.
- Show hand poses to the camera. An open palm held for one second turns gestures on.
- Type a phrase or press a button if you have no microphone or camera.

## What is real and what is not

- Real: the hand model runs on your device in the browser. The decision logic (cleanup, meaning guard,
  command or content, safety ladder, gesture gate, resource ladder) is the same logic described in the document.
- Not final: speech recognition here is the browser's own and may use an online service.
  On the AI PC, SAHAJ uses the on device Windows speech model and the Phi Silica language model.

Use Chrome or Edge on a laptop for voice input.

## Files

- index.html, style.css: the page
- core.js: decision logic and its self test (no libraries)
- app.js: microphone, camera and the mock screen
