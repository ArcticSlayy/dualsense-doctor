# Read-only diagnostic boundaries

Saved checks are individual historical sessions, using the latest recorded calibration
epoch and range capture. The history reader caps work at 256 directory entries, 64
session files of at most 2 MiB each, 2048 captures per session and 10 returned entries.
When capped, the card marks the list as bounded; it is not a complete archive search.
Malformed entries are skipped with a fixed notice. Device paths, serials, arbitrary
notes/goals and calibration words never enter the display projection. UUIDs remain
local selection keys and are not rendered or included in PNG output.

Range bins are measured angular maxima from the existing circularity analyzer. A
radius at or below 0.2 means no covered direction and becomes a gap. Values are not
averaged across captures or checks, and below 100% or above 100% is not itself a defect.
The plot uses a fixed 150% radial scale with a separate 100% reference circle. A
completed stick check does not guarantee all 48 circularity directions are present.

The trigger analyzer accepts parsed USB, Bluetooth and basic Bluetooth analog
reports; it never opens a controller. Temporal evidence requires a consistent known
transport, increasing time, sufficient samples and no input gap above 250 ms. Slow
sweep classification uses ordered released/pressed/released travel with each moving
leg at least 500 ms, eight intermediate bands, limited reversals and no large jumps.
These empirical recording rules do not infer the user's intent or prove smoothness.
The active card capture additionally cancels after input loss above 300 ms, caps at
4000 reports, and saves only after a complete 12-second recording. Interrupted or
malformed captures cannot become successful results. No controller outputs are sent.

Performance statistics use at most 240 visible, fresh animation callbacks. Gap p95,
maximum gap, gaps over 50 ms and synchronous callback-work durations describe only
that window. The first frame after a visibility/input reset has no preceding gap.
The counters do not claim browser paint, GPU completion or end-to-end input latency.

## Directional stick assessment

New guided checks record signed X/Y quiet means, raw extrema and standard deviations.
The assessment retains the range of window means and the full observed spread across
all clean rest, button and verification captures in the current calibration epoch.
It does not average away different return positions or choose the best quiet window.
Signed percentages use `(raw - 128) / 127 * 100`: +X is right and +Y is down.
Quiet spread is peak-to-peak displacement on one axis, not a radial deadzone.

Observed axis reach uses each side's recorded range extrema: negative travel uses
128 raw counts and positive travel uses 127, so both electrical endpoints map to
100%. Opposing differences are absolute percentage-point differences. These are
extrema during circles, not deliberate straight-direction holds, physical travel,
or proof that the output has not saturated. All 48 measured sectors and valid axis
limits are required before presenting a complete reach assessment. Circularity
uses its existing separate normalization and is not an optimization target here.

The live panel describes the latest completed round; the existing deadzone summary
still retains the worst quiet peak across compatible rounds. Saved-check assessment
stays attached to its selected session and never replaces the active save review.
Legacy records without signed axes keep that detail unavailable. Invalid, mixed-
transport, incomplete or stale-epoch evidence cannot produce an accepted assessment.

Next-check messages use fixed rules, not a learned hardware-health score. A quiet
axis entirely on one side of raw 128 prompts a repeatability check, not an adjustment
command: even a small quantization offset can produce that observation. Mixed quiet
positions do not force an endless repeat. Consider the existing temporary center
trial only if a persistent offset warrants it, then retest before Save. There are
no automatic range writes, firmware-word recommendations, or zero-drift promises.
The current PNG snapshot retains its existing comparison content; these extra axis
details are available in the card and session report, not in that snapshot.

Primary reference: [DualShock Tools fine-tuning interface](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/main/templates/finetune-modal.html)
separates hands-off center adjustment from range adjustment. It does not establish
universal intervention thresholds for signed bias, jitter or opposing reach.


The card names the digital buttons currently pressed (for example, L2 + R2),
separately from analog trigger travel. D-pad hat directions are not in that mask.
Calibration shows the relevant action and review first; save history and recovery
controls expand on request. Confirmation, uncertain-write notices and before/after
review remain visible. Detailed axis observations are also expandable after a check.
