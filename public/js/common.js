"use strict";
/* Shared helpers for host.js and play.js: Supabase client, clock sync, realtime, UI bits. */
const LETTERS = ["A", "B", "C", "D"];
const COLORS = ["bg-a", "bg-b", "bg-c", "bg-d"];
const MARK = "/assets/mark.png";
const CFG = window.EP_CONFIG || {};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

const store = {
  get(key, area = localStorage) { try { return JSON.parse(area.getItem(key)); } catch { return null; } },
  set(key, val, area = localStorage) { try { area.setItem(key, JSON.stringify(val)); } catch { /* storage full or blocked */ } },
  del(key, area = localStorage) { try { area.removeItem(key); } catch { /* ignore */ } }
};

let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
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
const sb = window.supabase.createClient(CFG.supabaseUrl || "http://invalid.local", CFG.supabaseAnonKey || "missing", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
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
