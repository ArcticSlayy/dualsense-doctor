# Reviewed calibration workflow

This guide covers the optional calibration lifecycle controlled through `live_coach_control`. It is separate from guided measurements and the legacy gated recalibration command.

**Qualification:** automated hardware-free checks only. No physical trial, save, restart, or readback has been performed. Independent review and controlled hardware qualification remain pending.

## Actions

1. **Check** (`calibration_inspect`) reads current state. A save candidate requires a complete baseline measurement tied to the controller identity and calibration words.
2. **Temporary center trial** (`calibration_trial`) requires explicit confirmation and a three-second hands-off countdown. It changes the controller's current working calibration state while permanent memory remains locked. It does not write range calibration or permanently save the new center. Use a standard DualSense (not Edge) over USB.
3. **Full retest** (`calibration_retest`) runs the complete guided measurement in the original session over the same USB connection. The review is bound to that exact trial and evidence.
4. **Explicit save** (`calibration_save`) requires the current review ID and a separate save confirmation. It saves the exact reviewed words using the NVS unlock/lock sequence. It does not re-sample the center or write calibration/range values. A completed test does not approve a save.
5. **Owner-confirmed restart and readback** (`calibration_verify`) is separate. The user must actually restart or power-cycle the controller and confirm it; the software does not detect a restart. The verifier reads back the expected values.
6. **Explicit reboot request** (`calibration_reboot`) is separate and never automatic. Restarting with an unsaved temporary adjustment discards it and requires confirmation.

The temporary trial is an adjustment in the controller's working state, not a software-only presentation change. Restarting before saving discards it.

## Evidence and limits

The workflow records a local last-saved receipt. No firmware save timestamp is available through this workflow, so this is not a firmware timestamp. “Save acknowledged” reports the NVS operation response; it does not prove persistence. Only owner-confirmed restart followed by matching readback reaches the verified state. Do not automatically retry an ambiguous write.

There is no guarantee of zero drift. Calibration cannot repair worn components. Reports describe observed data under recorded conditions, not future behavior.

Generic measurement tools (`start_session`, `capture_phase`, `run_guided_session`, report reading, and comparison) do not write calibration. The optional `live_coach_control` actions are the separate route for this reviewed lifecycle.

## Existing legacy command

The inherited `recalibrate_center` command remains unchanged and disabled unless `DUALSENSE_MCP_ALLOW_CALIBRATION=1` is set. When enabled, it performs its own center recalibration and NVS save in one USB operation. It is not save-only and must not be used as the final step for a separately tested candidate. The reviewed workflow does not alter or replace it.

## Local evidence

Session reports and the calibration history journal may contain raw input or controller-related data. Keep them private. Generated card runtime HTML and the local capability are also private.
Reconnection clears the displayed verification association until a read-only inspection identifies the controller. Interrupted-trial recovery requires a confirmed restart of the same controller in locked mode. The worker uses the configured session directory and holds operation ownership until its process closes, even after a pipe error.
