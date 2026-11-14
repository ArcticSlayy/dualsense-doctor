# Save-review expiry and recovery

A completed retest opens a ten-minute review window. Expiry withdraws Save approval;
it does not undo the temporary adjustment, permanently save it, or create a new trial.
The earlier local save date can refer to a different candidate.

In Results, choose **Retest adjustment**, complete the guided check, review the new
before/after evidence, then choose **Save calibration to controller** and
**Confirm save to controller** if desired. A fresh center trial is not needed solely
because review expired. Saving remains optional. A real restart and matching readback
are separate persistence verification steps after saving.

The first Save click opens a review group above the navigation. The card focuses
and scrolls that group into view and displays feedback beside the original action.
It focuses the group, not the committing button; Confirm save to controller is still
a separate activation. Reduced-motion preferences disable smooth scrolling. Cancel,
review expiry and changed evidence close the pending confirmation without saving.

The host projects `saveReview.status` (active, expired, clock_changed or unavailable),
`expiresAt` (Unix milliseconds) and `remainingMs`. Snapshot reads never modify the
journal, candidate words, original deadline or measurements. Save still checks the
original server deadline, identity, exact words and evidence; the card grants no
approval. A clock rollback also withdraws approval.

The card counts down the server's remaining duration using a monotonic client clock,
closes an open Save confirmation on expiry and blocks that stale client action.
The server rechecks the deadline at Save, including when a tab was hidden or a feed
was delayed. No auto-save, approval extension or shortcut to reapprove old evidence
is provided. Recovery uses the existing full retest action and its normal capture flow.

For older running hosts without deadline metadata, the card shows no invented timer.
A withdrawn review with prior after-results says the review needs refreshing, without
claiming expiry was the cause. This UI compatibility path does not restart the host
or inspect controller memory. A host update must wait for a maintenance boundary
that preserves the owner's pending trial workflow; do not restart it to obtain a timer.
