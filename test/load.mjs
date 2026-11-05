// Load test against the real Supabase project: simulates many phones in one game.
// Each simulated phone has its own Realtime connection, joins, answers and fetches
// its results like the real page does. Prints latency percentiles at the end.
//
//   TEST_HOST_EMAIL=... TEST_HOST_PASSWORD=... PLAYERS=150 node test/load.mjs
//
// The Supabase Free plan allows 200 concurrent Realtime connections in total, so keep
// PLAYERS under ~190 there (and don't run it during a live event).
import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const N = Number(process.env.PLAYERS || 100);
const email = process.env.TEST_HOST_EMAIL || env.TEST_HOST_EMAIL, password = process.env.TEST_HOST_PASSWORD || env.TEST_HOST_PASSWORD;
if (!email || !password) { console.error("Set TEST_HOST_EMAIL and TEST_HOST_PASSWORD (a confirmed organiser account)."); process.exit(1); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const stats = {};
const rec = (k, ms) => (stats[k] = stats[k] || []).push(ms);
const errs = {};
const err = (k, e) => { const m = k + ": " + (e && e.message || e); errs[m] = (errs[m] || 0) + 1; };
async function timed(k, fn) {
  const t = Date.now();
  try { const r = await fn(); rec(k, Date.now() - t); return r; } catch (e) { err(k, e); return null; }
}
const rpcOf = (sb) => async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(error.message); if (data && data.error) throw new Error(data.error); return data; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const host = mk();
const hrpc = rpcOf(host);
const login = await host.auth.signInWithPassword({ email, password });
if (login.error) { console.error("Sign-in failed:", login.error.message); process.exit(1); }

const quiz = { title: `Load test ${N}`, questions: [
  { type: "quiz", text: "Load Q1", options: ["A", "B", "C", "D"], correct: 1, time: 15 },
  { type: "poll", text: "Load poll", options: ["A", "B", "C"], time: 10 },
  { type: "type", answer: "Eventpadi", time: 15 },
  { type: "raffle", text: "Prize", winners: 3 }
] };
const g = await hrpc("create_game", { p_quiz: quiz });
const H = { p_game: g.game_id, p_token: g.host_token };
console.log(`Game ${g.pin} created. Connecting ${N} phones…`);

// ---- Phones connect and join ----
const players = [];
let subscribed = 0, subFailed = 0;
const t0 = Date.now();
for (let i = 0; i < N; i += 25) {
  await Promise.all(Array.from({ length: Math.min(25, N - i) }, async (_, k) => {
    const sb = mk(), rpc = rpcOf(sb), me = { sb, rpc, seen: {} };
    await timed("check_pin", () => rpc("check_pin", { p_pin: g.pin }));
    const j = await timed("join_game", () => rpc("join_game", { p_game: g.game_id, p_name: `P${i + k}` }));
    if (!j) return;
    Object.assign(me, j);
    await new Promise((res) => {
      const ch = sb.channel("game:" + g.game_id, { config: { private: false } });
      ch.on("broadcast", { event: "state" }, (m) => {
        const key = m.payload.phase + ":" + m.payload.qi;
        if (!me.seen[key]) me.seen[key] = Date.now();
      });
      const to = setTimeout(() => { subFailed++; res(); }, 15000);
      ch.subscribe((s) => { if (s === "SUBSCRIBED") { clearTimeout(to); subscribed++; res(); } else if (s === "CHANNEL_ERROR") { clearTimeout(to); subFailed++; res(); } });
    });
    players.push(me);
  }));
}
console.log(`${players.length} joined, ${subscribed} live connections, ${subFailed} failed, in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Host action → how long until each phone sees the new state.
async function step(action, key) {
  const t = Date.now();
  await timed("host_action", () => hrpc("host_action", { ...H, p_action: action, p_arg: {} }));
  await waitAll(key, t);
}
async function waitAll(key, since, label = "broadcast") {
  const end = Date.now() + 10000;
  while (Date.now() < end && players.some((p) => !p.seen[key])) await wait(50);
  const got = players.filter((p) => p.seen[key]);
  got.forEach((p) => rec(label, p.seen[key] - since));
  if (got.length < players.length) err("broadcast", `${players.length - got.length} phones missed ${key}`);
}
// Reveal → every phone fetches its personal result (spread over 0.9 s, like the page).
const fetchResults = () => Promise.all(players.map(async (p) => { await wait(Math.random() * 900); await timed("player_view", () => p.rpc("player_view", { p_player: p.player_id, p_token: p.token })); }));
async function answerAll(qi, fn) {
  const st = await hrpc("host_view", H);
  await wait(Math.max(0, st.q_starts_at - st.server_now) + 100);
  const t = Date.now();
  await Promise.all(players.map(async (p) => { await wait(Math.random() * 3000); await timed(fn === "text" ? "submit_text" : "submit_answer", () => fn === "text"
    ? p.rpc("submit_text", { p_player: p.player_id, p_token: p.token, p_qi: qi, p_text: "eventpadi" })
    : p.rpc("submit_answer", { p_player: p.player_id, p_token: p.token, p_qi: qi, p_choice: Math.floor(Math.random() * 3) })); }));
  await waitAll("reveal:" + qi, t, "auto_reveal");   // the last answer closes the round (incl. ~3 s of answering)
}

await step("start", "question:0");
await answerAll(0, "choice"); await fetchResults();
await step("next", "leaderboard:0"); await fetchResults();
await step("next", "question:1");
await answerAll(1, "choice"); await fetchResults();
await step("next", "question:2");
await answerAll(2, "text"); await fetchResults();
await step("next", "leaderboard:2");
await step("next", "question:3");
await timed("host_action", () => hrpc("host_action", { ...H, p_action: "reveal", p_arg: {} }));
await fetchResults();
await step("next", "podium:3"); await fetchResults();
const hv = await hrpc("host_view", H);

// ---- Clean up ----
await hrpc("host_action", { ...H, p_action: "end", p_arg: {} });
await hrpc("forget_game", { p_game: g.game_id }).catch(() => {});
await Promise.all(players.map((p) => p.sb.removeAllChannels()));

console.log(`\nPodium: ${hv.results.slice(0, 3).map((r) => `${r.name} ${r.score}`).join(", ")}; ${hv.raffles[0].winners.length} raffle winners`);
console.log("\nCall            count    p50    p95    max  (ms)");
for (const [k, a] of Object.entries(stats)) {
  console.log(`${k.padEnd(14)} ${String(a.length).padStart(6)} ${String(pct(a, 50)).padStart(6)} ${String(pct(a, 95)).padStart(6)} ${String(Math.max(...a)).padStart(6)}`);
}
const errList = Object.entries(errs);
console.log(errList.length ? "\nErrors:\n" + errList.map(([m, n]) => `  ${n}× ${m}`).join("\n") : "\nNo errors.");
process.exit(errList.length ? 1 : 0);
