# Optional T3 live card

The T3 integration is an optional client layer for generic MCP coaching. Measurements and reports are also available without T3.

Call `show_live_coach` to prepare the card, then open its returned HTML path with a compatible client's preview and rendering tools. `live_coach_state` reads card state. `live_coach_control` connects or disconnects, starts and pauses checks, applies temporary effects, and exposes the explicit calibration lifecycle in [Reviewed calibration workflow](REVIEWED-CALIBRATION.md). Opening the card does not start a measurement or send an effect.

## Measurements and comparisons

The card shows live stick axes, trigger/button input, battery estimate, available firmware information, coaching instructions, and evidence-based progress. A check covers rest, clockwise and counterclockwise range, release, buttons, and final verification. Phases advance only when their checks pass. Pause restarts the interrupted phase.

Choose a 1, 3, or 5-round target. Each additional physical round starts only after an explicit Repeat action. The card holds up to ten rounds in one live comparison; generic `compare_sessions` can compare up to ten saved complete rounds. Saved reports can be read and compared, but continuous card progress is not guaranteed to resume across a process restart. Begin a new comparison after controller, transport, or calibration changes.

Deadzone values are conservative game-setting starting points from observed rounds. They are not applied and do not guarantee zero drift. Circularity, quiet peaks, and round spread are distinct measurements.

## Display, effects, and rates

The relay targets 125 Hz. The card reports actual input-feed and rendered-display rates, which vary by client and machine. Display updates are coalesced; rendered FPS is not an end-to-end latency measurement. Zoom and display preferences do not change measurements.

Light-bar color and brightness are previewed locally. The preview does not predict the physical LED's appearance. Press **Apply color** to send it. Adaptive-trigger settings also require explicit Apply and compatible trigger motors. Sent commands do not confirm physical effect. Games may replace effects; power-off resets them. Effects are separate from stick and trigger-endpoint calibration.

The before/after view separates resting peak, game deadzone candidate, circularity,
range symmetry and release peak. It uses fixed labels and numeric values; missing
measurements remain unavailable. Table updates are cached while live plots keep
their frame-based refresh. Circularity changes are neutral observations, not a
health score or an automatic save recommendation.

The PNG snapshot uses a whitelist of display values: status, phase, live stick values, calibration stage/results, the five before/after metrics, and round summaries. It omits device identifiers, filesystem paths, arbitrary server messages and the local capability token. If the browser blocks download, the image remains in the card preview to open or save.

## Local service and privacy

The relay binds to loopback on port 27892. State, control, and metrics requests require a random local capability. Keep generated runtime HTML, the capability, calibration journal, and raw session logs private.

The card owns the HID handle while connected. Disconnect it before using another controller tool. The lease coordinates cooperating local processes, not unrelated apps.

## Calibration

The optional `live_coach_control` actions provide **Check → temporary center trial → full retest → explicit exact-candidate save → owner-confirmed restart and readback**. The trial changes the controller's working calibration state, not a software-only view. It uses a three-second hands-off countdown and does not write range calibration or permanent memory. Save and restart are separate explicit actions and never run automatically.

See [Reviewed calibration workflow](REVIEWED-CALIBRATION.md) for save receipts, acknowledgement limits, legacy `recalibrate_center` behavior, and qualification status. Automated tests do not establish physical accuracy or qualify controller writes. Physical trial and persistence checks remain pending.
