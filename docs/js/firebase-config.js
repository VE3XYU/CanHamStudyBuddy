// Firebase web config for cloud sync (loaded by cloud.js).
//
// These values are NOT secret: Firebase web config is meant to ship in client
// code, so this file is committed (GitHub Pages can only serve files that are
// in the repo). The real protection is Firebase Auth + the Firestore allowlist
// rules in SETUP.md — not hiding this. The app intentionally does NOT load
// Google Analytics, so no usage tracking happens from here.
export const firebaseConfig = {
  apiKey: "AIzaSyAbog1wr-ED_wcobstFC38bQ3LKd0oM8uQ",
  authDomain: "chsb-c29d5.firebaseapp.com",
  projectId: "chsb-c29d5",
  storageBucket: "chsb-c29d5.firebasestorage.app",
  messagingSenderId: "250192355394",
  appId: "1:250192355394:web:7c0ed56b8288caf8908ddb",
  measurementId: "G-6129R883NR",
};
