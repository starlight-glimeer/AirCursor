# AirCursor

Mac webcam gesture-control prototype. It recognizes a thumb-index pinch in the browser and asks a local Node server to open NetEase Cloud Music.

## Run

```bash
node server.js
```

Open:

```text
http://127.0.0.1:5177
```

Allow camera access, put one hand in frame, then pinch thumb and index finger for about 1.2 seconds.

## Current Gesture

- Pinch and hold: open NetEase Cloud Music.
- Open palm near the character: pull the character toward the palm and show a shield effect.
- Hand near the character: the character dodges.
- Pinch near the character: catch and drag the character.

The native action is intentionally handled by the local server because browsers cannot safely launch arbitrary macOS apps directly.
