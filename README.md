# StudyFlow — Homework Scheduler

A color-coded homework and schedule tracker for students. A static frontend on
Firebase Hosting that reads and writes Firestore directly from the browser.

Sign in with Google, organize your classes into custom spaces, add assignments
with deadlines, and access your schedule from any device.

## Live App

[https://studyflow-38a6b.web.app](https://studyflow-38a6b.web.app)

## Stack

- **Frontend** — Vanilla HTML / CSS / JS, Firebase compat SDK loaded via `<script>` tags
- **Data** — Firestore, accessed straight from the client; per-user access enforced by `firestore.rules`
- **Files** — Cloud Storage for assignment attachments, scoped per-user by `storage.rules`
- **Hosting** — Firebase Hosting serving `public/` as-is
- **Reminders** — a GitHub Actions cron job (`notifier/`), the only thing that runs outside the browser

There is **no backend and no build step**. Every read and write in the app goes
through the `api` object at the top of `public/js/app.js`, which wraps the
Firestore client SDK. Security lives entirely in the rules files.

The one exception is push notifications: something has to be awake when the
browser is closed. That job is a scheduled GitHub Actions workflow rather than a
server — see [Push Notifications](#push-notifications).

> **History:** this app used to run an Express REST API as a Cloud Function, with
> the frontend calling `/api/**`. The project moved from the Blaze plan to Spark,
> which disables Cloud Functions, so every one of those calls started returning
> 503. The Express backend (`server.js`, `src/`, `functions/`) was ported into the
> client and then deleted — keeping it around only invited edits to code that
> could never run. To bring it back you would need Blaze again, plus:
>
> ```bash
> git log --diff-filter=D -- functions/     # find the commit that removed it
> git checkout <that-sha>^ -- functions src server.js
> ```
>
> …and restoring the `functions` block and the `/api/**` rewrite in `firebase.json`.

## Local Development

```bash
make serve      # http://localhost:5000
```

This serves `public/` against the real Firestore project, so you are editing live
data. There is nothing to install and no `npm install` step.

## Deploy

```bash
make deploy     # hosting + firestore rules + storage rules
make rules      # rules only, much faster
```

**Never run a bare `firebase deploy`.** It attempts a Cloud Functions deploy,
which fails on the Spark plan and aborts the rest of the release.

**Do not add a `database` key to the `firestore` block in `firebase.json`.**
Firestore's default database is named `(default)`, parentheses included. Setting
it to `"default"` makes the CLI publish to a release for a database that does
not exist — it still uploads the ruleset and still prints
`✔ released rules firestore.rules to cloud.firestore`, so nothing looks wrong,
but the live database keeps serving whatever it served before. That typo sat in
this repo from April to August 2026 and quietly discarded every rules change in
between. If a rules edit doesn't seem to take effect, check the Rules tab in the
Firebase Console against `firestore.rules` before touching the rules themselves.

## Project Structure

```
StudyFlow/
├── public/
│   ├── index.html
│   ├── js/
│   │   ├── app.js              # All frontend logic; Firestore access in the `api` object
│   │   └── config.js           # Firebase web config (public by design)
│   ├── css/style.css
│   └── sw.js                   # Service worker — push notification display only
├── notifier/
│   └── send-reminders.js       # Scheduled reminder sender; runs on GitHub Actions
├── .github/workflows/
│   └── reminders.yml           # Cron that runs the sender every 15 minutes
├── firebase.json               # Hosting config + cache headers
├── firestore.rules             # Per-user read/write scoping
├── firestore.indexes.json
├── storage.rules               # Per-user attachment scoping
└── Makefile                    # serve / deploy / rules
```

## Data Model

Each signed-in user's data lives under their own UID:

```
users/{uid}/tabs/{tabId}          # "spaces" in the UI
users/{uid}/classes/{classId}     # "groups" in the UI
users/{uid}/homework/{hwId}       # "assignments" in the UI
userPrefs/{uid}                   # notifyBefore, shared across devices
pushSubscriptions/{subId}         # { uid, endpoint, keys, notifyBefore }
```

`tabs`, `classes` and `homework` each carry an integer `order` field driving
drag-to-reorder. Attachments are stored at
`users/{uid}/hw-attachments/...` in Cloud Storage and referenced from the
homework document.

Firestore rules ensure users can only read and write their own documents.

## Push Notifications

The browser subscribes and saves the subscription to `pushSubscriptions`, and
`public/sw.js` displays whatever arrives. Between those two ends, something has
to be awake at the right moment to actually send the push — that used to be a
Cloud Task per assignment, scheduled by a Cloud Function. Those died with the
move to the Spark plan and were deleted, which left subscriptions being written
to a collection nothing ever read.

`notifier/send-reminders.js` replaces that design with a periodic scan, run by
`.github/workflows/reminders.yml` every 15 minutes. Each run reads
`pushSubscriptions`, and for every user that has one, checks their assignments
for reminders whose time has come. There is no scheduling state to fall out of
sync — a missed run is picked up by the next one.

### Setup

Four repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | The entire contents of `serviceAccountKey.json` |
| `VAPID_PUBLIC_KEY` | Must match `VAPID_PUBLIC_KEY` in `public/js/app.js` |
| `VAPID_PRIVATE_KEY` | The private half of that pair |
| `VAPID_EMAIL` | `mailto:you@example.com` — push services require a contact |

If the private key has been lost, generate a fresh pair with
`npx web-push generate-vapid-keys`. The public half must then also be pasted
into `public/js/app.js` and redeployed, and **every device has to toggle
notifications off and back on** — existing subscriptions are bound to the old
key and will start failing with `403`. The sender deletes subscriptions the push
service reports as expired (`404`/`410`), but a key mismatch is not one of those.

### Testing and tuning

Actions → *Send assignment reminders* → **Run workflow**:

- `mode: test` pushes "Notifications are working!" to every subscribed device —
  the replacement for the old `/api/notifications/test` endpoint.
- `dry_run: true` logs what would be sent without sending or writing anything.

Two environment variables in the workflow adjust behavior. `MAX_LATE_MINUTES`
(default 360) is how stale a reminder may be and still be worth sending; past
it, the assignment is marked as reminded without a push, so a run after an
outage doesn't dump a backlog. `DEFAULT_TIMEZONE` (default
`America/Los_Angeles`) only matters for assignments saved before the client
started storing `deadlineMs`.

### Caveats

- GitHub queues scheduled workflows on a best-effort basis and can run them
  several minutes late under load, so treat the lead time as approximate.
- **Scheduled workflows are disabled automatically after 60 days without a push
  to the repo.** If reminders quietly stop, check that first.
- A reminder whose time has already passed when the assignment is created never
  fires — the same behavior the Cloud Tasks version had. Adding an assignment
  due in 12 hours with a "1 day before" reminder gets you nothing.
- A date with no time is treated as 23:59 on that date — "due sometime that
  day" — which is also what the sort comparators in `app.js` assume. It used to
  be midnight, which put the whole day in the past and made a "1 hour before"
  reminder arrive at 11pm the night before.

## Known Limitations on the Spark Plan

- **Completed assignments are pruned in the browser, not on a schedule.** The
  scheduled `cleanup` sweep went away with the Functions backend, so
  `pruneOldCompleted()` in `app.js` re-applies the same 30-day policy on load.
  It only runs while someone has the app open — a dormant account never prunes.
- **Cascading deletes run in the browser.** Deleting a space deletes its groups
  and their assignments client-side; closing the tab mid-delete can orphan
  documents.
- **Free tier ceilings** — 50k document reads and 20k writes per day, 1 GiB
  stored.
