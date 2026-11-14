# DualSense Doctor — MCP server

Measure DualSense input, follow responsive text coaching, review saved checks, and explicitly control temporary effects from an MCP client. The core connection uses stdio. The optional T3 card uses an authenticated loopback relay and exposes a separate reviewed calibration workflow.

[Coaching](COACHING.md) · [T3 live card](T3-INTEGRATION.md) · [Calibration](REVIEWED-CALIBRATION.md) · [Save help](SAVE-REVIEW-RECOVERY.md) · [Portable agent skill](../.agents/skills/dualsense-tuneup/SKILL.md)

## Install

Requires **Node.js 20+**. From the repository root:

```bash
cd mcp
npm ci
```

> **macOS:** the controller must be on **USB** (a Bluetooth DualSense isn't reachable by node-hid on macOS). You may also need to grant **Input Monitoring** to your terminal/Claude Code for live stick reads.
> **Linux:** add a udev rule for non-root HID access:
> `SUBSYSTEM=="hidraw", ATTRS{idVendor}=="054c", MODE="0660", TAG+="uaccess"` then replug.
> **Windows:** input supports USB and Bluetooth report formats. Reviewed calibration requires a standard DualSense over USB; transport support does not qualify calibration or effects on every controller.

## Add to Claude Code

```bash
claude mcp add dualsense -- node /absolute/path/to/dualsense-doctor/mcp/server.js
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "dualsense": {
      "command": "node",
      "args": ["/absolute/path/to/dualsense-doctor/mcp/server.js"]
    }
  }
}
```

Then ask your client:
- *"Open the live stick coach. I'll start one check."* (compatible T3 clients)
- *"Guide me through one stick check with text feedback."*
- *"List my controllers and check the battery."*
- *"Diagnose my right stick for drift."*
- *"Set both triggers to the weapon preset."*
- *"Make the lightbar purple."*

## Tools

| Tools | Purpose | Controller effect |
|---|---|---|
| `list_controllers`, `get_status`, `read_sticks`, `get_battery` | Discover controllers and read input/status | Read-only |
| `diagnose_drift` | Sample resting offset and variation | Read-only |
| `run_guided_session` | Run one adaptive sequence with text progress and movement cues | Reads input; saves local evidence |
| `start_session`, `capture_phase` | Capture individual instructed phases after readiness | Reads input; saves local evidence |
| `list_sessions`, `session_report`, `compare_sessions` | Browse reports and compare compatible checks | Local reports only |
| `set_trigger_effect`, `set_lightbar` | Send explicit trigger resistance or color commands | Temporary effects |
| `show_live_coach`, `live_coach_state` | Prepare the optional card or read its state; ensure the local host is available | No calibration command |
| `live_coach_control` | Connect, measure, apply effects, or perform the reviewed calibration lifecycle | Depends on the explicit action; includes permanent Save |
| `recalibrate_center` (opt-in only) | Legacy center recalibration and NVS save in one operation | Permanent controller write |

The `calibrate_sticks_best` prompt and portable skill explain the workflow. Generic
coaching reads input; repeated checks do not train firmware or automatically adjust
the controller. MCP progress delivery depends on the client. The optional card supplies
its own continuous text cues without a readiness message at each stage.

Trigger/lightbar effects reset on power-cycle and may be replaced by a game. Color
brightness is a setting sent by the app, not a confirmed persistent firmware preference.

## Safety

- **`recalibrate_center` is not registered at all** unless you set `DUALSENSE_MCP_ALLOW_CALIBRATION=1`. It is **USB-only**, requires `confirm="RECALIBRATE"`, and waits for still input before sampling. It captures a new center and saves it; it is not the Save step for an already tested candidate. Do not automatically retry an uncertain write.
- Base measurement tools are read-only; lightbar and trigger effects are ephemeral. The optional `live_coach_control` adapter also exposes explicit reviewed calibration actions. See [the lifecycle contract](REVIEWED-CALIBRATION.md) before using them; they are separate from the legacy environment gate.
- No remote service is required. Dependencies (`node-hid`, `@modelcontextprotocol/sdk`, `zod`) are pinned. The optional card uses localhost HTTP/SSE.

The calibration protocol is reverse-engineered work by [dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io) (Paolo "the_al"). See the [root README](../README.md) for credits and [calibration limits](REVIEWED-CALIBRATION.md) before any controller write.

## Guided measurements and optional live card

See [MCP coaching](COACHING.md), [the T3 card](T3-INTEGRATION.md), and [reviewed calibration](REVIEWED-CALIBRATION.md). Opening a card starts no measurement or calibration write. Save snapshot exports a privacy-filtered PNG of the display.

After a temporary trial, complete **Retest adjustment**, review Results, then choose
**Save calibration to controller → Confirm save to controller** if you want to keep
that exact candidate. An expired review requires another full retest, not a new
center trial. A Save acknowledgement still needs an actual restart and readback;
**I restarted — verify** confirms a restart the owner already performed.

Keep session files, calibration receipts, generated runtime HTML and its local
capability private. Disconnect the card before another tool needs the HID handle.
Preparing a card or reading its state can ensure the local host exists; during a
protected session, re-render the existing runtime file rather than regenerating it.

## Development checks

From `mcp/`, run `npm test` and `npm run smoke`. In this fork, the smoke check uses
an isolated session directory and lists tools/resources/prompts without enumerating
or opening controllers. If concurrent test files stall in a constrained environment,
use `node --test --test-concurrency=1 --test-timeout=30000 test/*.test.js`.
From the repository root, `python -m unittest discover -s test` checks the browser
launcher's public-file boundary using synthetic temporary files. These checks do
not establish physical accuracy, effect appearance, or controller persistence.
