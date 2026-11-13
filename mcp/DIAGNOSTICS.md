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
