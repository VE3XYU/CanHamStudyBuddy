// Optional cloud sync via Firebase (Auth + Firestore).
//
// The app is local-first. If firebase-config.js is missing or fails to load,
// this module reports { enabled: false } and the app runs purely on
// localStorage. When configured and signed in, the user's state is mirrored to
// users/{uid} in Firestore and remote changes are merged back in live, so
// notes/scores/progress follow the user across devices.

import * as store from "./store.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.5";
const WRITE_DEBOUNCE_MS = 800;
// Upper bound on how long sign-out waits for a final flush. Firestore's setDoc
// promise stays pending while offline, so sign-out must not await it unbounded.
const FLUSH_TIMEOUT_MS = 4000;
// How long to wait for the first server read before flagging a sync problem.
const SYNC_TIMEOUT_MS = 10000;

let cloud = { enabled: false, ready: false, signedIn: false, email: null, error: null, syncError: false };
const listeners = new Set();

let fb = null; // { auth, fs, authInst, db }
let unsubSnapshot = null;
let unsubStore = null;
let writeTimer = null;
let syncTimer = null;
let applyingRemote = false;
let wasSignedIn = false; // true once a user has signed in this session
let currentRef = null; // Firestore doc ref for the signed-in user
let currentUid = null; // uid of the signed-in user (for central flag reports)
// True once we've read the signed-in user's cloud doc from the SERVER at least
// once. Until then we must NOT push: we don't yet know what's in the cloud, so
// writing our local (possibly empty) state could overwrite real data.
let readConfirmed = false;
// updatedAt of the newest local state the cloud is confirmed to hold (-1 = none
// pushed yet). Compared against the live state to decide the sign-out wipe.
let lastPushedAt = -1;

function set(patch) {
  cloud = { ...cloud, ...patch };
  listeners.forEach((fn) => {
    try {
      fn(cloud);
    } catch (_) {
      /* ignore listener errors */
    }
  });
}

export function cloudState() {
  return cloud;
}

export function onCloud(fn) {
  listeners.add(fn);
  fn(cloud);
  return () => listeners.delete(fn);
}

export async function initCloud() {
  let config;
  try {
    const mod = await import("./firebase-config.js");
    config = mod.firebaseConfig || mod.default;
  } catch (_) {
    set({ enabled: false, ready: true });
    return;
  }
  if (!config || !config.apiKey) {
    set({ enabled: false, ready: true });
    return;
  }

  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const app = appMod.initializeApp(config);
    fb = {
      auth: authMod,
      fs: fsMod,
      authInst: authMod.getAuth(app),
      db: fsMod.getFirestore(app),
    };
    set({ enabled: true, ready: true });
    fb.auth.onAuthStateChanged(fb.authInst, (user) => {
      handleAuth(user).catch((e) => set({ error: String(e && e.message ? e.message : e) }));
    });
  } catch (e) {
    set({ enabled: false, ready: true, error: String(e && e.message ? e.message : e) });
  }
}

async function handleAuth(user) {
  if (unsubSnapshot) {
    unsubSnapshot();
    unsubSnapshot = null;
  }
  if (unsubStore) {
    unsubStore();
    unsubStore = null;
  }
  // Tear down timers and the push gate so a stale timer or early push can't
  // overwrite the cloud after we switch users or clear local data below.
  clearTimeout(writeTimer);
  clearTimeout(syncTimer);
  readConfirmed = false;

  if (!user) {
    // A real sign-out (not the initial "no user" at page load) wipes this
    // browser's local copy so nothing lingers for the next person. We only do
    // this once we're confident the cloud already holds the CURRENT local state
    // (the last confirmed push is at least as new as local). That way a
    // denied/misconfigured/offline sync can never cause local data loss — the
    // unsynced edits stay put. The cloud document is untouched and is restored
    // on the next sign-in.
    if (wasSignedIn && lastPushedAt >= store.getState().updatedAt) store.resetAll();
    wasSignedIn = false;
    currentRef = null;
    currentUid = null;
    lastPushedAt = -1;
    set({ signedIn: false, email: null, syncError: false, error: null });
    return;
  }
  wasSignedIn = true;
  set({ signedIn: true, email: user.email, error: null, syncError: false });

  const { fs, db } = fb;
  const ref = fs.doc(db, "users", user.uid);
  currentRef = ref;
  currentUid = user.uid;

  // onSnapshot delivers the initial read AND live updates. We only start
  // pushing once we've seen this doc from the SERVER (readConfirmed) — that's
  // how we avoid overwriting real cloud data with a local-only copy when the
  // read is denied/blocked. If no server read arrives, the error callback or
  // the timeout surfaces a sync problem instead of failing silently.
  syncTimer = setTimeout(() => {
    if (!readConfirmed) {
      set({
        syncError: true,
        error: "Couldn't reach the cloud — check your connection, or a browser privacy setting or extension may be blocking it. Your data is safe on this device.",
      });
    }
  }, SYNC_TIMEOUT_MS);

  unsubSnapshot = fs.onSnapshot(
    ref,
    (snap) => {
      if (snap.metadata.hasPendingWrites) return; // ignore our own un-acked write
      if (snap.exists()) {
        applyingRemote = true;
        store.mergeRemote(snap.data());
        applyingRemote = false;
      }
      if (!snap.metadata.fromCache && !readConfirmed) {
        // First confirmed server read — now it's safe to mirror local up.
        readConfirmed = true;
        clearTimeout(syncTimer);
        set({ syncError: false, error: null });
        pushNow(ref);
        // Mirror any local flags to the central collection now that we're synced.
        const flags = store.getState().flags || {};
        for (const qid of Object.keys(flags)) reportFlag(qid, flags[qid].reason || "");
      }
    },
    (err) => {
      clearTimeout(syncTimer);
      set({ syncError: true, error: cloudErrorMessage(err) });
    }
  );

  unsubStore = store.subscribe(() => {
    if (applyingRemote || !readConfirmed) return; // never push before a safe read
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => pushNow(ref), WRITE_DEBOUNCE_MS);
  });
}

async function pushNow(ref) {
  // Never write before a confirmed server read (see handleAuth): otherwise a
  // local-only state could overwrite real cloud data.
  if (!fb || !readConfirmed) return false;
  // Snapshot the version we're about to push first; on success that's the
  // newest state the cloud is known to hold. No awaits between reading
  // updatedAt and serializing, so they can't drift apart. On failure we leave
  // lastPushedAt untouched (it stays behind local, keeping the wipe gate safe).
  const snapshot = store.getState();
  const pushedAt = snapshot.updatedAt || 0;
  try {
    // setDoc replaces the doc with the merged local state (small payload).
    await fb.fs.setDoc(ref, JSON.parse(JSON.stringify(snapshot)));
    lastPushedAt = pushedAt;
    if (cloud.syncError) set({ syncError: false, error: null });
    return true;
  } catch (e) {
    set({ error: cloudErrorMessage(e), syncError: true });
    return false;
  }
}

// A short, user-facing message for a Firestore failure (raw SDK text is noisy).
function cloudErrorMessage(e) {
  const code = (e && e.code) || "";
  if (code.includes("permission-denied"))
    return "This account isn't allowed to sync — check the email allowlist in your Firestore rules (see SETUP.md). Your data is safe on this device.";
  if (code.includes("unavailable") || code.includes("network"))
    return "Couldn't reach the cloud — a network, VPN, or browser privacy setting or extension may be blocking Firestore. Your data is safe on this device.";
  return "Sync error — your data is safe on this device.";
}

export async function signIn(email, password) {
  await fb.auth.signInWithEmailAndPassword(fb.authInst, email.trim(), password);
}

export async function signUp(email, password) {
  await fb.auth.createUserWithEmailAndPassword(fb.authInst, email.trim(), password);
}

// Flush any pending local changes to the cloud while still authenticated, so
// the post-sign-out local wipe can't drop the last edits.
async function flush() {
  clearTimeout(writeTimer);
  if (!cloud.signedIn || !currentRef) return;
  // pushNow never rejects; race it against a timeout so an offline (forever
  // pending) write can't hang sign-out. If it times out, lastPushedAt stays
  // behind local and the wipe is skipped — data is preserved, not lost.
  await Promise.race([
    pushNow(currentRef),
    new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
  ]);
}

export async function signOutUser() {
  try {
    await flush();
  } catch (_) {
    /* don't block sign-out on a final sync */
  }
  await fb.auth.signOut(fb.authInst);
}

// --- central explanation flags ---------------------------------------------
// When a signed-in user flags an AI explanation, mirror it to a top-level
// `explanation_flags` collection the maintainer can review (separate from the
// user's private users/{uid} state). The doc id is `{uid}__{qid}`, so a user
// has one flag per question: re-flagging updates it, un-flagging deletes it.
// Best-effort and always non-throwing — when sync is off or the user isn't
// signed in this no-ops and the flag simply stays local.
const FLAGS_COLLECTION = "explanation_flags";

export async function reportFlag(qid, reason) {
  if (!fb || !cloud.signedIn || !currentUid || !qid) return;
  try {
    const { fs, db } = fb;
    const ref = fs.doc(db, FLAGS_COLLECTION, `${currentUid}__${qid}`);
    await fs.setDoc(ref, {
      qid,
      uid: currentUid,
      email: cloud.email || null,
      reason: (reason || "").slice(0, 2000),
      updatedAt: fs.serverTimestamp(),
    });
  } catch (_) {
    /* reporting a flag must never break the app */
  }
}

export async function withdrawFlag(qid) {
  if (!fb || !cloud.signedIn || !currentUid || !qid) return;
  try {
    const { fs, db } = fb;
    await fs.deleteDoc(fs.doc(db, FLAGS_COLLECTION, `${currentUid}__${qid}`));
  } catch (_) {
    /* best-effort */
  }
}
