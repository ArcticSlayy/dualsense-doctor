# Temporary axis microtrim: assessment, not an implemented control

A fixed center trim is worth investigating when repeated untouched returns show
a consistent directional offset. It is not a demonstrated remedy for a stick that
centers in quiet captures but varies during button use or after different releases.
Keep direction-labeled release and settling windows separate before choosing a delta.
Neither this assessment nor a calibration guarantees stable zero-deadzone gameplay.

## Protocol evidence

Primary reference pinned to dualshock-tools commit
`b7cdcfaacfadfac5e80f4f40b16e85503a488e63`:

- [Fine-tune implementation](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/b7cdcfaacfadfac5e80f4f40b16e85503a488e63/js/modals/finetune-modal.js)
  orders twelve unsigned 16-bit words as LL, LT, RL, RT, LR, LB, RR, RB,
  LX, LY, RX, RY. Right center indices are 10 and 11 (zero based).
  Its UI increases center X/Y words for left/up adjustments.
- [DS5 implementation](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/b7cdcfaacfadfac5e80f4f40b16e85503a488e63/js/controllers/ds5-controller.js)
  reads twelve little-endian words starting at response byte 4. The separate
  fine-tune writer sends report 0x80, payload `[12,1,...24 word bytes]`.
  Working-state writes and flash/save are separate operations.

A calibration-word count is not an 8-bit input-report count or a game percentage.
The conversion and a suitable cumulative adjustment bound are not qualified here.
Preserving range words numerically does not prove unchanged effective range response.

## Requirements before exposing an experimental control

1. Bind to the same verified standard DualSense, fresh USB input and exclusive HID
   ownership. Require NVS already locked in temporary mode; refuse unlocked/unknown
   state instead of changing it automatically.
2. Durably checkpoint identity, all twelve words and the supporting evidence before
   mutation. Reread and require an exact match immediately before writing.
3. Accept one explicit right center axis and a signed relative integer delta in
   native calibration counts. A one-count experiment and its cumulative bound need
   separate review and physical qualification; reject overflow and limit violations.
4. Copy the other eleven words unchanged, including all eight range words. Verify
   all twelve words after the write. An uncertain result stops; no automatic retry.
5. Give the trim its own action kind and calibration epoch. Invalidate previous
   approval and require a complete fresh retest of center, release and range tied
   to the exact new words. Do not disguise it as automatic `temporary_center`.
6. Keep exact-candidate Save as a separate explicit decision, followed by a real
   owner-confirmed restart and matching readback. Any restore is another explicit
   write to the checkpoint with identity/readback checks, not an invisible rollback.

No tool, card control or hardware writer is added by this document. Implementation
and physical qualification remain pending a justified measurement case.
