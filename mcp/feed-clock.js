/**
 * Schedule synchronous transport ticks on absolute monotonic deadlines.
 * Late wakes publish once; elapsed slots (including tick work) are skipped.
 * This controls transport cadence, not rendering FPS or end-to-end latency.
 */
export function startFeedClock(tick, {
  intervalMs = 8,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof tick !== 'function' || typeof now !== 'function' ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('tick, now, setTimer and clearTimer must be functions');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('intervalMs must be finite and positive');
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new RangeError('now must return a finite timestamp');
  let deadline = startedAt + intervalMs;
  let timer = null, stopped = false;

  function schedule(at) {
    // Timer delays stay bounded even when the injected interval is very large.
    timer = setTimer(wake, Math.min(2147483647, Math.max(1, deadline - at)));
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function wake() {
    if (stopped) return;
    timer = null;
    const at = now();
    if (at < deadline) { schedule(at); return; }
    tick();
    if (stopped) return;
    const afterTick = now();
    deadline += intervalMs;
    if (deadline <= afterTick) {
      deadline += (Math.floor((afterTick - deadline) / intervalMs) + 1) * intervalMs;
    }
    schedule(afterTick);
  }

  schedule(startedAt);
  return function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}
