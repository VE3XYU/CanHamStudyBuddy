// Cloud sync config template.
//
// To enable syncing your notes/scores/progress across devices:
//   1. Copy this file to `firebase-config.js` (same folder).
//   2. Paste the web config from your Firebase project below.
//   3. See SETUP.md for the full walkthrough (creating the project, enabling
//      Email/Password auth, and the Firestore security rules).
//
// These values are NOT secret — Firebase web config is meant to ship in client
// code. Your data is protected by Firebase Auth + the Firestore security rules,
// not by hiding this config. Without `firebase-config.js`, the app still works
// fully on this device using local storage.

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  appId: "YOUR_APP_ID",
};
