---
name: dualsense-tuneup
description: Use when running repeatable DualSense stick checks, reviewing saved reports, or considering calibration actions through DualSense Studio MCP or its optional live card.
---

# DualSense tune-up

Use the project's README and MCP guides for the installed build, available tools, and current qualification. Keep controller-specific identifiers and raw session files private.

## Measurement

- Use `show_live_coach` when an interactive card is available; otherwise use generic guided measurement tools.
- Start a check only when the user is ready to move the sticks. Follow prompts for rest, range, release, buttons, and final verification.
- The card supports 1, 3, or 5 target rounds. Start each additional round only after the user explicitly chooses Repeat.
- Read the session report. Compare only compatible sessions from the same controller, transport, and calibration history.
- Explain that a deadzone candidate is an unapplied game-setting recommendation. Measurement does not guarantee zero drift or diagnose physical wear by itself.

## Calibration decisions

Use the reviewed calibration lifecycle only through optional `live_coach_control` actions, when available:

1. Inspect and complete a baseline check.
2. Require an explicit decision for a temporary center trial; the corresponding card button is that decision. The three-second hands-off countdown is part of the action. This changes the controller's working calibration state; it is not software-only.
3. Complete the full retest in the same session and review before/after evidence.
4. Require a separate explicit decision to save the exact reviewed candidate; the card confirmation satisfies it. A successful measurement is not save approval.
5. Treat a save acknowledgement as unverified persistence. Ask the owner to actually restart or power-cycle the controller, then confirm the restart before readback verification.

Never automatically retry an ambiguous write. The local receipt is not a firmware save timestamp. The existing gated `recalibrate_center` command recalibrates and saves in one operation; it is not a save-only shortcut. Generic measurement tools do not write calibration.

## Reporting

State what was measured, what temporary adjustment was applied, whether save was acknowledged, and whether restart readback verified persistence. Keep these statuses distinct. Do not claim physical qualification based on automated tests alone.

Use the before/after diagnostic rows to explain quiet peak, game deadzone candidate,
circularity RMS, range symmetry and release peak independently. Changes are percentage
points, not relative percentages. Missing data is unavailable, never zero. Do not
infer an overall improvement or save approval from a lower circularity figure.
## Interpret repeated measurements

Keep circularity, resting displacement, jitter, release overshoot and game deadzones
separate. DualShock Tools' roughly 7–9% RMS circularity guidance resembles stock
range; symmetry matters more than chasing zero, and it is not a universal optimum
for every module or game. Preserve useful range and small-input response.

Repeated-round recommendations cover the worst valid quiet peak plus one percentage
point, rounded up. Do not select only the best run or treat repeated measurements as
firmware training. Use a new comparison after external calibration or input-layer
changes. Saved reports remain available; continuous in-progress sessions need not
resume across process restarts.

Relay meaningful pace, direction, rim-contact and settling corrections without
asking for readiness at every stage. Countdown completion does not prove movement
passed. MCP clients may delay progress/log delivery; rendered FPS and input-feed Hz
are different measurements and neither establishes end-to-end latency.

## Optional read-only diagnostics

In the live card, Load saved checks browses individual historical measurements and
measured range sectors. Selection never changes the active calibration review. Do
not pool checks across unknown controller, transport or calibration changes. The
150% range plots retain missing directions as gaps; they are not live input.

Check trigger travel is a separate explicit input recording with a 3-second countdown
and 12-second slow pull/release sequence. It sends no effects and does not calibrate
sticks or trigger endpoints. Respect digital-trigger modifications; endpoints and
slow-sweep counts are observations, not a hardware-health score. Finish/cancel it
before other controls or calibration. It is optional and never a baseline substitute.

The view FPS tooltip measures fresh animation callbacks, gaps and synchronous JS
work. Hidden/stale periods are excluded. These values do not establish paint/GPU
performance, dropped frames or end-to-end input latency.
