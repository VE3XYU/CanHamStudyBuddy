# Setup & deployment

The app is a static, client-side site in `docs/`. It runs on one device with
**no setup at all** — no account or server, everything is stored in your
browser; cloud sync across devices is optional.

## 1. Run it locally

ES modules need to be served over HTTP (opening `index.html` via `file://`
won't work), so start any static server from the repo root:

```bash
python3 -m http.server 8765 --directory docs
# then open http://localhost:8765
```

## 2. Deploy to GitHub Pages (free)

The app is served straight from the `docs/` folder — GitHub Pages can publish it
directly from a branch, with no build step or workflow.

One-time setup on GitHub:

1. **Make the repository public.** Pages on a *private* repo requires a paid
   plan; on the Free plan the repo must be public. (**Settings → General →
   Danger Zone → Change repository visibility → Public**.) Your notes/scores
   live in your browser and your own Firebase project — never in the repo — and
   the question bank is public ISED material, so nothing private is exposed.
2. **Settings → Pages → Build and deployment → Source: "Deploy from a branch".**
   Pick the branch to publish (e.g. `claude/gifted-goldberg-y393p7` or `main`)
   and folder **`/docs`**, then **Save**.
3. Wait ~1 minute. The site goes live at
   `https://<your-username>.github.io/CanHamStudyBuddy/`, and re-publishes
   automatically whenever you push to that branch.

> Why not the "GitHub Actions" Pages source? Its auto-created `github-pages`
> environment only allows deployments from the repo's **default** branch, so an
> Actions deploy from a feature branch is rejected before it runs. "Deploy from
> a branch" has no such restriction.

## 3. Enable cross-device sync (optional)

Sync uses Firebase (Auth + Firestore). The free "Spark" plan is plenty for one
person. Firebase web config is **not secret** — it's designed to ship in client
code; security comes from Auth + the Firestore rules below.

### a. Create the Firebase project

Console links use `_` for "your current project". Order doesn't matter —
Authentication and Firestore are independent products.

1. <https://console.firebase.google.com> → **Add project**.
2. **Authentication** (`/project/_/authentication`) → **Get started** →
   **Email/Password** → Enable.
3. Create your own login: **Authentication → Users → Add user** (email +
   password). Then **Authentication → Settings → User actions** → uncheck
   **Enable create (sign-up)** so nobody else can self-register.
4. **Firestore Database** (`/project/_/firestore`) → **Create database** →
   **Production mode** → choose a location.

### b. Lock Firestore to each signed-in user

In **Firestore → Rules**, paste and publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Only these signed-in emails may use the app at all.
    function allowed() {
      return request.auth != null
        && request.auth.token.email in [
             "you@example.com"
           ];
    }

    // Each allowed user can read/write ONLY their own document.
    match /users/{uid} {
      allow read, write: if allowed() && request.auth.uid == uid;
    }

    // Flagged AI explanations. An allowed user may create/update/delete only
    // their own flag (doc id "{uid}__{qid}", so one per question). Clients can
    // never read others' flags — you review them in the Firebase console.
    match /explanation_flags/{flagId} {
      allow create, update: if allowed()
        && request.resource.data.uid == request.auth.uid;
      allow delete: if allowed() && resource.data.uid == request.auth.uid;
      allow read: if false;
    }
  }
}
```

Two independent gates: the email must be on the allowlist, and each account can
touch only its own `users/{uid}` document (and its own flags). Add classmates'
emails to the list when you open it up. Everything else is denied by default.

### c. Add your web config to the app

1. **Project settings → General → Your apps → Web app** (`</>`). Register an
   app; copy the `firebaseConfig` values.
2. Copy `docs/js/firebase-config.example.js` to `docs/js/firebase-config.js`
   and fill in your values. This file **is committed** — the deployed Pages
   site can only load files in the repo, and the web config is non-secret.

### d. Authorize your domains for sign-in

In **Authentication → Settings → Authorized domains**, add the domain you'll
use, e.g. `your-username.github.io`. `localhost` is authorized by default for
local testing.

### e. Use it

Reload the app, open the **Login** tab, and **Sign in** with the email/password
you created in the console (sign-up is disabled, so there's no "Create account"
step). Sign in the same way on each device — notes, scores, and progress merge
and stay in sync automatically. Signing out clears this browser's local copy
(your data stays in the cloud and returns when you sign back in).

### f. Reviewing flagged explanations

When a signed-in user taps **Flag as wrong** on an explanation, the app writes a
document to the top-level **`explanation_flags`** collection (separate from each
user's private `users/{uid}` data). Each doc holds the question id (`qid`), the
reporter's `uid` and `email`, their optional `reason`, and an `updatedAt`
timestamp; the doc id is `{uid}__{qid}`, so re-flagging updates it in place and
un-flagging deletes it.

Review them in the console under **Firestore → Data → `explanation_flags`** (sort
by `updatedAt`). The rules deny client reads, so only you — through the console
or the Admin SDK — can see them. To fix a flagged explanation, edit the matching
entry in `explanations/section-N.json` and rebuild with `python3
scripts/build_explanations.py`.

> Flags are only sent for **signed-in** users (they ride your Firebase project).
> A user who never signs in keeps their flags on-device only, so encourage
> sign-in if you want their feedback.

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
