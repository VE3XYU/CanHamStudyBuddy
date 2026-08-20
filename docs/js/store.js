// Local-first persistence: the single source of truth for the user's study
// data (per-question stats, notes, and quiz history). Everything is written to
// localStorage immediately; the optional cloud layer (cloud.js) mirrors this
// to Firestore and merges remote changes back in via mergeRemote().

import { uid, stableStringify } from "./util.js";

// Deleting a record outright cannot survive sync: mergeStates keeps whatever
// exists on either side, and an absence carries no timestamp to compare, so a
// peer still holding the old record silently resurrects it everywhere. So a
// "delete" writes a tombstone — the record stays, marked `cleared` with a fresh
// `updatedAt` — and every reader treats a cleared record as absent. Newest wins
// then works in both directions.
function tombstone() {
  return { cleared: true, updatedAt: now() };
}

// True when a record exists and has not been cleared.
export function isLive(rec) {
  return !!rec && !rec.cleared;
}

const KEY = "canham_adv_state_v1";
const HISTORY_CAP = 200;
const STATE_VERSION = 1;
// A "needs practice" mark auto-clears once the question has been answered
// correctly this many times in a row.
const FOCUS_CLEAR_STREAK = 3;

// Safe storage: falls back to an in-memory map when localStorage is
// unavailable (private mode, Node test runs, etc.) so the app never throws.
const storage = (() => {
  try {
    if (typeof localStorage !== "undefined") {
      const probe = "__canham_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (_) {
    /* fall through to memory */
  }
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
})();

// Monotonic: two writes in the same millisecond would otherwise carry equal
// `updatedAt`, and mergeStates resolves ties in favour of whichever side it
// happens to read first — so clearing a record and re-marking it in quick
// succession could resolve backwards. Never goes backwards, and only ever runs
// ahead of the wall clock by one ms per write in a burst.
let lastStamp = 0;
function now() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

function emptyState() {
  return { v: STATE_VERSION, stats: {}, notes: {}, flags: {}, focus: {}, history: [], updatedAt: 0 };
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") return emptyState();
  return {
    v: STATE_VERSION,
    stats: raw.stats && typeof raw.stats === "object" ? raw.stats : {},
    notes: raw.notes && typeof raw.notes === "object" ? raw.notes : {},
    flags: raw.flags && typeof raw.flags === "object" ? raw.flags : {},
    focus: raw.focus && typeof raw.focus === "object" ? raw.focus : {},
    history: Array.isArray(raw.history) ? raw.history : [],
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function read() {
  try {
    const raw = storage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw)) : emptyState();
  } catch (_) {
    return emptyState();
  }
}

let state = read();
const listeners = new Set();

function write({ bumpClock = true, notify = true } = {}) {
  if (bumpClock) state.updatedAt = now();
  try {
    storage.setItem(KEY, JSON.stringify(state));
  } catch (_) {
    /* ignore quota / serialization errors */
  }
  if (notify) listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (_) {
      /* a listener error shouldn't break others */
    }
  });
}

export function getState() {
  return state;
}

// Subscribe to state changes; returns an unsubscribe function.
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recordAnswer(qid, isCorrect, guessed = false) {
  const cur = state.stats[qid] || {
    attempts: 0,
    correct: 0,
    lastResult: null,
    lastSeenAt: 0,
  };
  state.stats[qid] = {
    attempts: cur.attempts + 1,
    correct: cur.correct + (isCorrect ? 1 : 0),
    lastResult: isCorrect ? "correct" : "incorrect",
    lastSeenAt: now(),
  };
  // A "needs practice" question tracks a streak of consecutive correct answers.
  // Only answers the user did NOT flag as a guess count toward mastery — a lucky
  // guess (correct but flagged) resets the streak just like a wrong answer, so
  // the mark can't be cleared by guessing. Reaching the threshold clears it.
  const f = isLive(state.focus[qid]) ? state.focus[qid] : null;
  if (f) {
    if (isCorrect && !guessed) {
      const streak = (f.streak || 0) + 1;
      if (streak >= FOCUS_CLEAR_STREAK) state.focus[qid] = tombstone();
      else state.focus[qid] = { streak, updatedAt: now() };
    } else {
      state.focus[qid] = { streak: 0, updatedAt: now() };
    }
  }
  write();
}

export function getNote(qid) {
  return isLive(state.notes[qid]) ? state.notes[qid].text : "";
}

// Ids of notes that still exist (tombstones excluded).
export function noteIds() {
  return Object.keys(state.notes).filter((id) => isLive(state.notes[id]));
}

export function setNote(qid, text) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    if (!isLive(state.notes[qid])) return; // nothing to change
    state.notes[qid] = tombstone();
  } else {
    const existing = state.notes[qid];
    if (isLive(existing) && existing.text === trimmed) return; // unchanged
    state.notes[qid] = { text: trimmed, updatedAt: now() };
  }
  write();
}

// Flags: the user marking an AI-generated explanation as possibly wrong, with
// an optional free-text reason. Local-first like notes — the presence of a
// record means "flagged"; clearing it removes the record.
export function getFlag(qid) {
  return isLive(state.flags[qid]) ? state.flags[qid] : null;
}

// Ids of explanation flags that are still raised (tombstones excluded).
export function flagIds() {
  return Object.keys(state.flags).filter((id) => isLive(state.flags[id]));
}

export function setFlagged(qid, flagged, reason = "") {
  const existing = isLive(state.flags[qid]) ? state.flags[qid] : null;
  if (!flagged) {
    if (!existing) return; // nothing to change
    state.flags[qid] = tombstone();
  } else {
    const r = (reason || "").trim();
    if (existing && existing.reason === r) return; // unchanged
    state.flags[qid] = { reason: r, updatedAt: now() };
  }
  write();
}

// Focus: the user marking a question "I have no idea" so it rotates more often.
// The record holds a `streak` of consecutive correct answers (see recordAnswer);
// presence of the record means "needs practice".
export function isFocused(qid) {
  return isLive(state.focus[qid]);
}

export function setFocus(qid, focused) {
  if (focused) {
    if (isLive(state.focus[qid])) return; // already marked — keep its streak
    state.focus[qid] = { streak: 0, updatedAt: now() };
  } else {
    if (!isLive(state.focus[qid])) return;
    state.focus[qid] = tombstone();
  }
  write();
}

export function focusCount() {
  return Object.keys(state.focus).filter((id) => isLive(state.focus[id])).length;
}

// Clear every needs-practice mark at once. Returns how many were cleared.
export function clearAllFocus() {
  const live = Object.keys(state.focus).filter((id) => isLive(state.focus[id]));
  for (const id of live) state.focus[id] = tombstone();
  if (live.length) write();
  return live.length;
}

export function addHistory(entry) {
  const record = { id: uid(), ...entry };
  state.history.unshift(record);
  if (state.history.length > HISTORY_CAP) state.history.length = HISTORY_CAP;
  write();
  return record;
}

export function resetAll() {
  state = emptyState();
  write();
}

// Merge a remote snapshot (from the cloud) into local state. Returns true if
// local state actually changed. Uses last-write-wins per record.
export function mergeRemote(remote) {
  // stableStringify ignores key order, so re-merging identical remote data is
  // correctly seen as "no change" and avoids a needless notify + cloud write.
  const before = stableStringify(state);
  state = mergeStates(state, normalize(remote));
  const changed = stableStringify(state) !== before;
  // Persist without bumping the clock (the merge already reconciled times).
  write({ bumpClock: false, notify: changed });
  return changed;
}

// Pure merge of two state objects. Exported for testing.
export function mergeStates(a, b) {
  const out = emptyState();

  const qids = new Set([...Object.keys(a.stats), ...Object.keys(b.stats)]);
  for (const qid of qids) {
    const ra = a.stats[qid];
    const rb = b.stats[qid];
    if (!ra) out.stats[qid] = rb;
    else if (!rb) out.stats[qid] = ra;
    else out.stats[qid] = (rb.lastSeenAt || 0) > (ra.lastSeenAt || 0) ? rb : ra;
  }

  const nids = new Set([...Object.keys(a.notes), ...Object.keys(b.notes)]);
  for (const nid of nids) {
    const na = a.notes[nid];
    const nb = b.notes[nid];
    if (!na) out.notes[nid] = nb;
    else if (!nb) out.notes[nid] = na;
    else out.notes[nid] = (nb.updatedAt || 0) > (na.updatedAt || 0) ? nb : na;
  }

  const fids = new Set([...Object.keys(a.flags || {}), ...Object.keys(b.flags || {})]);
  for (const fid of fids) {
    const fa = (a.flags || {})[fid];
    const fb = (b.flags || {})[fid];
    if (!fa) out.flags[fid] = fb;
    else if (!fb) out.flags[fid] = fa;
    else out.flags[fid] = (fb.updatedAt || 0) > (fa.updatedAt || 0) ? fb : fa;
  }

  const focusIds = new Set([...Object.keys(a.focus || {}), ...Object.keys(b.focus || {})]);
  for (const id of focusIds) {
    const xa = (a.focus || {})[id];
    const xb = (b.focus || {})[id];
    if (!xa) out.focus[id] = xb;
    else if (!xb) out.focus[id] = xa;
    else out.focus[id] = (xb.updatedAt || 0) > (xa.updatedAt || 0) ? xb : xa;
  }

  const byId = new Map();
  for (const h of [...a.history, ...b.history]) {
    if (h && h.id && !byId.has(h.id)) byId.set(h.id, h);
  }
  out.history = [...byId.values()]
    .sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0))
    .slice(0, HISTORY_CAP);

  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  return out;
}
