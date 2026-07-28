// Reading what NetEase (or anything else) is playing, on macOS.
//
// Why this is not two lines: since macOS 15.4 an app loading the MediaRemote
// private framework itself gets nothing back. The workaround the community
// settled on is to borrow a system binary that is already entitled to use it —
// `/usr/bin/perl`, whose bundle id is com.apple.perl5 — via
// github.com/ungive/mediaremote-adapter.
//
// Rather than bundle and build that framework before anything else works, this
// starts with the `media-control` CLI (the adapter's own packaged front end,
// `brew install media-control`). If it is absent the wall simply runs without
// music, and the settings window says so with the command to fix it. Music is an
// enhancement here, never a prerequisite.
const { execFile } = require('node:child_process');

const CANDIDATES = [
  '/opt/homebrew/bin/media-control',   // Apple Silicon Homebrew
  '/usr/local/bin/media-control',      // Intel Homebrew
  'media-control',                     // whatever is on PATH
];

let resolvedBinary = null;
let unavailableReason = null;

function probe(callback) {
  if (resolvedBinary) return callback(resolvedBinary);
  let index = 0;
  const next = () => {
    if (index >= CANDIDATES.length) {
      unavailableReason = '未安装 media-control（brew install media-control）';
      return callback(null);
    }
    const candidate = CANDIDATES[index++];
    execFile(candidate, ['--help'], { timeout: 4000 }, (error) => {
      if (!error) {
        resolvedBinary = candidate;
        unavailableReason = null;
        return callback(candidate);
      }
      next();
    });
  };
  next();
}

// Track identity plus the artwork carry-over rule, separated from the child
// process so it can be exercised with plain objects. The bug this shape prevents
// already happened once: the release-on-track-change check compared `key` to
// `lastKey` *after* assigning it, so it was always false and a track with no cover
// kept showing the previous song's artwork forever.
class TrackTracker {
  constructor() {
    this.lastKey = '';
    this.artwork = null;
  }

  // Identity from bundle + title + artist rather than any id field: MediaRemote's
  // uniqueIdentifier is not always present, and these three together are stable
  // enough that progress updates within one track do not read as a new track.
  static keyOf(data) {
    return `${data.bundleIdentifier || ''}|${data.title || ''}|${data.artist || ''}`;
  }

  // Returns the payload to hand downstream, with artwork resolved.
  accept(data) {
    const key = TrackTracker.keyOf(data);
    // Compare before assigning. Dropping the old cover on a track change matters:
    // showing the previous song's artwork on a track that has none reads as "the
    // wallpaper is stuck", not as "this track has no cover".
    if (key !== this.lastKey) this.artwork = null;
    this.lastKey = key;

    // Artwork loads lazily on the MediaRemote side, so the reads right after a
    // change often have no cover yet. Within one track, keep what we have rather
    // than flapping back to neutral and re-analysing.
    if (data.artworkData) {
      this.artwork = { data: data.artworkData, mime: data.artworkMimeType || 'image/jpeg' };
    }

    return {
      ...data,
      artworkData: (this.artwork && this.artwork.data) || null,
      artworkMimeType: (this.artwork && this.artwork.mime) || null,
    };
  }

  reset() {
    this.lastKey = '';
    this.artwork = null;
  }
}

// Polling rather than `media-control stream`: a long-lived child process needs
// restart-on-exit, backpressure handling and a shutdown path, and a wallpaper whose
// mood changes one second late is indistinguishable from one that does not.
function install({ getConfig, onTrack }) {
  let timer = null;
  // One read at a time. A slow `get` plus a fixed interval would otherwise pile up
  // child processes, and a wallpaper spawning a process backlog is worse than a
  // wallpaper that skips a beat.
  let inFlight = false;
  const tracker = new TrackTracker();

  function readOnce() {
    if (inFlight) return;
    const config = getConfig();
    if (!config || !config.music || !config.music.enabled) return;

    probe((binary) => {
      if (!binary) {
        onTrack(null);
        return;
      }
      inFlight = true;
      // 8MB: base64 artwork for a large cover can run past the 1MB default and
      // truncated JSON would look like a parse bug rather than a buffer limit.
      execFile(binary, ['get'], { timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        inFlight = false;
        if (error) {
          unavailableReason = `media-control get 失败：${String(error.message || error).slice(0, 120)}`;
          onTrack(null);
          return;
        }
        let data = null;
        try {
          data = JSON.parse(String(stdout || 'null'));
        } catch {
          unavailableReason = 'media-control 输出不是 JSON';
          onTrack(null);
          return;
        }
        // `title` is one of the keys the adapter documents as never null when
        // anything is playing, so its absence means nothing is playing.
        if (!data || !data.title) {
          tracker.reset();
          onTrack(null);
          return;
        }

        onTrack(tracker.accept(data));
      });
    });
  }

  function start() {
    stop();
    const config = getConfig();
    const interval = Math.max(600, (config && config.music && config.music.pollMs) || 1500);
    readOnce();
    timer = setInterval(readOnce, interval);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  start();

  return {
    start,
    stop,
    status: () => ({
      available: !!resolvedBinary,
      binary: resolvedBinary,
      reason: unavailableReason,
    }),
  };
}

module.exports = { install, probe, TrackTracker };
