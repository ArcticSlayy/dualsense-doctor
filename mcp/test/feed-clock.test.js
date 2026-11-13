import test from 'node:test';
import assert from 'node:assert/strict';
import {startFeedClock} from '../feed-clock.js';

function fakeClock() {
  let time = 0;
  const pending = new Set(), scheduled = [], cancelled = [];
  const options = {
    now: () => time,
    setTimer(callback, delay) {
      const timer = {callback, delay, due: time + delay, unrefs: 0,
        unref() { this.unrefs++; }};
      pending.add(timer);
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) { cancelled.push(timer); pending.delete(timer); }
  };
  return {
    options, pending, scheduled, cancelled,
    now: () => time,
    advance(ms) { time += ms; },
    wake({late = 0, at} = {}) {
      assert.equal(pending.size, 1, 'one outstanding wakeup');
      const timer = [...pending][0];
      pending.delete(timer);
      time = at ?? timer.due + late;
      timer.callback();
    }
  };
}

test('absolute deadlines prevent a 4 ms wake delay accumulating into 12 ms cadence', () => {
  const clock = fakeClock(), ticks = [];
  const stop = startFeedClock(() => ticks.push(clock.now()), clock.options);
  assert.deepEqual(ticks, []);
  for (let i = 0; i < 100; i++) clock.wake({late: 4});
  assert.equal(ticks.length, 100);
  assert.deepEqual(ticks.slice(0, 3), [12, 20, 28]);
  assert.equal(ticks.at(-1), 804);
  assert.equal((ticks.length - 1) * 1000 / (ticks.at(-1) - ticks[0]), 125);
  assert.ok(clock.scheduled.every(timer => timer.delay >= 1 && timer.unrefs === 1));
  stop();
});

test('a long stall emits once and skips expired intervals without catchup bursts', () => {
  const clock = fakeClock(), ticks = [];
  const stop = startFeedClock(() => ticks.push(clock.now()), clock.options);
  clock.wake({at: 100});
  assert.deepEqual(ticks, [100]);
  assert.equal(clock.scheduled.at(-1).due, 104);
  clock.wake();
  assert.deepEqual(ticks, [100, 104]);
  stop();
});

test('time spent in a tick also skips deadlines instead of queuing catchup work', () => {
  const clock = fakeClock(), ticks = [];
  const stop = startFeedClock(() => {
    ticks.push(clock.now());
    clock.advance(18);
  }, clock.options);
  clock.wake();
  assert.deepEqual(ticks, [8]);
  assert.equal(clock.scheduled.at(-1).due, 32);
  clock.wake();
  assert.deepEqual(ticks, [8, 32]);
  stop();
});

test('an early wake waits until its deadline with at least a 1 ms timer', () => {
  const clock = fakeClock(), ticks = [];
  const stop = startFeedClock(() => ticks.push(clock.now()), clock.options);
  clock.wake({at: 7.5});
  assert.deepEqual(ticks, []);
  assert.equal(clock.scheduled.at(-1).delay, 1);
  clock.wake();
  assert.deepEqual(ticks, [8.5]);
  stop();
});

test('stop cancels the outstanding timer once and ignores a stale callback', () => {
  const clock = fakeClock(), ticks = [];
  const stop = startFeedClock(() => ticks.push(clock.now()), clock.options);
  const timer = [...clock.pending][0];
  stop();
  stop();
  timer.callback();
  assert.deepEqual(ticks, []);
  assert.equal(clock.pending.size, 0);
  assert.deepEqual(clock.cancelled, [timer]);
});

test('stop called inside a tick prevents rescheduling and is safe to repeat', () => {
  const clock = fakeClock();
  let ticks = 0;
  const stop = startFeedClock(() => { ticks++; stop(); stop(); }, clock.options);
  clock.wake();
  assert.equal(ticks, 1);
  assert.equal(clock.pending.size, 0);
  assert.equal(clock.scheduled.length, 1);
});

test('numeric timer handles work without unref', () => {
  let callback, cleared;
  const stop = startFeedClock(() => {}, {
    now: () => 0,
    setTimer(fn) { callback = fn; return 0; },
    clearTimer(timer) { cleared = timer; }
  });
  assert.equal(typeof callback, 'function');
  stop();
  assert.equal(cleared, 0);
});

test('invalid callbacks and intervals fail before scheduling', () => {
  const clock = fakeClock();
  assert.throws(() => startFeedClock(null, clock.options), TypeError);
  for (const intervalMs of [0, -1, NaN, Infinity, '8']) {
    assert.throws(() => startFeedClock(() => {}, {...clock.options, intervalMs}), RangeError);
  }
  for (const name of ['now', 'setTimer', 'clearTimer']) {
    assert.throws(() => startFeedClock(() => {}, {...clock.options, [name]: null}), TypeError);
  }
  assert.throws(() => startFeedClock(() => {}, {...clock.options, now: () => NaN}), RangeError);
  assert.equal(clock.scheduled.length, 0);
});
