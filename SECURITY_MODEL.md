# Threat model — ArcticSlayy/dualsense-doctor (DualSense Studio)

## System overview
A local toolkit for measuring and calibrating Sony DualSense controllers. Everything runs on the controller owner's machine; there is no hosted service and no infrastructure code (no infra repository exists). Components:

| Component | Code | Trust boundary |
|---|---|---|
| **Browser Studio** | `serve.py`, `serve.sh`, `index.html`, `studio.html`, `js/*.js`, `css/` | Static allow-listed asset server on `127.0.0.1:8777`; browser talks to the controller via WebHID |
| **MCP Server** | `mcp/server.js`, `mcp/guided.js`, `mcp/coach-runner.js`, `mcp/session-*.js`, `mcp/stick-tuning.js`, `mcp/trigger-*.js`, `mcp/coaching-notifications.js` | stdio from the MCP client (an LLM agent); writes `sessions/` |
| **Live Coach Service** | `mcp/coach-host.js`, `mcp/coach-service.js`, `mcp/coach.js`, `mcp/feed-clock.js`, `mcp/coach-card.html` | Detached HTTP/SSE service on `127.0.0.1:27892`, gated by a 64-hex capability token; writes `.runtime/` |
| **Calibration Writes** | `mcp/calibration-worker.js`, `mcp/calibration-workflow.js`, `mcp/reviewed-calibration.js`, `mcp/temporary-center.js`, `mcp/calibration-diagnostics.js`, NVS code in `mcp/hid/dualsense.js` | Permanent controller writes (NVS unlock/calibrate/flash) |
| **HID Layer** | `mcp/hid/dualsense.js`, `mcp/hid/controller-session.js`, `mcp/hid/lease.js` | node-hid boundary to the (untrusted) device; `.runtime/hid.lock` lease |
| **Python CLI** | `dsdoctor.py`, `triggers.py`, `wait-usb.py` | Local user CLI over hidapi; legacy `--fix` performs a permanent save |
| **CI** | `.github/workflows/checks.yml` | GitHub Actions, `contents: read`, pinned actions |

## Entry points and who can reach them
- **MCP tools** (`mcp/server.js`): any text the agent acts on, including prompt-injected content, can call tools. `live_coach_control` exposes reviewed calibration actions (`calibration_trial/save/reboot`) gated by confirm literals (`TRY_TEMPORARY_CENTER`, `SAVE_REVIEWED_CALIBRATION`, `REBOOT_CONTROLLER`) and a `reviewId`; `recalibrate_center` is registered only with `DUALSENSE_MCP_ALLOW_CALIBRATION=1` and needs `confirm="RECALIBRATE"`.
- **Live Coach HTTP** (`createCoachServer` in `mcp/coach-host.js`): `/health` (unauthenticated), `/events`, `/state`, `/history`, `/metrics`, `/control`. Sends `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`; checks the `Host` header is `127.0.0.1`/`localhost` (DNS-rebinding defence) and a token in the `?token=` query string with `timingSafeEqual`. `/control` accepts the same actions as `live_coach_control`, including permanent Save. Reachable by any local process and, subject to the token, by any web page in the user's browser.
- **Static server** (`serve.py`): literal-path allow-list, symlink/reparse-point rejection, loopback only.
- **HID input**: reports from whatever device enumerates as a DualSense are parsed by `mcp/hid/dualsense.js`, `dsdoctor.py`, `js/dualsense.js`.
- **Local files**: `.runtime/coach-server.json` and `.runtime/coach-card.html` contain the token; `sessions/<uuid>/` holds reports; `DUALSENSE_SESSION_DIR` overrides the session root.

## Assets
The user rated all of these **equally important**:
- The controller itself — no unintended permanent calibration writes or bricking (NVS writes in `mcp/hid/dualsense.js`).
- The user's computer — no code execution, file read/write or SSRF through the local servers or the MCP server.
- Local session reports and the live card's capability token.

## Attackers that matter (user-provided)
- **Who runs it:** anyone who clones the public repository (open-source users), so default configurations and per-machine setups vary.
- **All attacker classes are in scope; nothing is ruled out:** malicious websites open in the user's browser (CSRF, DNS rebinding, token theft against the loopback ports), other local users or processes on the same machine, prompt injection steering the AI agent into controller writes, and a malicious or spoofed HID device.

## Existing controls (from the code)
- Loopback-only binds (`127.0.0.1`) for both HTTP services; `Host` allow-list in the coach host.
- 32-byte random capability token, constant-time compare; request bodies capped at 2 KB.
- Calibration gates: env flag for `recalibrate_center`; confirm literals, USB-only, standard (non-Edge) DualSense, idle state, review IDs and restart verification for the reviewed workflow.
- Single-owner HID lease (`mcp/hid/lease.js`).
- Session IDs validated as UUID-shaped before path joins (`SessionStore.dir`).
- `serve.py` serves only listed assets and rejects symlinks.
- CI: read-only token, pinned action SHAs, `persist-credentials: false`.

## Out of scope / accepted risk (user-provided)
None. The user asked for everything to be reported, including the legacy CLI `--fix`, `recalibrate_center` and the upstream browser apps.

## Open questions
- `.runtime/` and `sessions/` are created with default permissions (umask); on shared multi-user machines other users may read the token.
- The token persists across service restarts (`priorToken` in `coach-service.js`) and travels in URLs.
