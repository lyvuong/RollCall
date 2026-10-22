<div align="center">

# OSG Activity Roll Call

**Take roll call at events, track volunteer hours, and keep a history of who took part.**
An installable, offline-capable PWA built for OSG staff.

[![License: MIT](https://img.shields.io/github/license/lyvuong/RollCall?color=blue)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/lyvuong/RollCall)](https://github.com/lyvuong/RollCall/commits)
[![Issues](https://img.shields.io/github/issues/lyvuong/RollCall)](https://github.com/lyvuong/RollCall/issues)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![JavaScript](https://img.shields.io/badge/Vanilla_JS-ES_modules-F7DF1E?logo=javascript&logoColor=black)
![Firebase](https://img.shields.io/badge/Firebase-Auth_%2B_Firestore-FFCA28?logo=firebase&logoColor=black)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages_%2B_R2-F38020?logo=cloudflare&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-offline_ready-5A0FC8?logo=pwa&logoColor=white)
![Tested with Vitest](https://img.shields.io/badge/tested_with-Vitest-6E9F18?logo=vitest&logoColor=white)

</div>

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Getting started (local)](#getting-started-local)
- [Firebase setup](#firebase-setup)
- [Deploying to Cloudflare](#deploying-to-cloudflare)
- [Neon One integration](#neon-one-integration)
- [Daily use](#daily-use)
- [Scripts](#scripts)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Versioning and updates](#versioning-and-updates)
- [Security notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

## Features

| Area | What you get |
| --- | --- |
| **Events** | Create events with date, time, format (virtual, in-person or hybrid) and a location. Browse by day with quick date presets. |
| **Roll call** | Record participants and volunteers per event. People are typed in once and saved for next time ("frequent flyers"), tagged OSG member or Community. |
| **Volunteer hours** | Total hours = event hours × checked-in volunteers, with flags on events that still need volunteers identified. |
| **Photos** | Attach photos to an event. Images are resized and re-encoded on the device (full and thumbnail), then stored in Cloudflare R2. |
| **Reports and export** | Pick a date range and export events and attendees to CSV in a format that re-imports losslessly. |
| **CSV import** | Bring in past events and people, including AMS exports, with a preview step before anything is written. |
| **Saved Members review** | Admins can scan for look-alike names (typos, case, word order, extra middle names) and send them to the merge bar, and list people who never attended or haven't in 1, 2 or 3 years, then delete them in bulk. People on an upcoming event are never listed. |
| **Neon One events** | Neon One CRM events for the visible date range appear in the Events list next to staff-created ones (read-only, cached for offline). Tap *Import and open* to start roll call on one. Admins can also bulk-import from Settings. |
| **Works offline** | Reads and check-offs work with poor venue wifi and sync when you reconnect. Installs to the home screen. |
| **Auto-updating** | Installed phones pick up new deploys on launch, on return to the foreground, and hourly. |
| **Sign-in** | Google, or a passwordless **email link** for any address (for example a Neon One staff email). |
| **Invitation-only access** | New staff join with an admin-issued code that expires. Admins can revoke staff. |
| **Light and dark theme** | Follows the system, with a manual toggle. Responsive from phones to desktops. |

## Architecture

```
Browser (PWA, Vite + vanilla JS)
   │  Firebase Auth (Google / email link)         ┌───────────────────┐
   ├──────────────────────────────────────────────▶  Firebase Auth     │
   │  Firestore SDK (offline cache, security rules)│  Firestore        │
   ├──────────────────────────────────────────────▶  (events, people…) │
   │                                               └───────────────────┘
   │  /api/*  (Firebase ID token in Authorization header)
   ▼
Cloudflare Pages Function  ──▶  worker/index.js
                                  ├─ /api/photos/*  ──▶ R2 bucket (PHOTOS binding)
                                  └─ /api/neon/*    ──▶ Neon One REST API (key stays server-side)
```

- **Front end:** Vite, vanilla JavaScript, no framework. Views live in `src/views`, helpers in `src/lib`.
- **Data:** Firestore with security rules in `firestore.rules`; the app works offline through the SDK cache.
- **API:** `functions/api/[[path]].js` mounts `worker/index.js` on Cloudflare Pages. It verifies Firebase ID tokens with WebCrypto only (`worker/auth.js`), so there are no server dependencies.
- **Photos:** stored in R2, served through the authenticated API.
- **Neon One:** a read-only proxy so the API key never reaches the browser.

## Getting started (local)

### Prerequisites

- Node.js 20 or newer and npm
- Java 11 or newer (only for the Firestore rules tests and the emulators)

### One-command local mode

This needs no Firebase project and no cloud account. It starts the Firebase Auth and Firestore emulators and Vite, seeds sample data once, and grants admin plus membership to whoever signs in.

```bash
npm install
npm run local
```

Open the URL Vite prints. Emulator data is kept in `.emulator-data/` (git-ignored) between runs.

### Against your own Firebase project

```bash
npm install
cp .env.example .env.local   # fill in the Firebase web config
npm run dev
```

| Variable | Purpose |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | Firebase web API key (not a secret) |
| `VITE_FIREBASE_AUTH_DOMAIN` | e.g. `your-project.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_FIREBASE_APP_ID` | Firebase web app ID |
| `VITE_USE_EMULATOR` | Set to `1` to use the local emulators (`npm run emulators`) |

To exercise the `/api` routes (photos, Neon One) locally, run `npm run cf:preview`. It builds the app and serves it through the local Workers runtime with an R2 binding. Put local secrets in a git-ignored `.dev.vars` file (see [Neon One integration](#neon-one-integration)).

## Firebase setup

One-time setup for authentication and the database.

1. Create a Firebase project (the free Spark plan is enough). Add a **Web app** and copy its config into `.env.local`.
2. **Authentication → Sign-in method:**
   - Enable **Google**.
   - Enable **Email/Password**, then turn on **Email link (passwordless sign-in)**. This is what lets people sign in with any email address.
3. Create a **Firestore** database in production mode.
4. Log in and select the project:
   ```bash
   npx firebase login
   npx firebase use --add
   ```
5. Deploy the security rules:
   ```bash
   npx firebase deploy --only firestore:rules
   ```
6. **Make yourself the first admin.** Sign in once, find your UID under Authentication → Users, then in Firestore create an empty document `admins/<your uid>`. Reload; Settings now shows invitation codes.
7. After the first deploy, add your hostname under **Authentication → Settings → Authorized domains** (your `*.pages.dev` host and any custom domain). Sign-in fails without it, for both Google and email links.

> **Heads-up for staff:** sign-in emails come from `noreply@<project>.firebaseapp.com` and often land in **Spam** the first time. Tell new users to check there and mark the message "Not spam". For better deliverability, set a custom sender domain (with SPF/DKIM) under Authentication → Templates → Email link sign-in.

## Deploying to Cloudflare

The site is hosted on **Cloudflare Pages** with an **R2** bucket for photos.

1. Push this repo to GitHub (`.env.local` and `.dev.vars` are git-ignored).
2. Cloudflare dashboard → Workers & Pages → Create → **Pages → Connect to Git** → pick the repo.
3. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
4. **Variables** (Settings → Variables and Secrets, set for both Production and Preview):

   | Name | Type | Purpose |
   | --- | --- | --- |
   | `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | Build variable | Baked into the bundle at build time. Firebase web config is not secret. |
   | `FIREBASE_PROJECT_ID` | Runtime variable | Used by the API to verify ID tokens. |
   | `NEON_ORG_ID`, `NEON_API_KEY` | Runtime **secret** | Only needed for the Neon One import. |
   | `NEON_ALLOW_WRITES` | Runtime variable (optional) | `1` lets the app send changes to a live Neon org. Leave it unset until you want that; a sandbox org always allows writes. |
   | `NEON_AUTO_RECONCILE` | Runtime variable (optional) | `1` lets the app update its own records when an event is opened: bring in check-ins made on the OSG Website, mark the rest Missing on finished events, add registered names, drop duplicate roll entries. Leave it unset on a live org until you have tried it; a sandbox org always has it on. |

5. **Bindings:** add an **R2 bucket binding** named `PHOTOS` (Settings → Bindings).
6. Every push to the production branch builds and deploys; other branches get preview builds. Production and Preview variables are separate, so set them in both if you test on previews.
7. **Variable changes only apply to new deployments.** After adding or editing a variable or secret, go to Deployments → the latest Production row → **Retry deployment** (or push a commit). Until then the running Worker keeps the old values.

Use the **Secret** type for `NEON_API_KEY` (and `NEON_ORG_ID` if you like). Secrets are hidden after saving; plain Text values are readable in the dashboard.

Manual deploy from your machine:

```bash
npx wrangler login
npm run deploy
```

## Neon One integration

Admins can pull events from the Neon One CRM into the app: **Settings → Neon One**, choose dates, preview, then import. Events that already exist are linked instead of duplicated.

- The Worker proxies Neon One under `/api/neon/*` and holds the API key. The browser never sees it.
- Everything is **read-only** today. Pushing attendance back to Neon (check-in, volunteer hours, walk-ins) is not built yet.
- Findings about the API (verified fields, paging, auth) are in [`docs/neon-api-notes.md`](docs/neon-api-notes.md).

Local setup: create `.dev.vars` in the project root (git-ignored):

```ini
NEON_ORG_ID=your-org-id
NEON_API_KEY=your-api-key
FIREBASE_PROJECT_ID=your-firebase-project-id
```

### Sandbox vs. live

Local work (`npm run cf:preview`) reads `.dev.vars`, which points at the Neon One **sandbox** org (`ourstompinggroundsandbox`), so debugging and new features, including future write flows, never touch live data. Generate an API key in the sandbox org (Settings → Developer → API keys) and paste it as `NEON_API_KEY`.

The live org's values are kept in `.dev.vars.production` (also git-ignored). To run locally against live, read-only checks only, copy it over `.dev.vars` and restore the sandbox values afterwards. Cloudflare **Production** keeps the live org; to test a deployed build against the sandbox, set the sandbox values on the **Preview** tab instead.

Do **not** set `NEON_BASE_URL` (in `.dev.vars` or Cloudflare). The default `https://api.neoncrm.com/v2` is correct, and a wrong value, such as the documentation site, would send your credentials to the wrong host.

| Route | Description |
| --- | --- |
| `GET /api/neon/status` | Connection check |
| `GET /api/neon/events?from=&to=` | Events in a date range, normalized |
| `GET /api/neon/events/:id/registrations` | Registrations for an event |
| `GET /api/neon/events/:id/attendees` | Attendees with check-in state |
| `POST /api/neon/accounts/search` | Candidate accounts by name or email |

### Troubleshooting Neon One

| Symptom | Cause and fix |
| --- | --- |
| "Neon One is not configured yet (NEON_ORG_ID and NEON_API_KEY)" | The running Worker can't see the variables. Confirm both are on the **Production** tab with non-empty values, then **Retry deployment**. |
| "Neon One error: …" | The variables are read but Neon rejected the request. The message includes Neon's reason; check the key and org ID. |
| "Could not reach Neon One" | The `/api` route isn't answering. Check the deployment succeeded and you are online. |
| Neon events missing from the Events list | The list hides Neon errors on purpose. Run **Settings → Neon One → Preview** for the real message. Events that match a local event (same name, date and start time) are hidden as duplicates. |

## Daily use

**Admins**

1. Settings → *Create code*, with an expiry date, and share it with staff.
2. Manage locations, saved members and staff in Settings. Use *Revoke* to remove someone.

**Staff**

1. Open the app and sign in with Google or request an email link.
2. Enter the invitation code once and confirm your name.
3. Create or open an event, then check people in. New names typed during roll call are saved automatically.

**Install on a phone:** open the site in the browser and choose *Add to Home Screen* (or *Install app*).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run local` | Emulators plus Vite with seeded sample data |
| `npm run emulators` | Firebase Auth and Firestore emulators only |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Preview the production build with Vite |
| `npm run cf:preview` | Build and serve through the local Workers runtime (Pages Functions plus R2) |
| `npm run deploy` | Build and deploy to Cloudflare Pages |
| `npm test` | Unit tests |
| `npm run test:rules` | Firestore security rule tests (needs Java; starts the emulator) |

## Testing

```bash
npm test             # hours, CSV import/export, time helpers, photos, Worker auth and Neon proxy
npm run test:rules   # Firestore security rules against the emulator
```

Unit tests live next to the code as `*.test.js`; rules tests are in `test/rules`.

## Project structure

```
src/
  main.js            app shell, sign-in gate, router
  data.js            Firestore access
  firebase.js        Firebase init (emulator aware)
  views/             home, event, people, photos, report, settings, import, neon, about
  lib/               time/hours, CSV, importer, exporter, photos, Neon mapper, theme, icons
worker/              API: photos (R2), Neon One proxy, Firebase token verification
functions/api/       Pages Function that mounts the Worker
firestore.rules      security rules
scripts/local.mjs    one-command local dev
docs/                API notes
public/              icons and _headers (cache rules)
```

## Versioning and updates

- Every build is stamped `YYYY.MM.DD+<commit sha>` (from Cloudflare's commit env var, falling back to git). It is shown in the footer and on the About page.
- Each deploy produces a new service worker. Installed phones check on launch, when the app returns to the foreground, and hourly, then activate and reload automatically. Data lives in Firestore, so a reload loses nothing.
- `public/_headers` keeps `sw.js` and `index.html` from being cached by the edge or browser.

## Security notes

- Access is by invitation code, checked only when joining. Expiring a code does not remove existing staff; use *Revoke* in Settings.
- Firestore access is enforced by `firestore.rules` and covered by rule tests. Admin status comes from the `admins/<uid>` document.
- The API verifies a Firebase ID token on every request. The Neon One key is a server-side secret and is never sent to the browser.
- Email-link sign-in only proves control of an email address. It does not grant access without a valid invitation code.

## Contributing

Branch from `main`, keep changes focused, and run `npm test` (and `npm run test:rules` for rule changes) before opening a pull request. The owner reviews every change (see [CODEOWNERS](.github/CODEOWNERS)). Found a bug? [Open an issue](https://github.com/lyvuong/RollCall/issues).

## License

[MIT](LICENSE) © 2026 lyvuong
