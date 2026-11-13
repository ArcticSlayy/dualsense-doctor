# Live card design

The card is an operating tool. Its default journey is one guided check, an
understandable result, then trying the controller in game. Repeats, calibration,
effects and screenshots are optional tasks, not steps required after every check.

## Visual system

- Keep the outer page transparent for embedding. Neutral, opaque functional
  panels distinguish the tool from the surrounding conversation.
- Derive surfaces, text and control colors from the host theme. Use one restrained
  accent for selected navigation, progress and focus. Avoid full-panel warning
  colors for normal hands-off measurement, colored brand stripes and filled tabs.
- Use 15px body text, 14px explanatory text, 19px section headings and 24px active
  instructions (22px on narrow screens). The timer remains prominent at 34px.
  Smaller telemetry is supplementary, never the only instruction.
- Use ordinary sentence case and clear headings. No decorative uppercase kicker.
- Selected navigation uses text weight and an underline, not color alone. Actions
  retain visible borders, focus rings and at least 44px targets. Motion stays low;
  reduced-motion users get no button transitions.
- Check light and dark themes, narrow layouts, real copy, text contrast of at least
  4.5:1 and horizontal overflow. Keep frame-coalesced rendering and bounded data.

## Workflow language

One check means the whole six-stage sequence once. Three/five are total planned
checks, including accepted checks already completed; the user starts every repeat.
Choosing a target never sends a command. A met goal must not read as "3 of 1".
Keep repeat and reset actions with their optional comparison explanation.

The result leads with what to do next. Game-deadzone values are conservative
suggestions rather than scores, required minimums, or values applied to the
controller. Explain the quiet-peak margin and zero-deadzone tradeoff on request.
Distinguish automatic local reports, a downloaded image, explicit controller Save,
and game options. Do not imply that the app applies game profiles.

Optional calibration is collapsed in neutral states. An active trial, retest
review, pending persistence verification or uncertain operation expands the
existing calibration section and exposes its controls without a collapse toggle.
Save/reboot confirmation and command errors remain outside hidden views. Preserve
all existing freshness, identity, evidence and explicit-action gates.
