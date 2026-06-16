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

  if (!user) {
    set({ signedIn: false, email: null });
    return;
  }
  set({ signedIn: true, email: user.email, error: null });

  const { fs, db } = fb;
  const ref = fs.doc(db, "users", user.uid);

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
  if (!fb) return;
  try {
    // setDoc replaces the doc with the merged local state (small payload).
    await fb.fs.setDoc(ref, JSON.parse(JSON.stringify(store.getState())));
  } catch (e) {
    set({ error: String(e && e.message ? e.message : e) });
  }
}

export async function signIn(email, password) {
  await fb.auth.signInWithEmailAndPassword(fb.authInst, email.trim(), password);
}

export async function signUp(email, password) {
  await fb.auth.createUserWithEmailAndPassword(fb.authInst, email.trim(), password);
}

export async function signOutUser() {
  await fb.auth.signOut(fb.authInst);
}
