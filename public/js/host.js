"use strict";
/* Host / projector screen: game editor (saved to the organiser's account) and the
   live game. Once a lobby is open the database is the source of truth. Realtime
   broadcasts tell us when to re-read host_view(); deadlines come from the server clock.
   Sign-in, dashboard and reports live in dashboard.js. */

const TIMES = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const K = { draft: "ep-live:draft-v2", session: "ep-live:host-session" };
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));

const uid = () => Math.random().toString(36).slice(2, 10);
const TYPE_TIMES = TIMES.filter((t) => t >= 10);
const WINNERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const blankQ = (type = "quiz") => ({
  type,
  text: type === "type" ? "Type the word on the big screen" : "",
  options: ["", "", "", ""],
  correct: type === "quiz" ? 0 : null,
  time: type === "type" ? 30 : 20,
  answer: "",
  winners: 1
});

function normaliseQuiz(raw) {
  const qs = Array.isArray(raw && raw.questions) ? raw.questions : [];
  return {
    id: raw && isUuid(raw.id) ? raw.id : null,   // id of the saved game in the account, once saved
    event: String((raw && raw.event) || ""),
    title: String((raw && raw.title) || "Untitled game"),
    questions: (qs.length ? qs : [blankQ()]).slice(0, 100).map((x) => {
      const options = (Array.isArray(x.options) ? x.options : []).slice(0, 4).map(String);
      while (options.length < 4) options.push("");
      const type = ROUND[x.type] ? x.type : "quiz";
      return {
        type,
        text: String(x.text || ""),
        options,
        correct: type === "quiz" ? (Number.isInteger(x.correct) && x.correct < 4 ? x.correct : 0) : null,
        time: (type === "type" ? TYPE_TIMES : TIMES).includes(Number(x.time)) ? Number(x.time) : type === "type" ? 30 : 20,
        answer: String(x.answer || ""),
        winners: WINNERS.includes(Number(x.winners)) ? Number(x.winners) : 1
      };
    })
  };
}

/* One line describing a round, for the editor list. */
function roundMeta(x) {
  if (x.type === "raffle") return `Raffle · ${x.winners} winner${x.winners === 1 ? "" : "s"}`;
  return `${roundLabel(x.type)} · ${x.time}s`;
}
function roundTitle(x) {
  if (x.type === "raffle") return x.text ? "Prize: " + x.text : "Untitled raffle";
  if (x.type === "type") return x.answer ? `Type "${x.answer}"` : "No word yet";
  return x.text || "Untitled question";
}

const H = {
  user: null,
  authReady: false,
  auth: { mode: "signin", email: "", msg: "", ok: false, busy: false },
  view: "home",            // auth | reset | home | edit | report (when no game is running)
  quizzes: null,           // my saved games (dashboard)
  games: null,             // games I've hosted (live + past)
  report: null,
  homeErr: "",
  search: "",
  quiz: null,              // game being edited
  editIdx: 0,
  save: "saved",           // saved | saving | unsaved | error
  game: null,              // latest host_view()
  session: store.get(K.session), // { game_id, pin, host_token }
  err: "",
  busy: false,
  connected: false,
  timers: [],
  revealAsked: -1,
  gameCh: null,
  hostCh: null
};

const joinBase = () => (CFG.publicUrl || location.origin).replace(/\/+$/, "");

/* ---------- Saving: local copy at once, account copy shortly after ---------- */
let saveTimer = null, saving = null;
function saveDraft() {
  store.set(K.draft, H.quiz);
  H.save = "unsaved";
  setSaveLabel();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(cloudSave, 700);
}
async function cloudSave() {
  clearTimeout(saveTimer);
  if (!H.quiz || !H.user) return true;
  if (saving) { await saving; if (H.save !== "unsaved") return H.save === "saved"; }
  const q = H.quiz;
  const body = JSON.parse(JSON.stringify(q));
  H.save = "saving"; setSaveLabel();
  saving = rpc("save_quiz", { p_id: q.id, p_quiz: body });
  const r = await saving;
  saving = null;
  if (r.error) { H.save = "error"; setSaveLabel(); return false; }
  if (!q.id) q.id = r.id;
  // Only mark saved if nothing changed while the request was in flight.
  if (JSON.stringify({ ...H.quiz, id: null }) === JSON.stringify({ ...body, id: null })) { H.save = "saved"; store.del(K.draft); }
  else { H.save = "unsaved"; saveTimer = setTimeout(cloudSave, 300); }
  setSaveLabel();
  return true;
}
const SAVE_TEXT = { saved: "All changes saved", saving: "Saving…", unsaved: "Saving…", error: "Couldn't save. Retrying when you edit again" };
function setSaveLabel() { const el = $("savestate"); if (el) { el.textContent = SAVE_TEXT[H.save]; el.className = "save-state " + H.save; } }
window.addEventListener("beforeunload", (e) => { if (H.quiz && H.save !== "saved" && H.view === "edit") { e.preventDefault(); e.returnValue = ""; } });

function editQuiz(q, idx = 0) {
  H.quiz = normaliseQuiz(q);
  H.editIdx = idx; H.err = ""; H.view = "edit"; H.save = H.quiz.id ? "saved" : "unsaved";
  render();
  if (!H.quiz.id) cloudSave();
}
async function leaveEditor() {
  if (H.quiz && H.save !== "saved") await cloudSave();
  H.view = "home"; H.quiz = null; render(); loadHome();
}

/* ---------- Rendering ---------- */
function clearTimers() { H.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); H.timers = []; }

function render() {
  clearTimers();
  const g = H.game;
  let body;
  const ph = g ? shownPhase(g) : null;
  if (!g) {
    if (!H.authReady) body = `<div class="center-load"><div class="spinner" aria-hidden="true"></div></div>`;
    else if (!H.user && H.view !== "reset") body = authView();
    else body = ({ reset: resetView, home: homeView, edit: setupView, report: reportView }[H.view === "edit" && !H.quiz ? "home" : H.view] || homeView)();
  }
  else body = { lobby: lobbyView, intro: introView, question: questionView, reveal: revealView, leaderboard: boardView, podium: podiumView }[ph]();
  const bare = !g && (!H.user || H.view === "reset");
  document.body.classList.toggle("auth-page", bare && H.authReady);
  $("host").innerHTML = (bare ? "" : topBar()) + `<div class="host-body ${g ? "in-game" : "view-" + H.view}">${body}</div>`;

  if (!g) return;
  if (ph === "intro") {
    const ms = Math.max(0, g.q_starts_at - clock.now());
    const f = $("host").querySelector(".bar-fill");
    if (f) { f.style.animationDuration = Math.max(0.1, ms / 1000) + "s"; requestAnimationFrame(() => f.classList.add("run")); }
    H.timers.push(setTimeout(render, ms + 20));
  }
  if (ph === "question") { startTimer(); if (g.question.type === "raffle") startSpin(); }
  if (ph === "reveal") requestAnimationFrame(() => $("host").querySelectorAll(".bar").forEach((b) => (b.style.height = b.dataset.h)));
}

function topBar() {
  const g = H.game;
  const live = !H.session || H.connected;
  const conn = `<span class="conn ${live ? "" : "off"}" id="conn">${live ? "Connected" : "Reconnecting…"}</span>`;
  const right = g
    ? `<span class="chip accent">PIN ${esc(g.pin)}</span>
       <span class="chip">${g.player_count} player${g.player_count === 1 ? "" : "s"}</span>
       ${g.phase === "podium" ? "" : `<button class="btn small ghost" data-act="lock">${g.locked ? "Unlock joining" : "Lock joining"}</button>`}
       <button class="btn small ghost" data-act="fullscreen">Full screen</button>
       <button class="btn small ghost danger" data-act="end">End game</button>`
    : `<span class="user-chip" title="${esc(H.user && H.user.email)}"><span class="avatar" aria-hidden="true">${esc(((firstName(H.user) || (H.user && H.user.email) || "?")[0] || "?").toUpperCase())}</span><span class="user-email">${esc(H.user && H.user.email)}</span></span>
       <button class="btn small ghost" data-act="signout">Sign out</button>`;
  return `<header class="host-top">
    <div class="brand"><button class="brand-home" data-act="home" aria-label="My games"><img class="brand-logo" src="/assets/logo.png" alt="eventpadi"></button><span class="live-pill">LIVE</span>${g ? conn : ""}</div>
    <div class="toolbar">${right}</div>
  </header>`;
}

function setupView() {
  const qz = H.quiz, qs = qz.questions;
  if (H.editIdx >= qs.length) H.editIdx = qs.length - 1;
  const cur = qs[H.editIdx];
  const list = qs.map((x, i) => `
    <button class="qitem t-${x.type}" data-act="pick" data-i="${i}" aria-current="${i === H.editIdx}">
      <span class="qnum">${i + 1}</span>
      <span class="qmeta">${esc(roundMeta(x))}</span>
      <span class="qtext" id="qtext-${i}">${esc(roundTitle(x))}</span>
    </button>`).join("");
  return `
    <div class="editor-head">
      <button class="btn ghost" data-act="home">← My games</button>
      <span class="save-state ${H.save}" id="savestate" role="status">${SAVE_TEXT[H.save]}</span>
      <div class="row">
        <button class="btn small ghost" data-act="export">Export JSON</button>
        <button class="btn primary big" data-act="open" ${H.busy ? "disabled" : ""}>${H.busy ? "Opening…" : "Host this game →"}</button>
      </div>
    </div>
    ${H.err ? `<div class="err-box" role="alert">${esc(H.err)}</div>` : ""}
    <div class="card event-fields">
      <div class="field"><label for="ev">Event</label><input class="input" id="ev" data-meta="event" maxlength="80" value="${esc(qz.event)}" placeholder="e.g. Lagos Tech Summit"></div>
      <div class="field"><label for="qt">Game title</label><input class="input" id="qt" data-meta="title" maxlength="80" value="${esc(qz.title)}" placeholder="e.g. Morning icebreaker"></div>
    </div>
    <div class="editor">
      <div class="qlist">
        <div class="qlist-head"><span class="lbl">Rounds</span><span class="chip">${qs.length}</span></div>
        ${list}
        <div class="add-rounds">
          <span class="lbl">Add a round</span>
          <div class="add-grid">
            ${Object.entries(ROUND).map(([t, r]) => `<button class="btn add-q t-${t}" data-act="add" data-type="${t}" ${qs.length >= 100 ? "disabled" : ""}><span class="add-ico" aria-hidden="true">${r.icon}</span>${r.label}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="card form">
        <div class="row spread">
          <span class="chip accent">Round ${H.editIdx + 1} of ${qs.length}</span>
          <div class="row" style="gap:6px">
            <button class="btn small ghost" data-act="up" ${H.editIdx === 0 ? "disabled" : ""} aria-label="Move round up">↑</button>
            <button class="btn small ghost" data-act="down" ${H.editIdx === qs.length - 1 ? "disabled" : ""} aria-label="Move round down">↓</button>
            <button class="btn small ghost" data-act="dup">Duplicate</button>
            <button class="btn small ghost danger" data-act="del" ${qs.length < 2 ? "disabled" : ""}>Delete</button>
          </div>
        </div>
        <div class="type-tabs" role="radiogroup" aria-label="Round type">
          ${Object.entries(ROUND).map(([t, r]) => `<button class="type-tab t-${t}" role="radio" aria-checked="${cur.type === t}" data-act="settype" data-type="${t}"><span aria-hidden="true">${r.icon}</span>${r.label}</button>`).join("")}
        </div>
        ${roundForm(cur)}
      </div>
    </div>`;
}

function roundForm(cur) {
  const timeSel = (list) => `<div class="field"><label for="qtime">Time limit</label>
    <select class="input" id="qtime" data-field="time">${list.map((t) => `<option value="${t}" ${cur.time === t ? "selected" : ""}>${t} seconds</option>`).join("")}</select></div>`;

  if (cur.type === "type") {
    return `
      <p class="type-help">Players type the word or phrase shown on the big screen. The fastest correct answer scores the most. Spelling counts; capitals, spaces and punctuation don't.</p>
      <div class="field"><label for="answerin">Word or phrase to type</label><input class="input big-q" id="answerin" data-field="answer" maxlength="40" value="${esc(cur.answer)}" placeholder="e.g. Jollof" autocomplete="off"></div>
      <div class="form-row">
        <div class="field"><label for="qtextin">Instruction on phones</label><input class="input" id="qtextin" data-field="text" maxlength="200" value="${esc(cur.text)}" placeholder="Type the word on the big screen"></div>
        ${timeSel(TYPE_TIMES)}
      </div>`;
  }
  if (cur.type === "raffle") {
    return `
      <p class="type-help">Draws random winners from everyone who joined. Earlier raffle winners go to the back of the queue, and you can redraw anyone who isn't in the room.</p>
      <div class="field"><label for="qtextin">Prize</label><input class="input big-q" id="qtextin" data-field="text" maxlength="200" value="${esc(cur.text)}" placeholder="e.g. Branded hoodie"></div>
      <div class="form-row">
        <div class="field"><label for="qwinners">Number of winners</label>
          <select class="input" id="qwinners" data-field="winners">${WINNERS.map((n) => `<option value="${n}" ${cur.winners === n ? "selected" : ""}>${n} winner${n === 1 ? "" : "s"}</option>`).join("")}</select></div>
        <div></div>
      </div>`;
  }
  const opts = cur.options.map((o, i) => `
    <div class="opt">
      <span class="letter ${COLORS[i]}">${LETTERS[i]}</span>
      <input type="text" id="opt-${i}" data-opt="${i}" value="${esc(o)}" maxlength="80" placeholder="${i < 2 ? "Answer " + LETTERS[i] : "Optional"}" aria-label="Answer ${LETTERS[i]}">
      ${cur.type === "quiz" ? `<input type="radio" name="correct" data-correct="${i}" ${cur.correct === i ? "checked" : ""} aria-label="Mark ${LETTERS[i]} correct">` : "<span></span>"}
    </div>`).join("");
  return `
    <div class="field"><label for="qtextin">Question</label><input class="input big-q" id="qtextin" data-field="text" maxlength="200" value="${esc(cur.text)}" placeholder="Type your question"></div>
    <div class="form-row">${timeSel(TIMES)}<div></div></div>
    <div class="field"><span class="lbl">${cur.type === "quiz" ? "Answers · tick the correct one · C and D are optional" : "Poll options · C and D are optional"}</span><div class="opts">${opts}</div></div>`;
}

function qrSvg(text) {
  try {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: "QR code to join the game" });
  } catch { return ""; }
}

function lobbyView() {
  const g = H.game;
  const players = g.players || [];
  const chips = players.length
    ? players.map((p) => `<button class="player-chip kick" data-act="kick" data-id="${esc(p.id)}" data-name="${esc(p.name)}" title="Remove ${esc(p.name)}">${esc(p.name)}</button>`).join("")
    : `<div class="empty">Waiting for attendees to join…</div>`;
  return `
    <div class="join-bar live">
      <div><div class="lbl">Join on your phone at</div><div class="join-url">${esc(joinBase().replace(/^https?:\/\//, ""))}</div><div class="lbl" style="margin-top:6px">or scan the QR code</div></div>
      <div><div class="lbl">Game PIN</div><div class="pin">${esc(g.pin.slice(0, 3))} ${esc(g.pin.slice(3))}</div></div>
      <div class="qr">${qrSvg(`${joinBase()}/?pin=${g.pin}`)}</div>
    </div>
    <div class="row spread">
      <div><h2>${esc(g.title)}</h2><div class="note">${esc(g.event)}${g.event ? " · " : ""}${g.total} round${g.total === 1 ? "" : "s"}${g.locked ? " · Joining is locked" : ""}</div></div>
      <div class="row">
        <span class="chip" aria-live="polite">${g.player_count} joined</span>
        <button class="btn ghost" data-act="back">Edit game</button>
        <button class="btn primary big" data-act="start" ${g.player_count ? "" : "disabled"}>Start</button>
      </div>
    </div>
    <div class="players">${chips}</div>
    ${players.length ? `<p class="lobby-hint">Click a name to remove that player.</p>` : ""}`;
}

function introView() {
  const g = H.game, q = g.question;
  const kicker = `Round ${g.qi + 1} of ${g.total} · ${roundLabel(q.type)}`;
  let title = esc(q.text), sub = "";
  if (q.type === "type") { title = "Fastest fingers!"; sub = "Get your phones ready. Type the word that appears here, as fast as you can."; }
  if (q.type === "raffle") { title = "Raffle time!"; sub = `Prize: ${esc(q.text)}`; }
  return `<div class="intro t-${q.type}">
    <div class="kicker">${kicker}</div>
    <h2>${title}</h2>${sub ? `<p class="intro-sub">${sub}</p>` : ""}
    <div class="bar-track"><div class="bar-fill"></div></div>
  </div>`;
}

function answerTiles(reveal) {
  const q = H.game.question;
  return `<div class="answers">${q.options.map((o, i) => {
    const isQuiz = q.type === "quiz";
    const dim = reveal && isQuiz && i !== q.correct;
    const tick = reveal && isQuiz && i === q.correct ? `<span class="tick" aria-label="Correct">✓</span>` : "";
    return `<div class="ans ${COLORS[i]} ${dim ? "dim" : ""}"><span class="letter">${LETTERS[i]}</span>${esc(o)}${tick}</div>`;
  }).join("")}</div>`;
}

const RING = 2 * Math.PI * 46;
const timerRing = (g) => `<div class="timer"><svg width="104" height="104" viewBox="0 0 104 104"><circle cx="52" cy="52" r="46" fill="none" stroke="var(--accent-100)" stroke-width="8"/><circle id="ring" cx="52" cy="52" r="46" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><span id="secs">${g.question.time}</span></div>`;

function questionView() {
  const g = H.game, q = g.question;
  if (q.type === "raffle") {
    return `
      <div class="qhead"><span class="chip">${g.qi + 1} / ${g.total} · Raffle</span><button class="btn ghost" data-act="reveal">Draw now</button></div>
      <div class="raffle-stage">
        <div class="kicker">Drawing ${q.winners > 1 ? q.winners + " winners" : "a winner"} for</div>
        <div class="raffle-prize">${esc(q.text)}</div>
        <div class="spinner-box" aria-live="off"><span id="spin-name">…</span></div>
        <div class="note">${g.player_count} player${g.player_count === 1 ? "" : "s"} in the draw</div>
      </div>`;
  }
  if (q.type === "type") {
    return `
      <div class="qhead"><span class="chip">${g.qi + 1} / ${g.total} · Fastest fingers</span><button class="btn ghost" data-act="reveal">End round</button></div>
      <div class="kicker center-text">Type this on your phone</div>
      <div class="word-display" style="--len:${Math.max(4, (g.word || "").length)}">${esc(g.word || "")}</div>
      <div class="qmid">
        ${timerRing(g)}
        <div class="sponsor">${esc(g.event)}</div>
        <div class="stat"><b id="answered">${g.answered}</b><span>of <span id="pcount">${g.player_count}</span> typed it</span></div>
      </div>`;
  }
  return `
    <div class="qhead"><span class="chip">${g.qi + 1} / ${g.total}${q.type === "poll" ? " · Poll" : ""}</span><button class="btn ghost" data-act="reveal">End question</button></div>
    <div class="qtitle">${esc(q.text)}</div>
    <div class="qmid">
      ${timerRing(g)}
      <div class="sponsor">${esc(g.event)}</div>
      <div class="stat"><b id="answered">${g.answered}</b><span>of <span id="pcount">${g.player_count}</span> answered</span></div>
    </div>
    ${answerTiles(false)}`;
}

function startTimer() {
  const g = H.game;
  const total = g.q_ends_at - g.q_starts_at;
  const step = () => {
    const left = Math.max(0, g.q_ends_at - clock.now());
    const secs = $("secs"), ring = $("ring");
    if (secs) secs.textContent = Math.ceil(left / 1000);
    if (ring) ring.setAttribute("stroke-dashoffset", String(RING * (1 - left / total)));
    // Time is up: ask the database to close the round (it ignores repeats).
    if (left <= 0 && clock.now() > g.q_ends_at + 400 && H.revealAsked !== g.qi) {
      H.revealAsked = g.qi;
      act("reveal");
    }
  };
  step();
  H.timers.push(setInterval(step, 100));
}

/* Raffle: flick through names, slowing down as the draw time runs out. */
function startSpin() {
  const g = H.game;
  const pool = g.pool && g.pool.length ? g.pool : ["…"];
  const total = Math.max(1, g.q_ends_at - g.q_starts_at);
  let i = Math.floor(Math.random() * pool.length);
  const tick = () => {
    const el = $("spin-name");
    if (!el) return;
    i = (i + 1 + Math.floor(Math.random() * Math.min(3, pool.length))) % pool.length;
    el.textContent = pool[i];
    el.classList.remove("flick"); void el.offsetWidth; el.classList.add("flick");
    const done = Math.min(1, Math.max(0, (clock.now() - g.q_starts_at) / total));
    if (done < 1) H.timers.push(setTimeout(tick, 55 + done * done * 420));
  };
  tick();
}

function nextLabel(g) {
  if (g.phase === "reveal" && ["quiz", "type"].includes(g.question.type)) return "Scoreboard";
  return g.is_last ? "Final results" : "Next round";
}

const fmtSecs = (ms) => (ms / 1000).toFixed(2) + "s";

function revealView() {
  const g = H.game, q = g.question;
  const head = (info) => `<div class="row spread"><span class="chip">${g.qi + 1} / ${g.total} · ${info}</span><button class="btn primary big" data-act="next">${nextLabel(g)}</button></div>`;

  if (q.type === "raffle") {
    const ws = g.winner_list || [];
    const cards = ws.length
      ? ws.map((w, i) => `<div class="winner-card" style="animation-delay:${i * 0.15}s">
          <span class="winner-place">${ws.length > 1 ? ordinal(w.place) : "Winner"}</span>
          <span class="winner-name">${esc(w.name)}</span>
          ${g.can_redraw ? `<button class="btn small ghost redraw" data-act="redraw" data-id="${esc(w.id)}" data-name="${esc(w.name)}" title="Not in the room? Draw someone else">Redraw</button>` : ""}
        </div>`).join("")
      : `<div class="empty">Nobody to draw from.</div>`;
    return `${head("Raffle")}
      <div class="raffle-stage won">
        <div class="kicker">${ws.length > 1 ? "Our winners" : "And the winner is…"}</div>
        <div class="winners ${ws.length > 3 ? "many" : ""}">${cards}</div>
        <div class="raffle-prize small">Prize: ${esc(q.text)}</div>
        <p class="prize">Please come to the help desk to collect your prize.</p>
      </div>
      <div class="confetti" aria-hidden="true">${Array.from({ length: 28 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 0.25}s;--c:${i % 4}"></i>`).join("")}</div>`;
  }

  if (q.type === "type") {
    const f = g.fastest || [];
    const rows = f.map((p, i) => `<div class="lrow ${i < 3 ? "top" : ""}"><span class="rank">${i + 1}</span><span>${esc(p.name)}</span><span class="delta"></span><span class="score">${fmtSecs(p.ms)}</span></div>`).join("");
    return `${head(`${g.answered} of ${g.player_count} typed it`)}
      <div class="kicker center-text">The word was</div>
      <div class="word-display small">${esc(q.answer || "")}</div>
      <h3 class="center-text">Fastest fingers</h3>
      <div class="board">${rows || `<div class="empty">Nobody typed it in time.</div>`}</div>`;
  }

  const counts = g.counts || q.options.map(() => 0);
  const max = Math.max(1, ...counts);
  const cols = counts.map((c, i) => {
    const dim = q.type === "quiz" && i !== q.correct;
    return `<div class="col ${dim ? "dim" : ""}"><span class="count">${c}${q.type === "quiz" && i === q.correct ? " ✓" : ""}</span><div class="bar ${COLORS[i]}" style="height:6px" data-h="${Math.max(3, (c / max) * 100) * 0.8}%"></div><b>${LETTERS[i]}</b></div>`;
  }).join("");
  return `${head(`${g.answered} of ${g.player_count} answered`)}
    <div class="qtitle">${esc(q.text)}</div>
    <div class="chart" style="grid-template-columns:repeat(${counts.length},1fr)" role="img" aria-label="Answer counts: ${counts.map((c, i) => LETTERS[i] + " " + c).join(", ")}">${cols}</div>
    ${answerTiles(true)}`;
}

function boardView() {
  const g = H.game;
  const rows = (g.leaderboard || []).map((p, i) => `
    <div class="lrow"><span class="rank">${i + 1}</span><span>${esc(p.name)}${p.streak > 1 ? `<span class="streak">${p.streak} in a row</span>` : ""}</span><span class="delta">${p.delta ? "+" + p.delta : ""}</span><span class="score">${p.score.toLocaleString()}</span></div>`).join("");
  return `
    <div class="row spread"><h2>Scoreboard</h2><button class="btn primary big" data-act="next">${nextLabel(g)}</button></div>
    <div class="board">${rows || `<div class="empty">No players</div>`}</div>`;
}

function podiumView() {
  const g = H.game, r = g.results || [], raffles = g.raffles || [];
  const step = (p, cls, n) => p ? `<div class="step ${cls}"><span class="who">${esc(p.name)}</span><span class="pts">${p.score.toLocaleString()} pts</span><div class="block">${n}</div></div>` : `<div></div>`;
  const table = r.map((p) => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td>${g.scored ? `<td>${p.score.toLocaleString()}</td><td>${p.correct} / ${p.of}</td>` : ""}<td>${esc((p.prizes || []).join(", "))}</td></tr>`).join("");
  const raffleList = raffles.length ? `
    <div class="raffle-summary">
      <h3>Raffle winners</h3>
      ${raffles.map((x) => `<div class="raffle-line"><span class="raffle-prize-name">${esc(x.prize)}</span><span>${x.winners.map(esc).join(", ")}</span></div>`).join("")}
    </div>` : "";
  return `
    <div class="row spread"><div><h2>${g.scored ? "Winners" : "That's a wrap!"}</h2><div class="note">${esc(g.title)}${g.event ? " · " + esc(g.event) : ""}</div></div>
      <div class="row"><button class="btn" data-act="csv">Download results (CSV)</button><button class="btn primary" data-act="finish">Close game</button></div></div>
    ${g.scored ? `<div class="podium">${step(r[1], "p2", 2)}${step(r[0], "p1", 1)}${step(r[2], "p3", 3)}</div>
    <p class="prize">Top 3, please come to the help desk to collect your prizes.</p>` : ""}
    ${raffleList}
    <details class="all-results"><summary>All ${r.length} players</summary>
      <table class="results"><thead><tr><th>Rank</th><th>Name</th>${g.scored ? "<th>Score</th><th>Correct</th>" : ""}<th>Prizes</th></tr></thead><tbody>${table}</tbody></table>
    </details>`;
}

/* ---------- Server ---------- */
function setSession(s) { H.session = s; s ? store.set(K.session, s) : store.del(K.session); }

function setConn(on) {
  H.connected = on;
  const c = $("conn");
  if (c) { c.className = "conn" + (on || !H.session ? "" : " off"); c.textContent = on || !H.session ? "Connected" : "Reconnecting…"; }
}

let refreshTimer = null, refreshing = false, refreshAgain = false;
function refreshSoon(ms = 120) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, ms); }

async function refresh() {
  if (!H.session) return;
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const v = await rpc("host_view", { p_game: H.session.game_id, p_token: H.session.host_token });
  refreshing = false;
  if (v.network) { setConn(false); return; }
  if (v.error) { gameOver(v.error); return; }
  if (refreshAgain) { refreshAgain = false; refreshSoon(0); }
  if (H.game && v.version < H.game.version) return;
  const changed = !H.game || v.version !== H.game.version || v.player_count !== H.game.player_count || v.answered !== H.game.answered;
  H.game = v;
  wake.on();
  if (changed) render();
}

function connect() {
  unlisten(H.gameCh); unlisten(H.hostCh);
  const s = H.session;
  H.gameCh = listen("game:" + s.game_id, {
    state: (st) => { if (!H.game || st.version > H.game.version) refreshSoon(0); }
  }, (status) => {
    const on = status === "SUBSCRIBED";
    if (on) refreshSoon(0);
    setConn(on);
  });
  H.hostCh = listen("host:" + s.host_token, {
    players: () => refreshSoon(150),
    answered: (d) => {
      if (!H.game) return;
      H.game.answered = d.answered;
      const a = $("answered");
      if (a) a.textContent = d.answered;
    }
  });
}

function gameOver(reason) {
  const g = H.game, sess = H.session;
  unlisten(H.gameCh); unlisten(H.hostCh);
  H.gameCh = H.hostCh = null;
  setSession(null);
  H.game = null;
  wake.off();
  if (reason) toast(reason);
  // A game that actually started goes straight to its report; otherwise back to the editor or dashboard.
  if (H.user && sess && g && (g.qi >= 0 || g.phase === "podium")) { openReport(sess.game_id); return; }
  if (!H.quiz && H.view === "edit") H.view = "home";
  render();
  if (H.view === "home") loadHome();
}

// Safety net: re-read state regularly, faster while the realtime connection is down.
setInterval(() => { if (H.session && !H.connected) refresh(); }, 3000);
setInterval(() => { if (H.session) refresh(); }, 15000);

async function openLobby() {
  H.err = "";
  H.busy = true;
  render();
  await cloudSave();
  const r = await rpc("create_game", { p_quiz: H.quiz, p_quiz_id: H.quiz.id });
  H.busy = false;
  if (r.auth) { await sb.auth.signOut(); return; }
  if (r.error) {
    H.err = r.error;
    if (Number.isInteger(r.index)) H.editIdx = r.index;
    render();
    return;
  }
  startHosting({ game_id: r.game_id, pin: r.pin, host_token: r.host_token });
}

async function startHosting(s) {
  if (H.view !== "edit" || !H.quiz) H.view = "home";
  setSession(s);
  connect();
  await refresh();
}

async function act(action, arg) {
  if (!H.session) return {};
  const r = await rpc("host_action", { p_game: H.session.game_id, p_token: H.session.host_token, p_action: action, p_arg: arg || {} });
  if (r.error) toast(r.error, true);
  else refreshSoon(0);
  return r;
}

/* ---------- Files ---------- */
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const slug = (s) => String(s || "quiz").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "quiz";
const csvCell = (v) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection from nicknames
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportCsv() {
  const g = H.game;
  const lines = [["Rank", "Name", "Score", "Correct answers", "Scored rounds", "Prizes won"]]
    .concat((g.results || []).map((p) => [p.rank, p.name, p.score, p.correct, p.of, (p.prizes || []).join("; ")]))
    .map((row) => row.map(csvCell).join(","));
  download(`${slug(g.title)}-results-${g.pin}.csv`, "﻿" + lines.join("\r\n"), "text/csv");
}

$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.questions)) throw new Error("bad");
    editQuiz({ ...data, id: null });
    toast(`Imported "${H.quiz.title}"`);
  } catch {
    toast("That file isn't a valid game JSON.", true);
  }
});

const findQuiz = async (id) => {
  const r = await rpc("get_quiz", { p_id: id });
  if (r.error) { toast(r.error, true); return null; }
  return r;
};

/* ---------- Events ---------- */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const a = b.dataset.act;
  const qs = H.quiz ? H.quiz.questions : [];
  const edited = () => { saveDraft(); render(); };
  switch (a) {
    /* account + dashboard */
    case "authmode": H.auth.mode = b.dataset.mode; H.auth.msg = ""; render(); ($("au-name") || $("au-email")).focus(); break;
    case "signout":
      if (H.quiz && H.save !== "saved") await cloudSave();
      await sb.auth.signOut(); H.quiz = null; break;
    case "home":
      if (H.game) break;
      if (H.view === "edit") await leaveEditor(); else { H.view = "home"; render(); loadHome(); }
      break;
    case "reloadhome": loadHome(); break;
    case "newgame": editQuiz({ title: "Untitled game", questions: [] }); if ($("qt")) $("qt").select(); break;
    case "template": {
      const t = TEMPLATES[+b.dataset.i];
      editQuiz(JSON.parse(JSON.stringify(t.quiz)));
      toast(`"${t.quiz.title}" added to My games. Edit it to make it yours.`);
      break;
    }
    case "editq": { const q = await findQuiz(b.dataset.id); if (q) editQuiz(q); break; }
    case "hostq": {
      b.disabled = true;
      const q = await findQuiz(b.dataset.id);
      if (!q) { b.disabled = false; break; }
      H.quiz = normaliseQuiz(q); H.save = "saved"; H.view = "edit"; H.editIdx = 0;
      await openLobby();
      break;
    }
    case "dupq": {
      const q = await findQuiz(b.dataset.id);
      if (!q) break;
      const r = await rpc("save_quiz", { p_id: null, p_quiz: { ...q, id: null, title: (q.title || "Untitled game") + " (copy)" } });
      if (r.error) toast(r.error, true); else { toast("Copy created"); loadHome(); }
      break;
    }
    case "delq":
      if (!(await popup({ title: "Delete this game?", message: `"${b.dataset.name || "Untitled game"}" will be removed from My games. Reports from times you hosted it are kept.`, confirmLabel: "Delete", tone: "danger" }))) return;
      await rpc("delete_quiz", { p_id: b.dataset.id }); toast("Game deleted"); loadHome(); break;
    case "resume": {
      const g = (H.games || []).find((x) => x.id === b.dataset.id);
      if (g && g.host_token) startHosting({ game_id: g.id, pin: g.pin, host_token: g.host_token });
      break;
    }
    case "endlive": {
      const g = (H.games || []).find((x) => x.id === b.dataset.id);
      if (!g || !(await popup({ title: "End this game?", message: `"${g.title}" (PIN ${g.pin}) stops for everyone in it.`, confirmLabel: "End game", tone: "danger" }))) return;
      const r = await rpc("host_action", { p_game: g.id, p_token: g.host_token, p_action: "end", p_arg: {} });
      if (r.error) toast(r.error, true); else toast("Game ended.");
      loadHome(); break;
    }
    case "report": openReport(b.dataset.id); break;
    case "forget": {
      if (!(await popup({ title: "Delete this report?", message: "The results and player list for this game will be permanently deleted.", confirmLabel: "Delete report", tone: "danger" }))) return;
      const r = await rpc("forget_game", { p_game: b.dataset.id });
      if (r.error) toast(r.error, true);
      loadHome(); break;
    }
    case "importlegacy": b.disabled = true; importLegacy(); break;
    case "dismisslegacy": store.set("ep-live:legacy-done", true); render(); break;
    case "reportcsv": exportReportCsv(); break;
    case "print": window.print(); break;

    /* editor */
    case "pick": H.editIdx = +b.dataset.i; render(); break;
    case "add": qs.push(blankQ(b.dataset.type)); H.editIdx = qs.length - 1; edited(); ($("answerin") || $("qtextin")).focus(); break;
    case "settype": {
      const cur = qs[H.editIdx], t = b.dataset.type;
      if (cur.type === t) break;
      const fresh = blankQ(t);
      if (cur.type === "type" || t === "type") cur.text = fresh.text;   // the instruction text isn't a question
      if (t === "type" && !TYPE_TIMES.includes(cur.time)) cur.time = fresh.time;
      cur.type = t; cur.correct = fresh.correct;
      edited(); break;
    }
    case "dup": qs.splice(H.editIdx + 1, 0, JSON.parse(JSON.stringify(qs[H.editIdx]))); H.editIdx++; edited(); break;
    case "del": qs.splice(H.editIdx, 1); H.editIdx = Math.max(0, H.editIdx - 1); edited(); break;
    case "up": case "down": {
      const j = H.editIdx + (a === "up" ? -1 : 1);
      [qs[H.editIdx], qs[j]] = [qs[j], qs[H.editIdx]]; H.editIdx = j; edited(); break;
    }
    case "import": $("importFile").click(); break;
    case "export": {
      const { id, ...rest } = H.quiz;
      download(`${slug(H.quiz.title)}.json`, JSON.stringify(rest, null, 2), "application/json"); break;
    }
    case "open": openLobby(); break;

    /* live game */
    case "redraw":
      if (await popup({ title: `Redraw instead of ${b.dataset.name}?`, message: "Use this if the winner isn't in the room. A new winner is drawn at random and this person loses the prize.", confirmLabel: "Redraw", tone: "danger", icon: "↻" })) act("redraw", { player_id: b.dataset.id });
      break;
    case "start": b.disabled = true; act("start"); break;
    case "next": b.disabled = true; act("next"); break;
    case "reveal": act("reveal"); break;
    case "lock": act("lock", { locked: !H.game.locked }); break;
    case "kick":
      if (await popup({ title: `Remove ${b.dataset.name}?`, message: "They'll be taken out of the game and see a message on their phone.", confirmLabel: "Remove player", tone: "danger" })) act("kick", { player_id: b.dataset.id });
      break;
    case "back":
      if (H.game.player_count && !(await popup({ title: "Go back to editing?", message: "This closes the lobby. Players will need to join again with a new PIN.", confirmLabel: "Close lobby", tone: "danger" }))) return;
      if (!(await act("end")).error) gameOver(); break;
    case "end":
      if (!(await popup({ title: "End this game?", message: "The game stops for everyone and players return to the join screen.", confirmLabel: "End game", tone: "danger" }))) return;
      if (!(await act("end")).error) gameOver("Game ended."); break;
    case "finish": if (!(await act("end")).error) gameOver(); break;
    case "csv": exportCsv(); break;
    case "fullscreen":
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => {});
      break;
  }
});

document.addEventListener("submit", (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  submitAuth(f);
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (H.game) return;
  if (t.dataset.search !== undefined) {
    H.search = t.value;
    const pos = t.selectionStart;
    render();
    const s = $("search"); if (s) { s.focus(); s.setSelectionRange(pos, pos); }
    return;
  }
  if (!H.quiz || H.view !== "edit") return;
  const cur = H.quiz.questions[H.editIdx];
  if (t.dataset.meta) H.quiz[t.dataset.meta] = t.value;
  else if (t.dataset.field === "text" || t.dataset.field === "answer") {
    cur[t.dataset.field] = t.value;
    const el = $("qtext-" + H.editIdx); if (el) el.textContent = roundTitle(cur);
  }
  else if (t.dataset.opt) cur.options[+t.dataset.opt] = t.value;
  else return;
  saveDraft();
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (H.game || !H.quiz || H.view !== "edit") return;
  const cur = H.quiz.questions[H.editIdx];
  if (t.dataset.correct) cur.correct = +t.dataset.correct;
  else if (t.dataset.field === "time" || t.dataset.field === "winners") { cur[t.dataset.field] = +t.value; render(); }
  else return;
  saveDraft();
});

// Presenter shortcuts: Space / Enter / → advances from the reveal and scoreboard screens.
document.addEventListener("keydown", (e) => {
  if (!H.game || e.target.closest("input, select, textarea, button")) return;
  if ([" ", "Enter", "ArrowRight", "PageDown"].includes(e.key) && ["reveal", "leaderboard"].includes(H.game.phase)) {
    e.preventDefault();
    act("next");
  }
  if (e.key === "Enter" && H.game.phase === "lobby" && H.game.player_count) act("start");
});

/* ---------- Start ---------- */
(function init() {
  // An unsaved local copy (e.g. the tab closed mid-edit) reopens in the editor.
  const draft = store.get(K.draft);
  if (draft && Array.isArray(draft.questions)) { H.quiz = normaliseQuiz(draft); H.view = "edit"; H.save = "unsaved"; }
  if (H.session) { connect(); refresh(); }
  render();
  initAuth();
})();
