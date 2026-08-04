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

There is **no backend and no build step**. Every read and write in the app goes
through the `api` object at the top of `public/js/app.js`, which wraps the
Firestore client SDK. Security lives entirely in the rules files.

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

## Known Limitations on the Spark Plan

- **Push notifications don't send.** Subscriptions and the `notifyBefore`
  preference still save to Firestore, but the scheduled function that delivered
  them required Blaze. The UI will report success and nothing will arrive.
- **Nothing prunes old completed assignments.** The scheduled `cleanup` sweep
  went away with the Functions backend.
- **Cascading deletes run in the browser.** Deleting a space deletes its groups
  and their assignments client-side; closing the tab mid-delete can orphan
  documents.
- **Free tier ceilings** — 50k document reads and 20k writes per day, 1 GiB
  stored.
