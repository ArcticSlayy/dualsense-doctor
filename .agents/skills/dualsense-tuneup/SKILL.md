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


Use the directional tuning assessment in session reports and the card to explain
signed rest X/Y, quiet spread and observed axis reach separately. The live assessment
is the latest completed round, while the deadzone comparison remains conservative
across accepted rounds. Old records can lack axis evidence; never fill it with zero.
A directional quiet offset calls for a repeatability check after release, not an
automatic trial. Raw endpoints can saturate, and circle extrema are not proof of
straight-direction holds or ideal range. Keep the existing review, trial, retest,
Save and restart gates intact. Do not turn these observations into firmware-word
adjustments or a promise of zero drift. See mcp/DIAGNOSTICS.md for normalization.


## Explain what to do next

After a completed check, lead with the latest hands-off reading for each stick,
whether an adjustment was actually made, and one next action. If the small measured
resting displacement is acceptable in game, keeping the current calibration is a
valid outcome. Do not imply that each completed check requires a temporary trial.

Explain a game deadzone starting point separately from controller calibration;
this app has not applied it in the game. Use the accepted comparison's worst valid
quiet evidence when available. If recorded setups differ, show the latest valid
check separately and start a fresh comparison; do not average incompatible checks
or ask for another adjustment merely because comparison was rejected.

When asked whether drift was fixed, compare a matched before/after pair, label
maximum hands-off displacement, and keep release rebound and circularity separate.
A quieter measurement does not prove permanent zero drift. Say Save acknowledged
and values matched after the owner's restart confirmation when that is the evidence;
do not describe an independently detected power cycle. Repeated checks measure
consistency, not automatic tuning or reinforcement learning.


In the card, use Check for the movement view, Results for interpretation and optional
calibration, and Controller for display/effects/history. The instruction stays
visible across views. Follow Stop turning and hands-off preparation until the next
server instruction; no Continue click is needed. Optional: compare repeated checks
contains series goals and reset. A rejected latest check must not hide recovery or
turn earlier accepted evidence into a current result. An unavailable recommendation
calls for reviewing evidence, not prescribing a missing value.


Lead with one full check, its result, then validation in game. Three/five are optional
total check counts, not automatic recordings or repeated calibration writes. Changing
the target starts nothing; Repeat one check starts one entire guided sequence. Do not
instruct the owner to save a report or create a profile before using the controller:
completed reports are stored locally, a PNG is a separate image, controller Save is
explicit, and game settings belong in the game. The conservative deadzone suggestion
includes a margin; it is not a minimum. Keep a lower stable setting. Zero should be
validated in play, never treated as proof of better hardware calibration. The choice
of game affects settings interpretation, not the identity or validity of controller
calibration. Optional controls must not obscure an active trial or uncertain save.

Results lead with the next decision, then movement measured at rest and a separate
optional game-deadzone suggestion. Explain whether the current workflow is only a
check, an unsaved trial or a save awaiting verification. Busy/uncertain operations
take precedence over ordinary advice. Multi-check history is under optional repeats.

If Save is unavailable after a completed retest, check the current operation and review
status first. Pending, uncertain, acknowledged or verified outcomes take precedence
over retest advice. A failed or unreadable HTTP response does not establish that
nothing was saved; wait for updated status and do not repeat the write automatically.
The ten-minute
review can expire while the temporary candidate remains unsaved. Choose Retest adjustment
to obtain a fresh full review; do not recapture a new center, extend approval or save
automatically. Old local save dates do not establish that this candidate was saved.
See mcp/SAVE-REVIEW-RECOVERY.md. Axis microtrim is assessed in
mcp/AXIS-MICROTRIM-ASSESSMENT.md and is not an implemented or qualified tool.

The first Save action reveals and focuses the review group; only the separate Confirm
action sends the write. An older local save date does not verify a newer candidate.
Unplugging USB while the controller remains powered is not a power cycle, and
I restarted — verify confirms the owner's actual restart rather than performing one.

Use the same conservative complete-round recommendation in session reports and card
comparisons; a clean final p99 must not erase earlier valid quiet peaks. Explain
one-count quantization separately from game settings, and do not infer all samples
were centered from a rounded mean or p99 of zero. Circle evidence requires complete
continuous turns; disconnected arcs do not count. Release direction refers to the
first outward excursion, while post-return peaks cover only the sampled 300 ms after
return. They do not establish mechanical snapback. See mcp/MEASUREMENT-MATH.md.
