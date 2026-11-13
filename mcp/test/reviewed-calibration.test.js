import test from 'node:test';
import assert from 'node:assert/strict';
import * as reviewedCalibration from '../reviewed-calibration.js';
const { saveReviewedCalibration, verifyCalibrationAfterRestart, inspectReviewedCalibration } = reviewedCalibration;

const ID = { productId: 0x0ce6, serialNumber: 'FIXTURE'.padEnd(17, '0') };
const WORDS = Array.from({ length: 12 }, (_, i) => 10000 + i * 100);
const frame = (head = []) => [...head, ...Array(64 - head.length).fill(0)];

function fixture(options = {}) {
  const sent = [];
  let packet, status = options.initialStatus ?? 'locked(temporary)', words = [...WORDS], factorySerial = options.factorySerial ?? ID.serialNumber;
  const c = {
    info: { ...ID, path: 'fixture-path' }, mode: 'usb', isEdge: false,
    readSticksOnce() {}, _nvsStatus() { return status; },
    dev: {
      sendFeatureReport(p) {
        packet = [...p]; sent.push(packet);
        if (p[0] === 0x80 && p[1] === 3 && p[2] === 2) {
          status = 'unlocked(permanent)';
          if (options.unlockThrows) throw Error('transport lost after unlock write');
          if (options.shortWrite) return 1;
        }
        if (p[0] === 0x80 && p[1] === 3 && p[2] === 1) {
          if (options.lockThrows) throw Error('relock failed');
          status = options.finalStatus ?? 'locked(temporary)';
          if (options.changeWords) words[0]++;
        }
        return p.length;
      },
      getFeatureReport() {
        if (packet[1] === 1 && packet[2] === 19) {
          if (Object.hasOwn(options, 'serialReport')) return options.serialReport;
          return frame([0x81, 1, 19, 2, ...Array.from(factorySerial, c => c.charCodeAt(0))]);
        }
        if (packet[1] === 12) return frame([0x81, 12, 2, 2, ...words.flatMap(n => [n & 255, n >> 8])]);
        if (packet[1] === 3 && packet[2] === 3) {
          if (options.badStatusFrame) return frame([0, 3, 3, 2, 1]);
          const value = { 'locked(temporary)': 1, 'unlocked(permanent)': 0 }[status];
          return value === undefined ? frame([0x81, 0, 0, 0, 0]) : frame([0x81, 3, 3, 2, value]);
        }
        if (packet[2] === 2 && options.unlockAck !== undefined) return options.unlockAck;
        if (packet[2] === 1 && options.lockAck !== undefined) return options.lockAck;
        return frame([0x81]); // Payload is deliberately opaque: no invented command ACK.
      },
    },
  };
  const writes = () => sent.filter(p => p[0] === 0x80 && p[1] === 3 && [1, 2].includes(p[2]));
  return { c, sent, writes, setWords(next) { words = [...next]; }, setStatus(next) { status = next; }, setFactorySerial(next) { factorySerial = next; } };
}
const opts = () => ({ confirm: 'SAVE_REVIEWED_CALIBRATION', expectedController: { ...ID }, expectedWords: [...WORDS], checkpoint: async () => {}, pause: async () => {} });

test('save preserves the reviewed candidate and sends only one unlock and one lock', async () => {
  const f = fixture(); let checkpointed = false;
  const result = await saveReviewedCalibration(f.c, { ...opts(), checkpoint(before) {
    assert.deepEqual(before.words, WORDS); assert.equal(f.writes().length, 0); checkpointed = true;
  } });
  assert.equal(checkpointed, true);
  assert.deepEqual(f.writes(), [[0x80, 3, 2, 101, 50, 64, 12], [0x80, 3, 1]]);
  assert.ok(f.sent.every(p => ![0x82,0x83].includes(p[0])));
  assert.equal(result.status, 'save_acknowledged');
  assert.equal(result.saveAcknowledged, true);
  assert.equal(result.persistenceVerified, false);
});

test('settling failures do not contradict acknowledged transfers', async () => {
  const f=fixture();let calls=0;
  const result=await saveReviewedCalibration(f.c,{...opts(),pause:async()=>{if(++calls===2)throw Error('settle interrupted');}});
  assert.equal(result.lockAcknowledged,true);assert.equal(result.status,'ambiguous');
  assert.deepEqual(result.issues.map(i=>i.stage),['relock_settle']);assert.equal(f.writes().length,2);
});

test('invalid options and handles produce actionable errors before any transfer',async()=>{
  const f=fixture();
  await assert.rejects(saveReviewedCalibration(f.c,null),/options/);
  await assert.rejects(verifyCalibrationAfterRestart(f.c,null),/options/);
  await assert.rejects(inspectReviewedCalibration({}),/compatible controller handle/);
  await assert.rejects(saveReviewedCalibration(f.c,{...opts(),pause:null}),/pause/);
  assert.equal(f.sent.length,0);
});

test('a stalled checkpoint expires before NVS writes and releases the handle guard',async()=>{
  const f=fixture();
  await assert.rejects(saveReviewedCalibration(f.c,{...opts(),checkpointTimeoutMs:5,checkpoint:()=>new Promise(()=>{})}),/Checkpoint did not finish/);
  assert.equal(f.writes().length,0);
  assert.equal((await inspectReviewedCalibration(f.c)).factorySerialNumber,ID.serialNumber);
});

test('confirmation, exact words, stable identity, and checkpoint are mandatory before access', async () => {
  for (const override of [
    { confirm: true }, { expectedWords: WORDS.slice(1) }, { expectedWords: Array(12) }, { expectedWords: [...WORDS.slice(1), NaN] },
    { expectedWords: [...WORDS.slice(1), 65536] }, { expectedController: { productId: 0x0ce6, path: 'fixture-path' } },
    { checkpoint: null },
  ]) {
    const f = fixture(); await assert.rejects(saveReviewedCalibration(f.c, { ...opts(), ...override }));
    assert.equal(f.sent.length, 0);
  }
});

test('wrong controller or unsupported transport never reaches an NVS write', async () => {
  for (const change of [c => { c.info.productId = 0x0df2; }, c => { c.mode = 'bt'; }, c => { c.isEdge = true; }]) {
    const f = fixture(); change(f.c); await assert.rejects(saveReviewedCalibration(f.c, opts()));
    assert.equal(f.writes().length, 0);
  }
});

test('changed calibration, unlocked/unknown mode, and malformed status cannot be saved', async () => {
  for (const options of [{ initialStatus: 'unlocked(permanent)' }, { initialStatus: 'unknown(0x0)' }, { badStatusFrame: true }, { differentWords: true }]) {
    const f = fixture(options); if (options.differentWords) f.setWords(WORDS.map(n => n + 1));
    await assert.rejects(saveReviewedCalibration(f.c, opts())); assert.equal(f.writes().length, 0);
  }
});

test('checkpoint failure and state change during checkpoint prevent saving', async () => {
  for (const change of [() => { throw Error('disk full'); }, f => f.setWords(WORDS.map(n => n + 1)), f => f.setStatus('unlocked(permanent)')]) {
    const f = fixture(); await assert.rejects(saveReviewedCalibration(f.c, { ...opts(), checkpoint: () => change(f) }));
    assert.equal(f.writes().length, 0);
  }
});

test('caller mutation during checkpoint cannot replace the reviewed candidate', async () => {
  const f = fixture(), input = opts(); input.checkpoint = () => { input.expectedWords[0]++; f.setWords(input.expectedWords); };
  await assert.rejects(saveReviewedCalibration(f.c, input)); assert.equal(f.writes().length, 0);
});

test('empty, short, wrong-report and malformed ACKs remain ambiguous after relock', async () => {
  for (const ack of [[], [0x81], frame([0x80]), [...frame([0x81]).slice(1), 256]]) {
    for (const key of ['unlockAck', 'lockAck']) {
      const f = fixture({ [key]: ack }); const result = await saveReviewedCalibration(f.c, opts());
      assert.equal(result.status, 'ambiguous'); assert.equal(result.saveAcknowledged, false);
      assert.equal(result.persistenceVerified, false); assert.equal(f.writes().length, 2);
      assert.ok(result.issues.length > 0);
    }
  }
});

test('uncertain unlock and incomplete transfer still attempt one relock without retrying', async () => {
  for (const options of [{ unlockThrows: true }, { shortWrite: true }]) {
    const f = fixture(options), result = await saveReviewedCalibration(f.c, opts());
    assert.equal(result.status, 'ambiguous'); assert.equal(f.writes().length, 2);
    assert.deepEqual(f.writes().at(-1), [0x80, 3, 1]); assert.equal(result.lockAcknowledged, true);
  }
});

test('an asynchronous failure after unlock still relocks and retains an ambiguous outcome', async () => {
  for (const error of [Error('interrupted wait'), null]) {
    const f = fixture(); let pauses = 0;
    const result = await saveReviewedCalibration(f.c, { ...opts(), pause() { if (++pauses === 1) throw error; } });
    assert.equal(result.status, 'ambiguous'); assert.equal(result.lockAcknowledged, true); assert.equal(f.writes().length, 2);
  }
});

test('overlapping save or verification operations cannot interleave on one handle', async () => {
  const f = fixture(); let reached, release;
  const checkpointReached = new Promise(resolve => { reached = resolve; });
  const checkpointReleased = new Promise(resolve => { release = resolve; });
  const first = saveReviewedCalibration(f.c, { ...opts(), checkpoint() { reached(); return checkpointReleased; } });
  await checkpointReached;
  await assert.rejects(saveReviewedCalibration(f.c, opts()), /already active/);
  await assert.rejects(verifyCalibrationAfterRestart(f.c, { ...opts(), restartConfirmed: true }), /already active/);
  assert.equal(f.writes().length, 0);
  release(); assert.equal((await first).status, 'save_acknowledged');
});

test('failed relock or unlocked final state cannot be reported as successful saving', async () => {
  for (const options of [{ lockThrows: true }, { finalStatus: 'unlocked(permanent)' }]) {
    const f = fixture(options), result = await saveReviewedCalibration(f.c, opts());
    assert.equal(result.status, 'ambiguous'); assert.equal(result.saveAcknowledged, false);
    assert.equal(result.persistenceVerified, false); assert.equal(f.writes().length, 2);
  }
});

test('changed readback after saving is ambiguous rather than a different approved candidate', async () => {
  const f = fixture({ changeWords: true }), result = await saveReviewedCalibration(f.c, opts());
  assert.equal(result.status, 'ambiguous'); assert.equal(result.calibrationMatches, false);
});

test('restart verification requires physical confirmation and performs no mutation', async () => {
  const f = fixture(), expected = { expectedController: { ...ID }, expectedWords: [...WORDS] };
  await assert.rejects(verifyCalibrationAfterRestart(f.c, expected)); assert.equal(f.sent.length, 0);
  const result = await verifyCalibrationAfterRestart(f.c, { ...expected, restartConfirmed: true });
  assert.equal(result.persistenceVerified, true); assert.equal(result.restartEvidence, 'owner_confirmed');
  assert.equal(f.writes().length, 0); assert.ok(f.sent.every(p => p[0] !== 0x82));
});

test('restart verification reports mismatch and refuses a different controller or unlocked mode', async () => {
  const input = { expectedController: { ...ID }, expectedWords: [...WORDS], restartConfirmed: true };
  const f = fixture(); f.setWords(WORDS.map(n => n + 1));
  const result = await verifyCalibrationAfterRestart(f.c, input);
  assert.equal(result.persistenceVerified, false); assert.equal(result.status, 'mismatch');
  f.setFactorySerial('ANOTHER'.padEnd(17, '0')); await assert.rejects(verifyCalibrationAfterRestart(f.c, input));
  const other = fixture({ initialStatus: 'unlocked(permanent)' });
  await assert.rejects(verifyCalibrationAfterRestart(other.c, input)); assert.equal(other.writes().length, 0);
});

test('read-only inspection returns factory identity without changing missing HID metadata', async () => {
  const f = fixture(); f.c.info.serialNumber = null; const originalInfo = { ...f.c.info };
  const snapshot = await inspectReviewedCalibration(f.c);
  assert.equal(snapshot.factorySerialNumber, ID.serialNumber);
  assert.equal(snapshot.controller.serialNumber, ID.serialNumber);
  assert.equal(snapshot.identitySource, 'factory_feature_report');
  assert.deepEqual(f.c.info, originalInfo); assert.notEqual(snapshot.controller, f.c.info);
  assert.ok(f.sent.some(p => p.join(',') === '128,1,19'));
  assert.equal(f.writes().length, 0); assert.ok(f.sent.every(p => p[0] !== 0x82));
});

test('save and restart verification bind factory identity rather than enumeration serial or path', async () => {
  for (const hidSerial of [null, 'different-hid-metadata']) {
    const f = fixture(); f.c.info.serialNumber = hidSerial;
    const result = await saveReviewedCalibration(f.c, { ...opts(), checkpoint(before) { assert.equal(before.controller.serialNumber, ID.serialNumber); } });
    assert.equal(result.status, 'save_acknowledged'); assert.equal(f.c.info.serialNumber, hidSerial);
    f.c.info.path = 'changed-path-after-restart';
    const verification = await verifyCalibrationAfterRestart(f.c, { ...opts(), restartConfirmed: true });
    assert.equal(verification.persistenceVerified, true); assert.equal(f.c.info.serialNumber, hidSerial);
  }
});

test('missing or malformed factory identity prevents every NVS write', async () => {
  const serialBytes = Array.from(ID.serialNumber, c => c.charCodeAt(0));
  for (const serialReport of [
    null, [], [0x81, 1, 19, 2, ...serialBytes], frame([0x80, 1, 19, 2, ...serialBytes]),
    frame([0x81, 9, 19, 2, ...serialBytes]), frame([0x81, 1, 18, 2, ...serialBytes]),
    frame([0x81, 1, 19, 0, ...serialBytes]), frame([0x81, 1, 19, 2]),
    frame([0x81, 1, 19, 2, ...Array(17).fill(32)]), frame([0x81, 1, 19, 2, 65, 0, 66]),
    frame([0x81, 1, 19, 2, 65, 127]), frame([0x81, 1, 19, 2, 65, 128]),
  ]) {
    const f = fixture({ serialReport });
    await assert.rejects(saveReviewedCalibration(f.c, opts())); assert.equal(f.writes().length, 0);
  }
});

test('matching enumeration metadata cannot substitute for a wrong factory serial', async () => {
  const f = fixture({ factorySerial: 'OTHER'.padEnd(17, '0') });
  assert.equal(f.c.info.serialNumber, ID.serialNumber);
  await assert.rejects(saveReviewedCalibration(f.c, opts()), /identity/);
  await assert.rejects(verifyCalibrationAfterRestart(f.c, { ...opts(), restartConfirmed: true }), /identity/);
  assert.equal(f.writes().length, 0);
});

test('factory identity is rechecked after the durable checkpoint', async () => {
  const f = fixture();
  await assert.rejects(saveReviewedCalibration(f.c, { ...opts(), checkpoint() { f.setFactorySerial('OTHER'.padEnd(17, '0')); } }), /identity/);
  assert.equal(f.writes().length, 0);
});

test('short printable factory serials accept trailing NUL padding with consistent expected normalization', async () => {
  const f = fixture({ factorySerial: 'SHORT-SERIAL' }); f.c.info.serialNumber = null;
  const snapshot = await inspectReviewedCalibration(f.c);
  assert.equal(snapshot.factorySerialNumber, 'SHORT-SERIAL');
  const options = { ...opts(), expectedController: { productId: ID.productId, serialNumber: 'SHORT-SERIAL'.padEnd(17, '\0') } };
  assert.equal((await saveReviewedCalibration(f.c, options)).status, 'save_acknowledged');
  assert.equal((await verifyCalibrationAfterRestart(f.c, { ...options, restartConfirmed: true })).persistenceVerified, true);
});
