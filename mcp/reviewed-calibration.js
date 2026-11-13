// Save-only protocol; callers must bind it to reviewed session evidence.
// Protocol: dualshock-tools/js/controllers/ds5-controller.js (MIT), flash()
// and getSystemInfo(1, 19, 17).
// A caller must first bind review/approval to durable session evidence. Supplying
// expected words here does NOT establish that they were tested or approved.
import { inspectCalibration } from './temporary-center.js';

const LOCKED = 'locked(temporary)';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const equalWords = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
const activeControllers = new WeakSet();
function errorMessage(error) {
  try { return String(error?.message ?? error); } catch { return 'Unspecified transport error'; }
}

async function exclusive(c, action) {
  if (!c || typeof c !== 'object' || typeof c.readSticksOnce!=='function' || typeof c._nvsStatus!=='function') throw Error('A compatible controller handle is required.');
  if (activeControllers.has(c)) throw Error('A calibration operation is already active on this handle.');
  activeControllers.add(c);
  try { return await action(); } finally { activeControllers.delete(c); }
}

function expectedCandidate(expectedController, expectedWords) {
  if (expectedController?.productId !== 0x0ce6) {
    throw Error('A standard DualSense factory identity is required; a HID path alone is insufficient.');
  }
  const serialNumber = canonicalSerial(expectedController.serialNumber);
  if (!Array.isArray(expectedWords) || expectedWords.length !== 12 ||
      Array.from(expectedWords).some(n => !Number.isInteger(n) || n < 0 || n > 65535)) {
    throw Error('Expected calibration must contain exactly twelve unsigned 16-bit words.');
  }
  return {
    controller: Object.freeze({ productId: expectedController.productId, serialNumber }),
    words: Object.freeze([...expectedWords]),
  };
}

function canonicalSerial(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 17) {
    throw Error('Factory serial must fit the documented 17-byte field.');
  }
  // The field has capacity 17; a shorter serial may have trailing NUL padding.
  // Preserve printable spaces exactly, but reject an entirely blank identity.
  const serial = value.replace(/\0+$/, '');
  if (!serial.trim() || /[^\x20-\x7e]/.test(serial)) {
    throw Error('Factory serial must be nonblank printable ASCII with trailing NUL padding only.');
  }
  return serial;
}

function assertIdentity(actual, expected) {
  if (actual?.productId !== expected.productId || actual.serialNumber !== expected.serialNumber) {
    throw Error('Controller identity does not match the reviewed candidate.');
  }
}

function completeFeatureReport(data, label) {
  // node-hid includes the report ID. This checks transport framing only: the
  // upstream flash implementation does not document ACK payload success codes.
  if ((!Array.isArray(data) && !ArrayBuffer.isView(data)) || data.length !== 64 ||
      data[0] !== 0x81 || Array.from(data).some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw Error(`${label}: incomplete or malformed feature report.`);
  }
  return data;
}

function transfer(c, packet, label) {
  const count = c.dev.sendFeatureReport(packet);
  if (!Number.isInteger(count) || count < packet.length || count > 64) {
    throw Error(`${label}: complete transfer was not confirmed.`);
  }
  return completeFeatureReport(c.dev.getFeatureReport(0x81, 64), label);
}

async function inspectChecked(c, expected) {
  const snapshot = await inspectCalibration(c); // Enforces standard USB DualSense.
  completeFeatureReport(snapshot.raw, 'Calibration readback');
  // Independently validate status framing; the legacy _nvsStatus decoder does not.
  const data = transfer(c, [0x80, 3, 3], 'NVS status');
  const raw = ((data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4]) >>> 0;
  const nvsStatus = { 0x03030201: LOCKED, 0x03030200: 'unlocked(permanent)', 0x15010100: 'pending_reboot' }[raw];
  if (!nvsStatus || nvsStatus !== snapshot.nvsStatus) throw Error('NVS mode is unknown or changed during inspection.');
  // getSystemInfo(1, 19, 17) in the primary DS5 implementation. Enumeration
  // serials can be absent or use a different identity format; never fall back.
  const serialReport = transfer(c, [0x80, 1, 19], 'Factory serial');
  if (serialReport[1] !== 1 || serialReport[2] !== 19 || serialReport[3] !== 2) {
    throw Error('Factory serial response header is invalid.');
  }
  const factorySerialNumber = canonicalSerial(String.fromCharCode(...serialReport.slice(4, 21)));
  const result = {
    ...snapshot, factorySerialNumber, identitySource: 'factory_feature_report',
    controller: { ...snapshot.controller, serialNumber: factorySerialNumber },
  };
  if (expected) assertIdentity(result.controller, expected.controller);
  return result;
}

/** Read-only calibration and factory identity inspection. The returned controller
 * is a copy with canonical firmware serialNumber; enumeration metadata is untouched.
 * No calibration, NVS unlock/relock, reset or other output effect is issued.
 */
export async function inspectReviewedCalibration(c) {
  return exclusive(c, () => inspectChecked(c));
}

function assertReviewed(snapshot, expected) {
  if (snapshot.nvsStatus !== LOCKED) throw Error('NVS must be locked before saving the reviewed candidate.');
  if (!equalWords(snapshot.words, expected.words)) throw Error('Current calibration differs from the reviewed candidate.');
}

/** Save the current reviewed words; never recalibrate or rewrite their values.
 * expectedController.serialNumber is the factory identity from inspection, not
 * the optional HID enumeration serial. Only trailing NUL padding is normalized.
 * The checkpoint callback must durably record the pre-write state before it resolves.
 * Its durability and review provenance are obligations of the unimplemented caller.
 * After the first write attempt every uncertain outcome is returned as ambiguous.
 */
export async function saveReviewedCalibration(c, options = {}) {
  if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Calibration save options must be an object.');
  return exclusive(c, () => saveCandidate(c, options));
}

async function saveCandidate(c, {
  confirm, expectedController, expectedWords, checkpoint, pause = sleep, checkpointTimeoutMs=10000,
} = {}) {
  if (confirm !== 'SAVE_REVIEWED_CALIBRATION') throw Error('Explicit SAVE_REVIEWED_CALIBRATION confirmation is required.');
  if (typeof checkpoint !== 'function') throw Error('A durable checkpoint callback is required.');
  if (typeof pause !== 'function') throw Error('Invalid pause callback.');
  if(!Number.isInteger(checkpointTimeoutMs)||checkpointTimeoutMs<1||checkpointTimeoutMs>30000)throw Error('Checkpoint timeout must be between 1 and 30000 ms.');
  const expected = expectedCandidate(expectedController, expectedWords);
  const before = await inspectChecked(c, expected);
  assertReviewed(before, expected);
  let checkpointTimer;
  try {await Promise.race([Promise.resolve().then(()=>checkpoint(before)),new Promise((_,reject)=>{
    checkpointTimer=setTimeout(()=>reject(Error('Checkpoint did not finish in time; no NVS write was attempted.')),checkpointTimeoutMs);
  })]);}finally{clearTimeout(checkpointTimer);}
  // Re-read after the await: approval must not silently follow changed values.
  assertReviewed(await inspectChecked(c, expected), expected);

  const issues = [];
  let unlockAcknowledged = false, lockAcknowledged = false, after = null;
  try {
    transfer(c, [0x80, 3, 2, 101, 50, 64, 12], 'NVS unlock');
    unlockAcknowledged = true;
  } catch (error) { issues.push({ stage: 'unlock', message: errorMessage(error) }); }
  if(unlockAcknowledged)try{await pause(150);}catch(error){issues.push({stage:'unlock_settle',message:errorMessage(error)});}
  // Unlock may have reached the controller even when the write/read threw.
  // Attempt relock exactly once; never retry unlock or rerun calibration.
  try {
    transfer(c, [0x80, 3, 1], 'NVS relock');
    lockAcknowledged = true;
  } catch (error) { issues.push({ stage: 'relock', message: errorMessage(error) }); }
  if(lockAcknowledged)try{await pause(150);}catch(error){issues.push({stage:'relock_settle',message:errorMessage(error)});}
  try {
    after = await inspectChecked(c, expected);
    assertReviewed(after, expected);
  } catch (error) { issues.push({ stage: 'readback', message: errorMessage(error) }); }

  const saveAcknowledged = issues.length === 0;
  return {
    status: saveAcknowledged ? 'save_acknowledged' : 'ambiguous',
    saveAcknowledged, persistenceVerified: false, unlockAcknowledged, lockAcknowledged,
    finalNvsStatus: after?.nvsStatus ?? null,
    calibrationMatches: after ? equalWords(after.words, expected.words) : null,
    issues,
    next: saveAcknowledged
      ? 'Confirm a real controller power cycle, then compare calibration readback before claiming persistence.'
      : 'Save outcome is uncertain. Do not automatically repeat it; retain this report and inspect controller state before further writes.',
  };
}

/** Read-only persistence check. The caller/owner confirms a real power cycle;
 * this function cannot detect one and does not establish a preceding save action.
 */
export async function verifyCalibrationAfterRestart(c, options = {}) {
  if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Restart verification options must be an object.');
  return exclusive(c, () => verifyCandidate(c, options));
}

async function verifyCandidate(c, {
  expectedController, expectedWords, restartConfirmed,
} = {}) {
  if (restartConfirmed !== true) throw Error('Confirm an actual controller power cycle before verifying persistence.');
  const expected = expectedCandidate(expectedController, expectedWords);
  const snapshot = await inspectChecked(c, expected);
  if (snapshot.nvsStatus !== LOCKED) throw Error('Restart verification requires a known locked NVS mode.');
  const matches = equalWords(snapshot.words, expected.words);
  return {
    status: matches ? 'verified_after_owner_confirmed_restart' : 'mismatch',
    persistenceVerified: matches, calibrationMatches: matches,
    restartEvidence: 'owner_confirmed', restartAutomaticallyDetected: false,
    nvsStatus: snapshot.nvsStatus,
  };
}
