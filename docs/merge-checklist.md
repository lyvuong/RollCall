# Merging `feature/merge-with-osg-event` into main

What is in the branch: merge and create events on the OSG Website, send changes to Neon (check-ins, registrations, event
details), the Unconfirmed / Here / Missing status model (`neonSeen`), staged participant edits, "who is editing" presence,
red Out of sync badge, kept date range. Production safety rests on two off-by-default switches (Cloudflare variables):

| Variable | Off (default on a live org) | On |
| --- | --- | --- |
| `NEON_ALLOW_WRITES` | The app cannot change anything in Neon. | `1`: Send, merge and create work against the live org. |
| `NEON_AUTO_RECONCILE` | Opening an event never rewrites RollCall's own records. | `1`: opening an event brings in OSG check-ins, marks the rest Missing on finished events, adds registered names, drops duplicate roll entries. |

A sandbox org (name contains "sandbox") always has both on. That is why local work behaves differently from production.

## Before the PR is merged

1. **Decide the rollout.** Merging with both switches off is safe for data. Enabling them is a separate decision (see "Turning the switches on").
2. **Bring the branch up to date.** `git fetch`, then merge `origin/main` into the branch and fix any conflicts.
3. **Run every check on the merged code.**
   - `npm test`
   - `npm run test:rules` (needs Java for the Firestore emulator)
   - `npm run build` (the default build, not `--mode sandbox`, is what production runs)
4. **Check the Cloudflare variables on the Production tab** (and on Preview, see step 5):
   - `NEON_ORG_ID` is the **live** org (`ourstompingground`), not the sandbox.
   - `NEON_ALLOW_WRITES` is **not set**.
   - `NEON_AUTO_RECONCILE` is **not set**.
   - `VITE_FIREBASE_PROJECT_ID` and the other `VITE_FIREBASE_*` values are the **production** project (`rollcall-e85e8`), not `roll-call-sandbox`.
   - `NEON_BASE_URL` is not set.
5. **Check the Preview variables.** Branch and PR previews use their own variables. If Preview points at production Firebase or the live Neon org, anyone testing the preview is working on production data. Point Preview at the sandboxes, or do not open previews.
6. **Back up Firestore** (the console's Import/Export, or `gcloud firestore export gs://<bucket> --project rollcall-e85e8`). The bucket must exist first. Keep the export until the switches have been on for a while.
7. **Deploy the Firestore rules to production.** The only change is additive (a `presence` sub-collection), so it is safe to do first:
   `firebase deploy --only firestore:rules --project rollcall-e85e8`
8. **Smoke test on the sandbox one last time**: open a past event with attendance, a today event, Find on OSG, create on OSG, Send, Save and stay, two browsers on one event (presence cue).
9. **Tell staff what changes on screen** (nothing is automatic, but pages look different): staged Here/Missing and search-and-add on Participants, tappable count badges on Events, red Out of sync badge, the date range kept in the tab, and the "is editing" cue.
10. **Open the PR**, with this file's switch table in the description. Merge at a quiet time (not during an event).

## After the PR is merged

1. **Wait for the production build** and confirm the footer version (date + commit) matches the merge commit.
2. **Reload to get the new app.** The app updates itself, but a tab left open keeps the old version until it is reloaded. If something looks old, hard-reload (Ctrl+Shift+R), or unregister the service worker (DevTools, Application, Service Workers).
3. **Check production is read-only and quiet:**
   - No "Sandbox" badge anywhere in the top bar.
   - Open a linked event: nothing on its roll changes, and no "checked in on the OSG Website" toast appears.
   - The sync chip, if it shows changes, opens a dialog that says sending is turned off.
4. **Check presence**: open the same event in two accounts. Each should see "<name> is editing …". If not, the rules were not deployed (before step 7).
5. **Watch for a day**: staff reports, and the browser console for `permission-denied` or `OSG Website check failed`.
6. **Housekeeping**: delete the merged branch if you want, and keep `.dev.vars`, `.dev.vars.production` and `.env.sandbox` backed up (they are not in git).

## Turning the switches on (later, one at a time)

1. **`NEON_AUTO_RECONCILE=1` first.** Take a fresh Firestore export. Set the variable, then **Retry deployment** (variable changes only apply to a new deployment). Open one finished event that has attendance on the OSG Website and check its roll, the Here/Missing marks and the counts. Open a few more before telling staff. These changes rewrite rolls, so participant counts and reports for those events will change.
2. **`NEON_ALLOW_WRITES=1` second.** Try one event end to end (Send a check-in, register a walk-in) and confirm it in the live Neon org. Known limits: registrations made through the online form can be rejected when edited (Neon's empty coupon code, error 14014), and guests are registered under the signed-in staff member's own OSG account.
3. **Rollback.** Unset the variable and Retry deployment: the app stops making that kind of change at once. Changes already written stay; restore from the export if you need them gone. To remove the code, revert the merge commit and redeploy. Old code ignores the new `neonSeen` and `presence` data, so the revert is safe.
