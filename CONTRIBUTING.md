# Contributing

Keep changes small enough to review as one feature or correction. Consolidate fixes
to the same feature into its existing PR; separate read-only measurements, controller
writes and optional client integrations. State any dependency on another PR.

## Before opening or updating a PR

1. Reproduce the issue with synthetic inputs. Add a regression that fails before the
   fix and passes afterward; do not publish someone's raw controller traces.
2. From `mcp/`, run `npm ci`, then
   `node --test --test-concurrency=1 --test-timeout=30000 test/*.test.js` and
   `npm run smoke`. The serial/timeout flags need Node 20.11+; CI uses the latest
   patch releases of Node 20 and 24 on Linux and Windows.
3. For browser-launcher changes, run `python -B -m unittest discover -s test` from
   the repository root. Check changed JavaScript/Python syntax and `git diff --check`.
4. Review the exact branch diff and merge compatibility with its intended base.
   For a stacked PR, validate the dependent branch after updating its prerequisite.
5. Describe the problem, resulting behavior and actual validation. Distinguish
   passing local tests, hosted CI, independent review and physical observations.

## Measurement and controller boundaries

- Preserve raw evidence, calibration epochs and missing-data states. Never replace
  unavailable evidence with zero or select only the most favorable repeated check.
- A deadzone suggestion is an unapplied starting point. Circularity RMS, quiet
  displacement, range symmetry and release motion are separate measurements.
- Reviewed calibration writes retain the explicit trial, exact-candidate Save and
  restart-verification gates. Keep the legacy recalibration opt-in separate; do not
  use it as the reviewed Save step or automatically retry an uncertain write.
  Temporary light-bar and trigger effects keep their own explicit Apply action.
- Automated tests use synthetic inputs and mocked HID. They do not qualify physical
  effects, real power cycles, controller persistence or zero-drift gameplay.

Keep sessions, calibration receipts, device identifiers, runtime HTML/capabilities,
local setup files and personal screenshots out of patches. Use labeled synthetic
examples for documentation. Preserve upstream attribution and MIT licensing.
