# OSG Activity Roll Call

Offline-capable PWA for OSG staff to take roll call at events and track volunteer hours.
Vanilla JS + Vite, Firebase Auth (Google) + Firestore for data, hosted on Cloudflare (Workers static assets).

## One-time Firebase setup (auth + database only)
1. Create a Firebase project (Spark/free plan). Add a **Web app** and copy its config into `.env.local` (see `.env.example`).
2. Authentication → Sign-in method → enable **Google**.
3. Create a Firestore database (production mode).
4. `npx firebase login`, then `npx firebase use --add` to select the project.
5. `npx firebase deploy --only firestore:rules`
6. Make yourself the first admin: sign in once to the app, find your UID in Authentication → Users, then in Firestore create document `admins/<your uid>` (empty). Reload; Settings now shows invitation codes.
7. After the first deploy: Authentication → Settings → **Authorized domains** → add your `*.workers.dev` hostname (and any custom domain). Google sign-in fails without this.

## Hosting on Cloudflare, auto-deployed from GitHub
1. Push this repo to GitHub (`.env.local` is git-ignored).
2. Cloudflare dashboard → Workers & Pages → Create → **Import a repository** → pick the repo.
3. Build settings:
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy` (uses `wrangler.jsonc`; Worker name `rollcall`)
4. Build variables (Settings → Build → Variables): `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. These are baked into the bundle at build time; Firebase web config is not secret.
5. Every push to the production branch builds and deploys automatically; other branches get preview builds.

Manual deploy: `npx wrangler login` then `npm run deploy`.

## Versioning and updates
- Every build is stamped `YYYY.MM.DD+<commit sha>` (from Cloudflare's commit env var, falling back to git). It is shown at the bottom of Settings.
- Each push changes the bundle, so a new service worker is produced. Installed phones check for it on launch, when the app returns to the foreground, and hourly; it then activates and reloads automatically. Data lives in Firestore, so a reload loses nothing.
- `public/_headers` keeps `sw.js` and `index.html` from being cached by the edge or browser.

## Daily use
- Admin: Settings → *Create code* with an expiry date; share it with staff.
- Staff: open the app, sign in with Google, enter the code once.
- Locations and saved people ("frequent flyers") are managed in Settings; new names typed during roll call are saved automatically.
- Total volunteer hours for an event = event hours × number of checked-in volunteers (OSG members are counted separately).

## Develop
```
npm install
npm run dev          # app (set VITE_USE_EMULATOR=1 and run `npm run emulators` for local Firebase)
npm test             # unit tests
npm run test:rules   # Firestore rules tests (needs Java; starts the emulator)
npm run cf:preview   # build and serve via local Workers runtime
```

## Notes
- Invitation code is checked only when joining. Expiring a code does not remove existing staff; use *Revoke* in Settings.
- Offline: reads and check-offs work without a connection and sync on reconnect.
