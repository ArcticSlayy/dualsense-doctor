# Optional T3 live-card adapter

This layer is separate from generic MCP coaching. It adds an interactive HTML
card, a local input relay, and three adapter tools: `show_live_coach`,
`live_coach_state`, and `live_coach_control`. It is an optional integration
proposal, not a dependency of the base MCP workflow.

Calling `show_live_coach` prepares an HTML path. A compatible T3 client can pass
that path to its HTML preview and rendering tools. Network access in a preview
renderer and in the actual desktop embedded card can differ. Verify on the target
client instead of assuming a preview connection failure proves the desktop card
cannot work, or that one successful desktop client guarantees all versions work.

The card shows current axes, trigger/button input, estimated battery state,
available firmware information, bounded trails, adaptive text instructions, a step
checklist, and Start/Pause/Resume/Stop. Display preferences and zoom affect only
the visualization; raw values and measurements retain their original meaning.
The local relay targets 125 Hz, while actual render/feed rates depend
on the machine and client. It reports measured rates rather than promising a
fixed FPS. Stale input is hidden and cannot be presented as live data.
The card coalesces incoming changes on animation frames. Direction arrows, rim
coverage and separate per-stick cues explain the current movement. A preparation
ring counts down to the measurement; phase progress remains evidence-based.
Lightbar colors can be chosen with a picker or hex input and previewed locally
before Apply. The preview is not a prediction of the physical LED's appearance.

## Local service and privacy

Results show left/right starting deadzones, observed quiet peaks, circularity and
round-to-round spread. Select a 1/3/5-round goal and explicitly press Repeat check
for each additional round; no physical session starts automatically. A new
comparison or disconnect clears the live comparison, while saved session logs
remain available to the generic `compare_sessions` tool. The card keeps up to ten
rounds per comparison. Lightbar Apply works before a test when input is fresh;
the adjacent message explains when connection or a pending command prevents it.

The service binds only to loopback port 27892. State, control and metrics require
a random capability. Generated HTML and service state under `.runtime` contain
that capability and stay private. No runtime HTML, logs, device identifiers or
session data belong in commits or issue reports. The relay exposes measurement
controls and explicit temporary lightbar/adaptive-trigger effects. It has no
firmware-calibration or permanent-save endpoint. Effect commands are sent only
after an explicit action; showing the card or reconnecting does not apply a
color or trigger preset. Sent commands are not independent device confirmation.
Battery values are estimates, not a promise of exact charge measurement.

Trigger resistance controls require compatible adaptive-trigger motors. Hardware
trigger-stop modifications may limit or eliminate their usefulness. The relay
rejects trigger-effect changes while a guided measurement is running; pause or
stop first. Ephemeral color/resistance effects can be overridden by games and
reset on power cycling. They are separate from stick calibration and trigger
endpoint calibration.

The relay owns the HID handle until disconnected. Disconnect the card before
using other tools that need exclusive controller access. Pause restarts the
interrupted phase; it does not certify an incomplete capture. An ownership lease
coordinates cooperating local processes, not arbitrary external calibration apps.

This adapter remains a draft pending independent review and target-client/live
qualification. Synthetic tests cover display behavior and HTTP validation; they
do not establish hardware safety or qualify the upstream permanent-save tool.
