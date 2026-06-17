// Local-first persistence: the single source of truth for the user's study
// data (per-question stats, notes, and quiz history). Everything is written to
// localStorage immediately; the optional cloud layer (cloud.js) mirrors this
// to Firestore and merges remote changes back in via mergeRemote().

import { uid } from "./util.js";

const KEY = "canham_adv_state_v1";
const HISTORY_CAP = 200;
const STATE_VERSION = 1;

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

function now() {
  return Date.now();
}

function emptyState() {
  return { v: STATE_VERSION, stats: {}, notes: {}, history: [], updatedAt: 0 };
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") return emptyState();
  return {
    v: STATE_VERSION,
    stats: raw.stats && typeof raw.stats === "object" ? raw.stats : {},
    notes: raw.notes && typeof raw.notes === "object" ? raw.notes : {},
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

export function recordAnswer(qid, isCorrect) {
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
  write();
}

export function getNote(qid) {
  return state.notes[qid] ? state.notes[qid].text : "";
}

export function setNote(qid, text) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    if (!state.notes[qid]) return; // nothing to change
    delete state.notes[qid];
  } else {
    const existing = state.notes[qid];
    if (existing && existing.text === trimmed) return; // unchanged
    state.notes[qid] = { text: trimmed, updatedAt: now() };
  }
  write();
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
  const before = JSON.stringify(state);
  state = mergeStates(state, normalize(remote));
  const changed = JSON.stringify(state) !== before;
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
