// Pointer smoothing and tracking diagnostics.
//
// Exposed on window so the overlay can use it directly and tests can evaluate
// this file against a stubbed window.
(function (root) {
// One Euro filter: an exponential filter whose cutoff rises with speed. A fixed
// smoothing factor has to choose between jitter when the hand is still and lag
// when it moves; this trades between them continuously instead.
class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.045, derivativeCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.reset();
  }

  reset() {
    this.hasPrevious = false;
    this.previousValue = 0;
    this.previousDerivative = 0;
    this.lastTimestamp = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, timestamp) {
    if (!this.hasPrevious) {
      this.hasPrevious = true;
      this.previousValue = value;
      this.previousDerivative = 0;
      this.lastTimestamp = timestamp;
      return value;
    }

    const dt = Math.min(0.1, Math.max(1 / 240, (timestamp - this.lastTimestamp) / 1000));
    this.lastTimestamp = timestamp;

    const rawDerivative = (value - this.previousValue) / dt;
    const derivativeAlpha = OneEuroFilter.alpha(this.derivativeCutoff, dt);
    const derivative = this.previousDerivative + derivativeAlpha * (rawDerivative - this.previousDerivative);
    this.previousDerivative = derivative;

    const cutoff = this.minCutoff + this.beta * Math.abs(derivative);
    const alpha = OneEuroFilter.alpha(cutoff, dt);
    const filtered = this.previousValue + alpha * (value - this.previousValue);
    this.previousValue = filtered;
    return filtered;
  }
}

// Wraps the two axis filters, plus the two corrections that a plain low-pass
// cannot express: a deadzone that freezes sub-pixel tremor while the hand is
// parked, and a short forward projection that pays back part of the pipeline
// latency instead of smoothing it into visible lag.
class PointerFilter {
  constructor(tuning) {
    this.tuning = { ...PointerFilter.defaults, ...tuning };
    this.x = new OneEuroFilter(this.filterOptions());
    this.y = new OneEuroFilter(this.filterOptions());
    this.reset();
  }

  static get defaults() {
    return {
      minCutoff: 1.2,
      beta: 0.045,
      derivativeCutoff: 1,
      deadzone: 1.6,
      prediction: 0.35,
      maxPrediction: 26,
    };
  }

  filterOptions() {
    return {
      minCutoff: this.tuning.minCutoff,
      beta: this.tuning.beta,
      derivativeCutoff: this.tuning.derivativeCutoff,
    };
  }

  setTuning(tuning) {
    this.tuning = { ...this.tuning, ...tuning };
    for (const axis of [this.x, this.y]) {
      axis.minCutoff = this.tuning.minCutoff;
      axis.beta = this.tuning.beta;
      axis.derivativeCutoff = this.tuning.derivativeCutoff;
    }
  }

  reset() {
    this.x.reset();
    this.y.reset();
    this.output = null;
    this.velocity = { x: 0, y: 0 };
    this.lastTimestamp = 0;
  }

  update(rawX, rawY, timestamp) {
    const filteredX = this.x.filter(rawX, timestamp);
    const filteredY = this.y.filter(rawY, timestamp);

    if (!this.output) {
      this.output = { x: filteredX, y: filteredY };
      this.lastTimestamp = timestamp;
      return { ...this.output, held: false };
    }

    const dt = Math.max(1, timestamp - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestamp;
    this.velocity = {
      x: (filteredX - this.output.x) / dt,
      y: (filteredY - this.output.y) / dt,
    };

    const step = Math.hypot(filteredX - this.output.x, filteredY - this.output.y);
    // Below the deadzone the hand is considered parked: hold position so the
    // cursor does not crawl while the user is aiming at a small target.
    if (step < this.tuning.deadzone) {
      return { ...this.output, held: true };
    }

    this.output = { x: filteredX, y: filteredY };
    // Project along current velocity by a fraction of a frame to offset part of
    // the capture-to-event latency, clamped so a tracking glitch cannot fling
    // the cursor across the screen.
    const lead = this.tuning.prediction / 60;
    const projectX = clamp(this.velocity.x * lead, -this.tuning.maxPrediction, this.tuning.maxPrediction);
    const projectY = clamp(this.velocity.y * lead, -this.tuning.maxPrediction, this.tuning.maxPrediction);
    return { x: filteredX + projectX, y: filteredY + projectY, held: false };
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class Series {
  constructor(capacity = 120) {
    this.capacity = capacity;
    this.values = [];
  }

  push(value) {
    if (!Number.isFinite(value)) return;
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }

  get length() {
    return this.values.length;
  }

  mean() {
    if (!this.values.length) return 0;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }

  percentile(p) {
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const index = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
    return sorted[index];
  }

  max() {
    return this.values.length ? Math.max(...this.values) : 0;
  }

  clear() {
    this.values = [];
  }
}

// Everything the tuning feedback loop needs: how fast the pipeline runs, how
// much of the delay is ours, how much the cursor trembles when the hand is
// still, and how far behind the raw landmark the smoothed cursor sits.
class TrackingMetrics {
  constructor() {
    this.inferenceMs = new Series();
    this.frameIntervalMs = new Series();
    this.drawIntervalMs = new Series();
    this.pipelineMs = new Series();
    this.jitterPx = new Series();
    this.lagPx = new Series();
    this.matchDistance = new Series(60);
    this.counters = { frames: 0, inferences: 0, skipped: 0, handFrames: 0, emptyFrames: 0, pointerEvents: 0 };
    this.stillWindow = [];
    this.lastFrameAt = 0;
    this.lastDrawAt = 0;
    this.startedAt = 0;
  }

  markFrame(now) {
    this.counters.frames += 1;
    if (this.lastFrameAt) this.frameIntervalMs.push(now - this.lastFrameAt);
    this.lastFrameAt = now;
    if (!this.startedAt) this.startedAt = now;
  }

  markSkippedFrame() {
    this.counters.skipped += 1;
  }

  markInference(durationMs) {
    this.counters.inferences += 1;
    this.inferenceMs.push(durationMs);
  }

  markDraw(now) {
    if (this.lastDrawAt) this.drawIntervalMs.push(now - this.lastDrawAt);
    this.lastDrawAt = now;
  }

  markHands(count) {
    if (count > 0) this.counters.handFrames += 1;
    else this.counters.emptyFrames += 1;
  }

  markPipeline(capturedAt, now) {
    if (capturedAt) this.pipelineMs.push(now - capturedAt);
  }

  markPointerEvent() {
    this.counters.pointerEvents += 1;
  }

  markMatchDistance(distance) {
    if (Number.isFinite(distance)) this.matchDistance.push(distance);
  }

  // Jitter is only meaningful while the hand is parked, so the raw landmark
  // decides whether the sample counts and the filtered cursor is what gets
  // measured. Measuring during motion would report speed, not tremor.
  markCursor(rawX, rawY, cursorX, cursorY) {
    this.lagPx.push(Math.hypot(rawX - cursorX, rawY - cursorY));
    this.stillWindow.push({ rawX, rawY, cursorX, cursorY });
    if (this.stillWindow.length > 12) this.stillWindow.shift();
    if (this.stillWindow.length < 12) return;

    const rawSpread = spread(this.stillWindow.map((s) => [s.rawX, s.rawY]));
    if (rawSpread > 9) return;
    this.jitterPx.push(spread(this.stillWindow.map((s) => [s.cursorX, s.cursorY])));
  }

  fps(series) {
    const mean = series.mean();
    return mean > 0 ? 1000 / mean : 0;
  }

  snapshot() {
    const total = this.counters.handFrames + this.counters.emptyFrames;
    return {
      cameraFps: Number(this.fps(this.frameIntervalMs).toFixed(1)),
      drawFps: Number(this.fps(this.drawIntervalMs).toFixed(1)),
      inferenceMs: Number(this.inferenceMs.mean().toFixed(1)),
      inferenceP95Ms: Number(this.inferenceMs.percentile(95).toFixed(1)),
      pipelineMs: Number(this.pipelineMs.mean().toFixed(1)),
      pipelineP95Ms: Number(this.pipelineMs.percentile(95).toFixed(1)),
      jitterPx: Number(this.jitterPx.mean().toFixed(2)),
      jitterMaxPx: Number(this.jitterPx.max().toFixed(2)),
      lagPx: Number(this.lagPx.mean().toFixed(1)),
      matchDistance: this.matchDistance.length ? Number(this.matchDistance.mean().toFixed(3)) : null,
      matchBestDistance: this.matchDistance.length ? Number(this.matchDistance.percentile(5).toFixed(3)) : null,
      trackingRate: total ? Number(((this.counters.handFrames / total) * 100).toFixed(1)) : 0,
      skippedFrames: this.counters.skipped,
      inferences: this.counters.inferences,
      pointerEvents: this.counters.pointerEvents,
      jitterSamples: this.jitterPx.length,
    };
  }

  reset() {
    for (const series of [
      this.inferenceMs,
      this.frameIntervalMs,
      this.drawIntervalMs,
      this.pipelineMs,
      this.jitterPx,
      this.lagPx,
      this.matchDistance,
    ]) {
      series.clear();
    }
    this.counters = { frames: 0, inferences: 0, skipped: 0, handFrames: 0, emptyFrames: 0, pointerEvents: 0 };
    this.stillWindow = [];
    this.lastFrameAt = 0;
    this.lastDrawAt = 0;
    this.startedAt = 0;
  }
}

function spread(points) {
  const n = points.length;
  if (!n) return 0;
  const cx = points.reduce((acc, p) => acc + p[0], 0) / n;
  const cy = points.reduce((acc, p) => acc + p[1], 0) / n;
  const variance = points.reduce((acc, p) => acc + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / n;
  return Math.sqrt(variance);
}

root.AirCursorTracking = { OneEuroFilter, PointerFilter, TrackingMetrics, Series, spread };
})(typeof window === "undefined" ? globalThis : window);
