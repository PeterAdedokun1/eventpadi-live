// End-to-end test against the deployed Supabase project (reads .env.local).
//   node test/live.mjs
import fs from "fs";
import assert from "assert/strict";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(fn + ": " + error.message); return data; };

function listen(topic) {
  const got = [];
  const ch = sb.channel(topic, { config: { private: false } });
  ch.on("broadcast", { event: "*" }, (m) => got.push(m));
  const ready = new Promise((res, rej) => ch.subscribe((s) => { if (s === "SUBSCRIBED") res(); if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") rej(new Error(topic + " " + s)); }));
  return { got, ready, ch, until: async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = got.find(pred); if (m) return m; await wait(50); }
    throw new Error(`No matching broadcast on ${topic}; got ${JSON.stringify(got.map((m) => [m.event, m.payload && m.payload.phase]))}`);
  } };
}

let ok = false;
try {
  // Locked down: anon can't read tables or call internal functions
  const t = await sb.from("games").select("*");
  assert.ok(t.error || t.data.length === 0, "anon must not read games");
  const internal = await sb.rpc("_reveal", { p_game: "00000000-0000-0000-0000-000000000000" });
  assert.ok(internal.error, "anon must not call internal functions");

  const quiz = { title: "Live test", event: "Smoke", questions: [
    { type: "quiz", text: "2+2?", options: ["3", "4"], correct: 1, time: 5 },
    { type: "poll", text: "Fav?", options: ["A", "B", "C"], time: 5 }
  ] };
  // Only signed-in organisers can open a game.
  assert.ok((await sb.rpc("create_game", { p_quiz: quiz })).error, "anon must not create games");
  const email = process.env.TEST_HOST_EMAIL || env.TEST_HOST_EMAIL, password = process.env.TEST_HOST_PASSWORD || env.TEST_HOST_PASSWORD;
  assert.ok(email && password, "Set TEST_HOST_EMAIL and TEST_HOST_PASSWORD (a confirmed organiser account)");
  const hostSb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const login = await hostSb.auth.signInWithPassword({ email, password });
  assert.ok(!login.error, "sign in: " + (login.error && login.error.message));
  const hrpc = async (fn, args) => { const { data, error } = await hostSb.rpc(fn, args); if (error) throw new Error(fn + ": " + error.message); return data; };
  const saved = await hrpc("save_quiz", { p_id: null, p_quiz: quiz });
  const g = await hrpc("create_game", { p_quiz: quiz, p_quiz_id: saved.id });  assert.ok(g.pin, JSON.stringify(g));
  const H = { p_game: g.game_id, p_token: g.host_token };

  const game = listen("game:" + g.game_id), host = listen("host:" + g.host_token);
  await Promise.all([game.ready, host.ready]);

  const c = await rpc("check_pin", { p_pin: g.pin });
  const a = await rpc("join_game", { p_game: c.game_id, p_name: "Ada" });
  const b = await rpc("join_game", { p_game: c.game_id, p_name: "Bola" });
  await host.until((m) => m.event === "players");

  await rpc("host_action", { ...H, p_action: "start" });
  const q = await game.until((m) => m.event === "state" && m.payload.phase === "question");
  assert.equal(q.payload.question.correct, null, "correct must not be broadcast during the question");
  await wait(Math.max(0, q.payload.q_starts_at - q.payload.server_now) + 300);

  assert.ok((await rpc("submit_answer", { p_player: a.player_id, p_token: a.token, p_qi: 0, p_choice: 1 })).ok);
  await host.until((m) => m.event === "answered" && m.payload.answered === 1);
  assert.ok((await rpc("submit_answer", { p_player: b.player_id, p_token: b.token, p_qi: 0, p_choice: 0 })).ok);
  await game.until((m) => m.event === "state" && m.payload.phase === "reveal");

  const va = await rpc("player_view", { p_player: a.player_id, p_token: a.token });
  assert.equal(va.result.correct, true);
  assert.equal(va.me.rank, 1);
  const hv = await rpc("host_view", H);
  assert.deepEqual(hv.counts, [1, 1]);

  await rpc("host_action", { ...H, p_action: "next" }); // leaderboard
  await rpc("host_action", { ...H, p_action: "next" }); // poll
  await game.until((m) => m.event === "state" && m.payload.phase === "question" && m.payload.qi === 1);
  await rpc("host_action", { ...H, p_action: "reveal" });
  await rpc("host_action", { ...H, p_action: "next" }); // podium
  await game.until((m) => m.event === "state" && m.payload.phase === "podium");
  const pod = await rpc("host_view", H);
  assert.equal(pod.results[0].name, "Ada");

  await rpc("host_action", { ...H, p_action: "end" });
  await game.until((m) => m.event === "state" && m.payload.phase === "ended");
  sb.removeAllChannels();

  // Organiser history and report; then tidy up the test data.
  const mine = await hrpc("my_games", { p_limit: 5 });
  assert.equal(mine.games[0].id, g.game_id);
  const rep = await hrpc("game_report", { p_game: g.game_id });
  assert.equal(rep.players[0].name, "Ada");
  assert.equal(rep.rounds.length, 2);
  assert.ok((await sb.rpc("game_report", { p_game: g.game_id })).error, "anon must not read reports");
  await hrpc("forget_game", { p_game: g.game_id });
  await hrpc("delete_quiz", { p_id: saved.id });
  ok = true;
  console.log("LIVE TEST PASSED");
} catch (e) {
  console.error("LIVE TEST FAILED:", e.message);
} finally {
  process.exit(ok ? 0 : 1);
}
