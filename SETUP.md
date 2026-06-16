# Setup & deployment

The app is a static, client-side site in `docs/`. It works fully offline on one
device with **no setup at all**; cloud sync across devices is optional.

## 1. Run it locally

ES modules need to be served over HTTP (opening `index.html` via `file://`
won't work), so start any static server from the repo root:

```bash
python3 -m http.server 8765 --directory docs
# then open http://localhost:8765
```

## 2. Deploy to GitHub Pages (free)

1. Make sure the app is on your default branch (`main`). Merge your working
   branch if needed.
2. On GitHub: **Settings → Pages → Build and deployment**.
3. **Source:** "Deploy from a branch". **Branch:** `main`, **Folder:** `/docs`.
   Save.
4. After a minute the site is live at
   `https://<your-username>.github.io/CanHamStudyBuddy/`.

Your notes/scores/progress live in your browser (and your Firebase project if
you enable sync), not in the repo, so it's fine for the site itself to be
public — the question bank is public ISED material anyway.

## 3. Enable cross-device sync (optional)

Sync uses Firebase (Auth + Firestore). The free "Spark" plan is plenty for one
person. Firebase web config is **not secret** — it's designed to ship in client
code; security comes from Auth + the Firestore rules below.

### a. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project**.
2. In the project, **Build → Authentication → Get started → Sign-in method →
   Email/Password → Enable**.
3. **Build → Firestore Database → Create database** (Production mode is fine).

### b. Lock Firestore to each signed-in user

In **Firestore → Rules**, paste and publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

This lets each account read/write only its own `users/{uid}` document.

### c. Add your web config to the app

1. **Project settings → General → Your apps → Web app** (`</>`). Register an
   app; copy the `firebaseConfig` values.
2. Copy `docs/firebase-config.example.js` to `docs/firebase-config.js` and fill
   in your values. (`docs/firebase-config.js` is gitignored.)

### d. Authorize your domains for sign-in

In **Authentication → Settings → Authorized domains**, add the domain you'll
use, e.g. `your-username.github.io`. `localhost` is authorized by default for
local testing.

### e. Use it

Reload the app, open the **Sync** tab, and **Create account** (once), then
**Sign in** on each device with the same email/password. Notes, scores, and
progress merge and stay in sync automatically.

## 4. Regenerating the question data

`docs/js/data/questions.js` is generated from the source bank. If you edit
`amat_adv_quest_delim.txt`, rebuild it:

```bash
python3 scripts/build_questions.py
```

## 5. Tests

```bash
node scripts/selftest.mjs   # pure logic: dataset integrity, quiz, stats, merge
```
