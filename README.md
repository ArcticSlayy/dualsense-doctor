# DualSense Studio

A local toolkit for understanding DualSense stick input, testing calibration changes, and controlling temporary adaptive-trigger and light-bar effects. Built on DualSense Doctor, with guided MCP coaching and an optional T3 live card.

[![Hardware-free checks](https://github.com/ArcticSlayy/dualsense-doctor/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/ArcticSlayy/dualsense-doctor/actions/workflows/checks.yml)

![Synthetic example of the DualSense Studio live card](docs/media/dualsense-studio.png)

*Illustrative synthetic data; this is not a live controller reading.*

[Upstream project](https://github.com/Sufxx/dualsense-doctor) · [MCP coaching](mcp/COACHING.md) · [Reviewed calibration](mcp/REVIEWED-CALIBRATION.md) · [Optional T3 card](mcp/T3-INTEGRATION.md) · [MIT license](LICENSE)

## What it does

| Interface | Capabilities |
|---|---|
| **Browser apps** | Live stick input, drift/range diagnostics, adaptive triggers and light-bar controls through WebHID. |
| **Python CLI** | Sample or monitor sticks with `dsdoctor.py`; apply temporary trigger effects with `triggers.py`. |
| **MCP coaching** | Guided checks, local reports, directional assessment and comparisons of up to ten compatible rounds. Works without T3. |
| **Optional T3 live card** | Reactive coaching, before/after results, saved range plots, analog-trigger checks and privacy-filtered PNG export. Adds the reviewed calibration workflow below. |

## Start here

For a quick look at your controller, use the browser apps. For guided measurements and saved comparisons, set up MCP coaching. T3 is optional.

### Browser apps

Connect your controller, use Chrome or Edge, and run this from the repository root:

~~~sh
./serve.sh
~~~

On Windows, or without Bash, use `python serve.py`. Open the printed local address: `/studio.html` for Studio or `/index.html` for diagnostics. Use `python serve.py 9000` for another port. The launcher serves only listed public assets on `127.0.0.1`; session files and configuration stay private. See [upstream setup](https://github.com/Sufxx/dualsense-doctor) for OS and transport support.

### MCP coaching

Requires **Node.js 20+**. From the repository root:

~~~sh
cd mcp
npm ci
~~~

Register with Claude Code, replacing the example with the repository's absolute path:

~~~sh
claude mcp add dualsense -- node /absolute/path/to/dualsense-doctor/mcp/server.js
~~~

Ask your client to **“Guide me through one stick check with text feedback.”** In a compatible T3 client, ask for the live coaching card (`show_live_coach`) and choose **Start one check**.

Follow the movement cues, then review resting movement, range and release behavior in Results. Reports save locally. A check measures input without changing calibration; optional repeats measure consistency and each starts explicitly. Try the result in game before deciding on an adjustment. See [MCP coaching](mcp/COACHING.md) and [T3 setup](mcp/T3-INTEGRATION.md) for details.

### Python CLI

The CLI requires the system HIDAPI library; see [upstream setup](https://github.com/Sufxx/dualsense-doctor) for installation.

~~~sh
python3 dsdoctor.py
python3 dsdoctor.py --monitor 10
python3 triggers.py
~~~

## Optional calibration

The reviewed live-coach workflow supports a **standard DualSense over USB, not DualSense Edge**. Measurement, trial, permanent Save and restart verification are separate actions:

1. **Check:** inspect controller state and complete a baseline measurement.
2. **Trial:** explicitly try a temporary center adjustment after a three-second hands-off countdown. This changes the controller's working calibration, without saving it permanently.
3. **Retest adjustment:** complete a full check of the same controller in the same session.
4. **Save calibration to controller → Confirm save to controller:** review and explicitly save the exact tested candidate. Save does not capture a new center or change range calibration.
5. **Restart, then verify:** actually power-cycle the controller, then choose **I restarted — verify** for matching readback. Save acknowledgement alone does not prove persistence; each candidate needs its own verification.

Restarting before Save discards the temporary trial. An expired review needs **Retest adjustment**, not a new trial. For uncertain outcomes, wait for current status rather than retrying the write. Read the [calibration guide](mcp/REVIEWED-CALIBRATION.md) and [Save/recovery guide](mcp/SAVE-REVIEW-RECOVERY.md) before using these controls.

Game deadzone suggestions are unapplied starting points with a margin. Near-zero resting input and lower circularity error do not guarantee better feel or zero drift; calibration cannot repair worn components. See [measurement math](mcp/MEASUREMENT-MATH.md), [diagnostic interpretation](mcp/DIAGNOSTICS.md), and [observed evidence and limits](mcp/REVIEWED-CALIBRATION.md#qualification).

The legacy CLI `--fix` and opt-in MCP `recalibrate_center` perform their own recalibration and permanent save. They are **not** the Save step for a reviewed candidate. The MCP command remains disabled unless `DUALSENSE_MCP_ALLOW_CALIBRATION=1` is set.

## Privacy and controller access

Reports and calibration receipts stay local. Keep session directories, generated card runtime HTML and its local capability private. Core MCP uses stdio; the optional card uses an authenticated loopback service. Disconnect the card before another tool needs exclusive HID access.

Card effects require an explicit **Apply** action. Games or power-off can replace/reset them, and a sent command does not confirm the physical effect.

## Development

From `mcp/`, run `npm test` and `npm run smoke` for hardware-free checks. The CI workflow checks Linux/Windows on Node 20/24. See [contribution guidance](CONTRIBUTING.md) for reproducible tests and PR scope. Automated checks do not establish physical accuracy or qualify controller writes.

## Credits

The on-controller stick recalibration protocol (NVS unlock / calibrate / flash over HID) was reverse-engineered by **Paolo "the_al"** and the **[dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io)** project (MIT). The original project independently implemented the protocol; this fork adds coaching and reviewed workflow layers. Thanks to that work.

The upstream browser apps and CLI remain part of this project. See the [upstream repository](https://github.com/Sufxx/dualsense-doctor) and [LICENSE](LICENSE).
