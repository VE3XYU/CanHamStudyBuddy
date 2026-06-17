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

let cloud = { enabled: false, ready: false, signedIn: false, email: null, error: null };
const listeners = new Set();

let fb = null; // { auth, fs, authInst, db }
let unsubSnapshot = null;
let unsubStore = null;
let writeTimer = null;
let applyingRemote = false;
let wasSignedIn = false; // true once a user has signed in this session
let currentRef = null; // Firestore doc ref for the signed-in user
let lastPushOk = false; // did the most recent cloud write succeed?

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
  // Cancel any debounced push so a stale timer can't overwrite the cloud
  // (with possibly-empty state) after we tear down or clear local data below.
  clearTimeout(writeTimer);

  if (!user) {
    // A real sign-out (not the initial "no user" at page load) wipes this
    // browser's local copy so nothing lingers for the next person. We only do
    // this once we're confident the cloud already has the data (lastPushOk), so
    // a denied/misconfigured sync can never cause local data loss. The cloud
    // document is untouched and is restored on the next sign-in.
    if (wasSignedIn && lastPushOk) store.resetAll();
    wasSignedIn = false;
    currentRef = null;
    lastPushOk = false;
    set({ signedIn: false, email: null });
    return;
  }
  wasSignedIn = true;
  set({ signedIn: true, email: user.email, error: null });

  const { fs, db } = fb;
  const ref = fs.doc(db, "users", user.uid);
  currentRef = ref;

  try {
    const snap = await fs.getDoc(ref);
    if (snap.exists()) store.mergeRemote(snap.data());
  } catch (_) {
    /* an initial read failure shouldn't block local use */
  }
  await pushNow(ref);

  unsubSnapshot = fs.onSnapshot(ref, (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    applyingRemote = true;
    store.mergeRemote(snap.data());
    applyingRemote = false;
  });

  unsubStore = store.subscribe(() => {
    if (applyingRemote) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => pushNow(ref), WRITE_DEBOUNCE_MS);
  });
}

async function pushNow(ref) {
  if (!fb) return false;
  try {
    // setDoc replaces the doc with the merged local state (small payload).
    await fb.fs.setDoc(ref, JSON.parse(JSON.stringify(store.getState())));
    lastPushOk = true;
    return true;
  } catch (e) {
    lastPushOk = false;
    set({ error: String(e && e.message ? e.message : e) });
    return false;
  }
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
  if (cloud.signedIn && currentRef) await pushNow(currentRef);
}

export async function signOutUser() {
  try {
    await flush();
  } catch (_) {
    /* don't block sign-out on a final sync */
  }
  await fb.auth.signOut(fb.authInst);
}
