"use strict";
/* Shared helpers for host.js and play.js: Supabase client, clock sync, realtime, UI bits. */
const LETTERS = ["A", "B", "C", "D"];
const COLORS = ["bg-a", "bg-b", "bg-c", "bg-d"];
const MARK = "/assets/mark.png";
const ROUND = {
  quiz:   { label: "Quiz",            icon: "?" },
  poll:   { label: "Poll",            icon: "▮" },
  type:   { label: "Fastest fingers", icon: "⌨" },
  raffle: { label: "Raffle",          icon: "★" }
};
const roundLabel = (t) => (ROUND[t] || ROUND.quiz).label;
// Kept in sync with public._avatars() in the database.
const AVATARS = ["🦁", "🐯", "🐼", "🦊", "🐸", "🐵", "🦄", "🐙", "🐬", "🦋", "🐝", "🐢", "🦉", "🐧", "🐨", "🐰", "🐶", "🐱", "🌟", "🔥", "⚡", "🎉", "🎧", "🚀"];
const REACTIONS = ["👏", "😂", "🔥", "😮", "❤️", "🎉"];
const av = (a) => (a && AVATARS.includes(a) ? `<span class="av" aria-hidden="true">${a}</span>` : "");
const CFG = window.EP_CONFIG || {};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

const store = {
  get(key, area = localStorage) { try { return JSON.parse(area.getItem(key)); } catch { return null; } },
  set(key, val, area = localStorage) { try { area.setItem(key, JSON.stringify(val)); } catch { /* storage full or blocked */ } },
  del(key, area = localStorage) { try { area.removeItem(key); } catch { /* ignore */ } }
};

/* Small notification at the bottom of the screen. */
let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  if (!t) return;
  t.innerHTML = `<span class="toast-icon" aria-hidden="true">${bad ? "!" : "✓"}</span><span>${esc(msg)}</span>`;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); setTimeout(() => { t.hidden = true; }, 250); }, 3500);
}

/**
 * Branded popup in place of the browser's confirm()/alert().
 * Resolves true when confirmed, false when cancelled (button, Esc or backdrop click).
 *   popup({ title, message, confirmLabel, cancelLabel, tone: "danger" | "primary", icon })
 * Pass cancelLabel: null for a single-button message.
 */
function popup({ title, message = "", confirmLabel = "OK", cancelLabel = "Cancel", tone = "primary", icon } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal ${tone === "danger" ? "danger" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-msg">
        <div class="modal-icon" aria-hidden="true">${esc(icon || (tone === "danger" ? "!" : "?"))}</div>
        <h2 id="modal-title">${esc(title)}</h2>
        ${message ? `<p id="modal-msg">${esc(message)}</p>` : ""}
        <div class="modal-actions">
          ${cancelLabel ? `<button class="btn" data-modal="cancel">${esc(cancelLabel)}</button>` : ""}
          <button class="btn ${tone === "danger" ? "danger-solid" : "primary"}" data-modal="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const close = (val) => {
      document.removeEventListener("keydown", onKey, true);
      wrap.classList.remove("show");
      setTimeout(() => wrap.remove(), 180);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Tab") {
        // keep focus inside the popup
        const btns = [...wrap.querySelectorAll("button")];
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      } else if (e.key === "Enter" || e.key === " ") {
        // Enter/Space act on the focused button and must not reach page shortcuts
        e.stopPropagation();
      }
    };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) return close(false);
      const b = e.target.closest("[data-modal]");
      if (b) { e.stopPropagation(); close(b.dataset.modal === "ok"); }
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("show"));
    // Focus the safe choice for destructive actions, the main action otherwise.
    (wrap.querySelector(tone === "danger" && cancelLabel ? '[data-modal="cancel"]' : '[data-modal="ok"]')).focus();
  });
}

/* Keep the screen awake during a game (projector laptops and phones). */
const wake = {
  lock: null,
  want: false,
  async on() {
    this.want = true;
    try { if (!this.lock && "wakeLock" in navigator) { this.lock = await navigator.wakeLock.request("screen"); this.lock.addEventListener("release", () => { this.lock = null; }); } } catch { /* not allowed */ }
  },
  off() { this.want = false; if (this.lock) this.lock.release(); this.lock = null; }
};
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && wake.want) wake.on(); });

/* ---------- Supabase ---------- */
if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
  document.addEventListener("DOMContentLoaded", () => toast("Missing Supabase config (public/config.js).", true));
}
// Organisers stay signed in on the host page; attendee phones never sign in.
const IS_HOST = document.body.classList.contains("host-page");
const sb = window.supabase.createClient(CFG.supabaseUrl || "http://invalid.local", CFG.supabaseAnonKey || "missing", {
  auth: IS_HOST
    ? { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "ep-live:auth" }
    : { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

/* Server clock: deadlines come from the database, so every screen counts down
   to the same moment whatever the device clock says. */
const clock = {
  offset: 0,
  rtt: Infinity,
  now() { return Date.now() + this.offset; },
  sample(serverNow, t0, t1) {
    const rtt = t1 - t0;
    if (rtt <= this.rtt + 40) { this.rtt = Math.min(this.rtt, rtt); this.offset = serverNow - (t0 + t1) / 2; }
  }
};

const NET_ERR = "Can't reach the server. Check your connection.";
/** Call a database function. Returns its JSON, or { error, network } on failure. */
async function rpc(fn, args) {
  const t0 = Date.now();
  let res;
  try { res = await sb.rpc(fn, args); } catch { return { error: NET_ERR, network: true }; }
  const t1 = Date.now();
  if (res.error) {
    console.error(fn, res.error);
    const network = !res.status || /fetch|network|timeout/i.test(res.error.message || "");
    return { error: network ? NET_ERR : "Something went wrong. Please try again.", network };
  }
  const d = res.data || {};
  if (d.server_now) clock.sample(d.server_now, t0, t1);
  return d;
}

/** Subscribe to a public broadcast topic. handlers: { eventName: fn(payload) } */
function listen(topic, handlers, onStatus) {
  const ch = sb.channel(topic, { config: { private: false } });
  for (const [ev, fn] of Object.entries(handlers)) ch.on("broadcast", { event: ev }, (m) => fn((m && m.payload) || {}));
  ch.subscribe((status) => onStatus && onStatus(status));
  return ch;
}
function unlisten(ch) { if (ch) sb.removeChannel(ch); }

/** Phase as shown on screen: an open question shows "get ready" until its start time. */
function shownPhase(s) {
  if (s.phase === "question" && clock.now() < s.q_starts_at) return "intro";
  return s.phase;
}
