"use strict";
/* Host / projector screen. The quiz editor is local; once a lobby is open the
   database is the source of truth. Realtime broadcasts tell us when to re-read
   host_view(); deadlines come from the server clock. */

const TIMES = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const K = { draft: "ep-live:draft", lib: "ep-live:library", session: "ep-live:host-session", key: "ep-live:host-key" };

const SAMPLE = {
  event: "Lagos Tech Summit 2026",
  title: "Morning icebreaker",
  questions: [
    { type: "quiz", text: "What does \"padi\" mean in Nigerian Pidgin?", options: ["Friend", "Boss", "Money", "Food"], correct: 0, time: 20 },
    { type: "quiz", text: "In what year did Nigeria gain independence?", options: ["1957", "1960", "1963", "1970"], correct: 1, time: 20 },
    { type: "poll", text: "Which session are you most excited about today?", options: ["Fintech panel", "AI keynote", "Startup pitches", "Networking mixer"], correct: null, time: 15 },
    { type: "quiz", text: "Which is the longest bridge in Lagos?", options: ["Eko Bridge", "Carter Bridge", "Third Mainland Bridge", "Lekki-Ikoyi Link Bridge"], correct: 2, time: 20 },
    { type: "quiz", text: "Which Nigerian artist won the Grammy for Best Global Music Album in 2021?", options: ["Wizkid", "Davido", "Tems", "Burna Boy"], correct: 3, time: 20 }
  ]
};

const uid = () => Math.random().toString(36).slice(2, 10);
const blankQ = () => ({ type: "quiz", text: "", options: ["", "", "", ""], correct: 0, time: 20 });

function normaliseQuiz(raw) {
  const qs = Array.isArray(raw && raw.questions) ? raw.questions : [];
  return {
    id: (raw && raw.id) || uid(),
    event: String((raw && raw.event) || ""),
    title: String((raw && raw.title) || "Untitled quiz"),
    questions: (qs.length ? qs : [blankQ()]).slice(0, 100).map((x) => {
      const options = (Array.isArray(x.options) ? x.options : []).slice(0, 4).map(String);
      while (options.length < 4) options.push("");
      const type = x.type === "poll" ? "poll" : "quiz";
      return {
        type,
        text: String(x.text || ""),
        options,
        correct: type === "quiz" ? (Number.isInteger(x.correct) && x.correct < 4 ? x.correct : 0) : null,
        time: TIMES.includes(Number(x.time)) ? Number(x.time) : 20
      };
    })
  };
}

const H = {
  quiz: normaliseQuiz(store.get(K.draft) || SAMPLE),
  editIdx: 0,
  view: "edit",            // edit | library (when no game is running)
  game: null,              // latest host_view()
  session: store.get(K.session), // { game_id, pin, host_token }
  hostKey: store.get(K.key, sessionStorage) || "",
  err: "",
  busy: false,
  connected: false,
  timers: [],
  revealAsked: -1,
  gameCh: null,
  hostCh: null
};

const saveDraft = () => store.set(K.draft, H.quiz);
const library = () => store.get(K.lib) || [];
const joinBase = () => (CFG.publicUrl || location.origin).replace(/\/+$/, "");

/* ---------- Rendering ---------- */
function clearTimers() { H.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); H.timers = []; }

function render() {
  clearTimers();
  const g = H.game;
  let body;
  const ph = g ? shownPhase(g) : null;
  if (!g) body = H.view === "library" ? libraryView() : setupView();
  else body = { lobby: lobbyView, intro: introView, question: questionView, reveal: revealView, leaderboard: boardView, podium: podiumView }[ph]();
  $("host").innerHTML = topBar() + `<div class="host-body">${body}</div>`;

  if (!g) return;
  if (ph === "intro") {
    const ms = Math.max(0, g.q_starts_at - clock.now());
    const f = $("host").querySelector(".bar-fill");
    if (f) { f.style.animationDuration = Math.max(0.1, ms / 1000) + "s"; requestAnimationFrame(() => f.classList.add("run")); }
    H.timers.push(setTimeout(render, ms + 20));
  }
  if (ph === "question") startTimer();
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
    : `<button class="btn small ghost" data-act="fullscreen">Full screen</button>`;
  return `<header class="host-top">
    <div class="brand"><img class="brand-logo" src="/assets/logo.png" alt="eventpadi"><span class="live-pill">LIVE</span>${conn}</div>
    <div class="toolbar">${right}</div>
  </header>`;
}

function setupView() {
  const qz = H.quiz, qs = qz.questions;
  if (H.editIdx >= qs.length) H.editIdx = qs.length - 1;
  const cur = qs[H.editIdx];
  const list = qs.map((x, i) => `
    <button class="qitem" data-act="pick" data-i="${i}" aria-current="${i === H.editIdx}">
      <span class="qnum">${i + 1}</span>
      <span class="qmeta">${x.type === "poll" ? "Poll" : "Quiz"} · ${x.time}s</span>
      <span class="qtext" id="qtext-${i}">${esc(x.text || "Untitled question")}</span>
    </button>`).join("");
  const opts = cur.options.map((o, i) => `
    <div class="opt">
      <span class="letter ${COLORS[i]}">${LETTERS[i]}</span>
      <input type="text" id="opt-${i}" data-opt="${i}" value="${esc(o)}" maxlength="80" placeholder="${i < 2 ? "Answer " + LETTERS[i] : "Optional"}" aria-label="Answer ${LETTERS[i]}">
      ${cur.type === "quiz" ? `<input type="radio" name="correct" data-correct="${i}" ${cur.correct === i ? "checked" : ""} aria-label="Mark ${LETTERS[i]} correct">` : "<span></span>"}
    </div>`).join("");
  return `
    <div class="page-head">
      <div><h1>Build your quiz</h1><p class="note">Write your questions, then open the lobby so attendees can join from their phones.</p></div>
      <div class="row" style="align-items:flex-end">
        <div class="field key-field"><label for="hostkey">Host password</label><input class="input" id="hostkey" type="password" data-hostkey value="${esc(H.hostKey)}" autocomplete="current-password" placeholder="Required to host"></div>
        <button class="btn primary big" data-act="open" ${H.busy ? "disabled" : ""}>${H.busy ? "Opening…" : "Open lobby →"}</button>
      </div>
    </div>
    <div class="toolbar">
      <button class="btn small" data-act="library">My quizzes (${library().length})</button>
      <button class="btn small" data-act="save">Save to my quizzes</button>
      <button class="btn small ghost" data-act="new">New quiz</button>
      <button class="btn small ghost" data-act="import">Import JSON</button>
      <button class="btn small ghost" data-act="export">Export JSON</button>
    </div>
    ${H.err ? `<div class="err-box" role="alert">${esc(H.err)}</div>` : ""}
    <div class="card event-fields">
      <div class="field"><label for="ev">Event</label><input class="input" id="ev" data-meta="event" maxlength="80" value="${esc(qz.event)}" placeholder="e.g. Lagos Tech Summit"></div>
      <div class="field"><label for="qt">Quiz title</label><input class="input" id="qt" data-meta="title" maxlength="80" value="${esc(qz.title)}" placeholder="e.g. Morning icebreaker"></div>
    </div>
    <div class="editor">
      <div class="qlist">
        <div class="qlist-head"><span class="lbl">Questions</span><span class="chip">${qs.length}</span></div>
        ${list}
        <button class="btn add-q" data-act="add" ${qs.length >= 100 ? "disabled" : ""}>+ Add question</button>
      </div>
      <div class="card form">
        <div class="row spread">
          <span class="chip accent">Question ${H.editIdx + 1} of ${qs.length}</span>
          <div class="row" style="gap:6px">
            <button class="btn small ghost" data-act="up" ${H.editIdx === 0 ? "disabled" : ""} aria-label="Move question up">↑</button>
            <button class="btn small ghost" data-act="down" ${H.editIdx === qs.length - 1 ? "disabled" : ""} aria-label="Move question down">↓</button>
            <button class="btn small ghost" data-act="dup">Duplicate</button>
            <button class="btn small ghost danger" data-act="del" ${qs.length < 2 ? "disabled" : ""}>Delete</button>
          </div>
        </div>
        <div class="field"><label for="qtextin">Question</label><input class="input big-q" id="qtextin" data-field="text" maxlength="200" value="${esc(cur.text)}" placeholder="Type your question"></div>
        <div class="form-row">
          <div class="field"><label for="qtype">Type</label>
            <select class="input" id="qtype" data-field="type">
              <option value="quiz" ${cur.type === "quiz" ? "selected" : ""}>Quiz (scored)</option>
              <option value="poll" ${cur.type === "poll" ? "selected" : ""}>Poll (no right answer)</option>
            </select></div>
          <div class="field"><label for="qtime">Time limit</label>
            <select class="input" id="qtime" data-field="time">
              ${TIMES.map((t) => `<option value="${t}" ${cur.time === t ? "selected" : ""}>${t} seconds</option>`).join("")}
            </select></div>
        </div>
        <div class="field"><span class="lbl">${cur.type === "quiz" ? "Answers · tick the correct one · C and D are optional" : "Poll options · C and D are optional"}</span><div class="opts">${opts}</div></div>
      </div>
    </div>`;
}

function libraryView() {
  const lib = library();
  const rows = lib.length
    ? lib.map((x) => `<div class="lib-row"><div><b>${esc(x.title)}</b><span class="note">${esc(x.event || "No event")} · ${x.questions.length} questions${x.savedAt ? " · saved " + new Date(x.savedAt).toLocaleString() : ""}</span></div>
        <div class="row"><button class="btn small primary" data-act="load" data-id="${esc(x.id)}">Open</button><button class="btn small ghost danger" data-act="libdel" data-id="${esc(x.id)}">Delete</button></div></div>`).join("")
    : `<div class="empty">No saved quizzes yet. Use "Save to my quizzes" in the editor.</div>`;
  return `
    <div class="row spread"><h2>My quizzes</h2><button class="btn ghost" data-act="editor">Back to editor</button></div>
    <p class="note">Quizzes are saved in this browser. Export them as JSON to move them to another computer.</p>
    <div class="library">${rows}</div>`;
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
      <div><h2>${esc(g.title)}</h2><div class="note">${esc(g.event)}${g.event ? " · " : ""}${g.total} questions${g.locked ? " · Joining is locked" : ""}</div></div>
      <div class="row">
        <span class="chip" aria-live="polite">${g.player_count} joined</span>
        <button class="btn ghost" data-act="back">Edit quiz</button>
        <button class="btn primary big" data-act="start" ${g.player_count ? "" : "disabled"}>Start</button>
      </div>
    </div>
    <div class="players">${chips}</div>
    ${players.length ? `<p class="lobby-hint">Click a name to remove that player.</p>` : ""}`;
}

function introView() {
  const g = H.game;
  return `<div class="intro">
    <div class="kicker">Question ${g.qi + 1} of ${g.total}${g.question.type === "poll" ? " · Poll" : ""}</div>
    <h2>${esc(g.question.text)}</h2>
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
function questionView() {
  const g = H.game;
  return `
    <div class="qhead"><span class="chip">${g.qi + 1} / ${g.total}</span><button class="btn ghost" data-act="reveal">End question</button></div>
    <div class="qtitle">${esc(g.question.text)}</div>
    <div class="qmid">
      <div class="timer"><svg width="104" height="104" viewBox="0 0 104 104"><circle cx="52" cy="52" r="46" fill="none" stroke="var(--accent-100)" stroke-width="8"/><circle id="ring" cx="52" cy="52" r="46" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><span id="secs">${g.question.time}</span></div>
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
    // Time is up: ask the database to close the question (it ignores repeats).
    if (left <= 0 && clock.now() > g.q_ends_at + 400 && H.revealAsked !== g.qi) {
      H.revealAsked = g.qi;
      act("reveal");
    }
  };
  step();
  H.timers.push(setInterval(step, 100));
}

function revealView() {
  const g = H.game, q = g.question;
  const counts = g.counts || q.options.map(() => 0);
  const max = Math.max(1, ...counts);
  const cols = counts.map((c, i) => {
    const dim = q.type === "quiz" && i !== q.correct;
    return `<div class="col ${dim ? "dim" : ""}"><span class="count">${c}${q.type === "quiz" && i === q.correct ? " ✓" : ""}</span><div class="bar ${COLORS[i]}" style="height:6px" data-h="${Math.max(3, (c / max) * 100) * 0.8}%"></div><b>${LETTERS[i]}</b></div>`;
  }).join("");
  const nextLabel = q.type === "poll" ? (g.is_last ? "Final results" : "Next question") : "Scoreboard";
  return `
    <div class="row spread"><span class="chip">${g.qi + 1} / ${g.total} · ${g.answered} of ${g.player_count} answered</span><button class="btn primary big" data-act="next">${nextLabel}</button></div>
    <div class="qtitle">${esc(q.text)}</div>
    <div class="chart" style="grid-template-columns:repeat(${counts.length},1fr)" role="img" aria-label="Answer counts: ${counts.map((c, i) => LETTERS[i] + " " + c).join(", ")}">${cols}</div>
    ${answerTiles(true)}`;
}

function boardView() {
  const g = H.game;
  const rows = (g.leaderboard || []).map((p, i) => `
    <div class="lrow"><span class="rank">${i + 1}</span><span>${esc(p.name)}${p.streak > 1 ? `<span class="streak">${p.streak} in a row</span>` : ""}</span><span class="delta">${p.delta ? "+" + p.delta : ""}</span><span class="score">${p.score.toLocaleString()}</span></div>`).join("");
  return `
    <div class="row spread"><h2>Scoreboard</h2><button class="btn primary big" data-act="next">${g.is_last ? "Final results" : "Next question"}</button></div>
    <div class="board">${rows || `<div class="empty">No players</div>`}</div>`;
}

function podiumView() {
  const g = H.game, r = g.results || [];
  const step = (p, cls, n) => p ? `<div class="step ${cls}"><span class="who">${esc(p.name)}</span><span class="pts">${p.score.toLocaleString()} pts</span><div class="block">${n}</div></div>` : `<div></div>`;
  const table = r.map((p) => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td><td>${p.score.toLocaleString()}</td><td>${p.correct} / ${p.of}</td></tr>`).join("");
  return `
    <div class="row spread"><div><h2>Winners</h2><div class="note">${esc(g.title)}${g.event ? " · " + esc(g.event) : ""}</div></div>
      <div class="row"><button class="btn" data-act="csv">Download results (CSV)</button><button class="btn primary" data-act="finish">Close game</button></div></div>
    <div class="podium">${step(r[1], "p2", 2)}${step(r[0], "p1", 1)}${step(r[2], "p3", 3)}</div>
    <p class="prize">Top 3, please come to the help desk to collect your prizes.</p>
    <details class="all-results"><summary>All ${r.length} players</summary>
      <table class="results"><thead><tr><th>Rank</th><th>Name</th><th>Score</th><th>Correct</th></tr></thead><tbody>${table}</tbody></table>
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
  unlisten(H.gameCh); unlisten(H.hostCh);
  H.gameCh = H.hostCh = null;
  setSession(null);
  H.game = null;
  wake.off();
  if (reason) toast(reason);
  render();
}

// Safety net: re-read state regularly, faster while the realtime connection is down.
setInterval(() => { if (H.session && !H.connected) refresh(); }, 3000);
setInterval(() => { if (H.session) refresh(); }, 15000);

async function openLobby() {
  H.err = "";
  H.busy = true;
  render();
  store.set(K.key, H.hostKey, sessionStorage);
  const r = await rpc("create_game", { p_quiz: H.quiz, p_host_key: H.hostKey || null });
  H.busy = false;
  if (r.error) {
    H.err = r.error;
    if (Number.isInteger(r.index)) H.editIdx = r.index;
    render();
    if (r.need_key && $("hostkey")) $("hostkey").focus();
    return;
  }
  setSession({ game_id: r.game_id, pin: r.pin, host_token: r.host_token });
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
  const lines = [["Rank", "Name", "Score", "Correct answers", "Quiz questions"]]
    .concat((g.results || []).map((p) => [p.rank, p.name, p.score, p.correct, p.of]))
    .map((row) => row.map(csvCell).join(","));
  download(`${slug(g.title)}-results-${g.pin}.csv`, "﻿" + lines.join("\r\n"), "text/csv");
}

$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    H.quiz = normaliseQuiz({ ...data, id: uid() });
    H.editIdx = 0; H.view = "edit"; H.err = "";
    saveDraft(); render();
    toast(`Imported "${H.quiz.title}"`);
  } catch {
    toast("That file isn't a valid quiz JSON.", true);
  }
});

/* ---------- Events ---------- */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const a = b.dataset.act;
  const qs = H.quiz.questions;
  const edited = () => { saveDraft(); render(); };
  switch (a) {
    case "pick": H.editIdx = +b.dataset.i; render(); break;
    case "add": qs.push(blankQ()); H.editIdx = qs.length - 1; edited(); $("qtextin").focus(); break;
    case "dup": qs.splice(H.editIdx + 1, 0, JSON.parse(JSON.stringify(qs[H.editIdx]))); H.editIdx++; edited(); break;
    case "del": qs.splice(H.editIdx, 1); H.editIdx = Math.max(0, H.editIdx - 1); edited(); break;
    case "up": case "down": {
      const j = H.editIdx + (a === "up" ? -1 : 1);
      [qs[H.editIdx], qs[j]] = [qs[j], qs[H.editIdx]]; H.editIdx = j; edited(); break;
    }
    case "new":
      if (!(await popup({ title: "Start a new quiz?", message: "This clears the editor. Save the current quiz to My quizzes first if you want to keep it.", confirmLabel: "Start new quiz", icon: "+" }))) return;
      H.quiz = normaliseQuiz({ title: "", event: H.quiz.event, questions: [] }); H.editIdx = 0; H.err = ""; edited(); break;
    case "save": {
      const lib = library().filter((x) => x.id !== H.quiz.id);
      lib.unshift({ ...JSON.parse(JSON.stringify(H.quiz)), savedAt: Date.now() });
      store.set(K.lib, lib); render(); toast("Saved to My quizzes"); break;
    }
    case "library": H.view = "library"; render(); break;
    case "editor": H.view = "edit"; render(); break;
    case "load": {
      const x = library().find((y) => y.id === b.dataset.id);
      if (x) { H.quiz = normaliseQuiz(x); H.editIdx = 0; H.view = "edit"; H.err = ""; edited(); }
      break;
    }
    case "libdel":
      if (!(await popup({ title: "Delete this quiz?", message: `"${(library().find((y) => y.id === b.dataset.id) || {}).title || "This quiz"}" will be removed from My quizzes. This can't be undone.`, confirmLabel: "Delete", tone: "danger" }))) return;
      store.set(K.lib, library().filter((y) => y.id !== b.dataset.id)); render(); break;
    case "import": $("importFile").click(); break;
    case "export": {
      const { id, ...rest } = H.quiz;
      download(`${slug(H.quiz.title)}.json`, JSON.stringify(rest, null, 2), "application/json"); break;
    }
    case "open": openLobby(); break;
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

document.addEventListener("input", (e) => {
  const t = e.target;
  if (H.game) return;
  if (t.dataset.hostkey !== undefined) { H.hostKey = t.value; return; }
  const cur = H.quiz.questions[H.editIdx];
  if (t.dataset.meta) H.quiz[t.dataset.meta] = t.value;
  else if (t.dataset.field === "text") { cur.text = t.value; const el = $("qtext-" + H.editIdx); if (el) el.textContent = t.value || "Untitled question"; }
  else if (t.dataset.opt) cur.options[+t.dataset.opt] = t.value;
  else return;
  saveDraft();
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (H.game) return;
  const cur = H.quiz.questions[H.editIdx];
  if (t.dataset.correct) cur.correct = +t.dataset.correct;
  else if (t.dataset.field === "type") { cur.type = t.value; cur.correct = t.value === "quiz" ? 0 : null; render(); }
  else if (t.dataset.field === "time") { cur.time = +t.value; render(); }
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

if (H.session) { connect(); refresh(); }
render();
