// Small dependency-free helpers shared across the app.

// Fisher–Yates shuffle, returns a new array (does not mutate the input).
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Escape text for safe insertion into HTML (question/answer/note text may
// contain <, >, &, quotes, etc.).
export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// Integer percentage, guarding divide-by-zero.
export function pct(num, den) {
  return den ? Math.round((num / den) * 100) : 0;
}

// Short, collision-resistant id for local records (history entries).
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
