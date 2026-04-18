# StudyFlow — Homework Scheduler

A color-coded homework and schedule tracker for students. Built with Node.js, Express, Firebase Hosting, and Firestore.

Sign in with Google, organize your classes into custom tabs, add assignments with deadlines, and access your schedule from any device.

## Live App

[https://studyflow-38a6b.web.app](https://studyflow-38a6b.web.app)

## Stack

- **Frontend** — Vanilla HTML / CSS / JS, Firebase Auth (compat SDK)
- **Backend** — Express.js REST API deployed as a Firebase Cloud Function
- **Database** — Firestore (per-user collections, secured by Auth)
- **Hosting** — Firebase Hosting with `/api/**` rewritten to the Cloud Function

## Local Development

```bash
npm install
npm start        # http://localhost:3000
npm run dev      # auto-reload with nodemon
```

> Local dev uses `src/` routes and `src/firebaseAdmin.js` with a service account key at `config.js` (git-ignored).

## Deploy

```bash
firebase deploy --only functions,hosting
```

To deploy just the frontend:

```bash
firebase deploy --only hosting
```

## Project Structure

```
StudyFlow/
├── server.js                   # Local Express entry point
├── src/
│   └── routes/
│       ├── tabs.js             # REST endpoints for tabs
│       ├── classes.js          # REST endpoints for classes/groups
│       └── homework.js         # REST endpoints for homework
├── functions/
│   ├── index.js                # Cloud Function entry point
│   └── src/
│       ├── firebaseAdmin.js    # Admin SDK init (default credentials)
│       └── routes/             # Same routes as src/ — keep in sync
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js                  # All frontend logic; API calls in `api` object
├── firebase.json               # Hosting rewrites + cache headers
├── firestore.rules
└── package.json
```

## API

All endpoints require a Firebase ID token in `Authorization: Bearer <token>`.

| Method | Endpoint              | Body                                              | Description                        |
|--------|-----------------------|---------------------------------------------------|------------------------------------|
| GET    | /api/tabs             | —                                                 | List tabs (sorted by order)        |
| POST   | /api/tabs             | `{name}`                                          | Create tab                         |
| PUT    | /api/tabs/:id         | `{name}`                                          | Rename tab                         |
| DELETE | /api/tabs/:id         | —                                                 | Delete tab + its classes + their HW|
| POST   | /api/tabs/reorder     | `{order: [id, ...]}`                              | Persist drag-to-reorder            |
| GET    | /api/classes          | —                                                 | List classes (sorted by order)     |
| POST   | /api/classes          | `{name, color, tabId, teacher?, room?, period?}`  | Create class                       |
| PUT    | /api/classes/:id      | same fields                                       | Update class                       |
| DELETE | /api/classes/:id      | —                                                 | Delete class + its HW              |
| POST   | /api/classes/reorder  | `{order: [id, ...]}`                              | Persist drag-to-reorder            |
| GET    | /api/homework         | —                                                 | List all homework                  |
| POST   | /api/homework         | `{classId, description, notes?, deadline?}`       | Add homework                       |
| PUT    | /api/homework/:id     | `{description?, notes?, deadline?, completed?}`   | Update homework                    |
| DELETE | /api/homework/:id     | —                                                 | Delete homework                    |

## Data Storage

Each signed-in user's data lives in Firestore under:

```
users/{uid}/tabs/{tabId}
users/{uid}/classes/{classId}
users/{uid}/homework/{hwId}
```

Firestore security rules ensure users can only read and write their own documents.
