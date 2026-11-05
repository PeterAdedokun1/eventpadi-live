"use strict";
/* Organiser account: sign-in, dashboard (saved games, templates, live and past games)
   and game reports. Loaded before host.js; uses its H state and render() at call time. */

const TEMPLATES = [
  {
    key: "icebreaker", icon: "?", tone: "quiz", blurb: "Quiz questions with a typing race and a prize draw at the end.",
    quiz: {
      title: "Morning icebreaker",
      questions: [
        { type: "quiz", text: "What does \"padi\" mean in Nigerian Pidgin?", options: ["Friend", "Boss", "Money", "Food"], correct: 0, time: 20 },
        { type: "quiz", text: "In what year did Nigeria gain independence?", options: ["1957", "1960", "1963", "1970"], correct: 1, time: 20 },
        { type: "poll", text: "Which session are you most excited about today?", options: ["Fintech panel", "AI keynote", "Startup pitches", "Networking mixer"], correct: null, time: 15 },
        { type: "quiz", text: "Which is the longest bridge in Lagos?", options: ["Eko Bridge", "Carter Bridge", "Third Mainland Bridge", "Lekki-Ikoyi Link Bridge"], correct: 2, time: 20 },
        { type: "quiz", text: "Which Nigerian artist won the Grammy for Best Global Music Album in 2021?", options: ["Wizkid", "Davido", "Tems", "Burna Boy"], correct: 3, time: 20 },
        { type: "type", text: "Type the word on the big screen", answer: "Jollof", time: 30 },
        { type: "raffle", text: "Eventpadi tote bag", winners: 1 }
      ]
    }
  },
  {
    key: "feedback", icon: "▮", tone: "poll", blurb: "Live polls to collect honest feedback before people leave.",
    quiz: {
      title: "Event feedback",
      questions: [
        { type: "poll", text: "How would you rate today's event?", options: ["Excellent", "Good", "Okay", "Poor"], time: 20 },
        { type: "poll", text: "Which part was most valuable to you?", options: ["Keynote", "Panel discussion", "Workshops", "Networking"], time: 20 },
        { type: "poll", text: "How did you hear about this event?", options: ["Social media", "A friend", "Email", "Eventpadi"], time: 15 },
        { type: "poll", text: "Would you come again next time?", options: ["Definitely", "Probably", "Not sure", "No"], time: 15 }
      ]
    }
  },
  {
    key: "luckydraw", icon: "★", tone: "raffle", blurb: "Three raffles, from consolation prizes up to the grand prize.",
    quiz: {
      title: "Lucky draw",
      questions: [
        { type: "raffle", text: "Consolation prizes", winners: 5 },
        { type: "raffle", text: "Runner-up prizes", winners: 3 },
        { type: "raffle", text: "Grand prize", winners: 1 }
      ]
    }
  },
  {
    key: "typing", icon: "⌨", tone: "type", blurb: "Quick typing races to wake the room up between sessions.",
    quiz: {
      title: "Fastest fingers warm-up",
      questions: [
        { type: "type", text: "Type the word on the big screen", answer: "Eventpadi", time: 20 },
        { type: "type", text: "Type the word on the big screen", answer: "Networking", time: 20 },
        { type: "type", text: "Type the phrase on the big screen", answer: "Lagos to the world", time: 30 },
        { type: "type", text: "Type the word on the big screen", answer: "Innovation", time: 20 }
      ]
    }
  }
];

const timeAgo = (ms) => {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 7) return Math.floor(s / 86400) + " d ago";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const dateTime = (ms) => ms ? new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const duration = (a, b) => { if (!a || !b) return "—"; const m = Math.round((b - a) / 60000); if (m < 1) return "under 1 min"; return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
const firstName = (u) => ((u && u.user_metadata && u.user_metadata.full_name) || "").trim().split(/\s+/)[0] || "";
const typePills = (types) => (types || []).map((t) => `<span class="pill t-${esc(t)}">${esc(roundLabel(t))}</span>`).join("");

/* ---------- Auth ---------- */
async function initAuth() {
  const { data } = await sb.auth.getSession();
  setUser(data.session ? data.session.user : null);
  sb.auth.onAuthStateChange((event, session) => {
    // Supabase advises against awaiting other calls inside this callback.
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") { H.view = "reset"; H.auth.msg = ""; }
      setUser(session ? session.user : null, event === "PASSWORD_RECOVERY");
    }, 0);
  });
}

function setUser(u, force) {
  const changed = !H.authReady || (u && u.id) !== (H.user && H.user.id);
  H.user = u;
  H.authReady = true;
  if (!changed && !force) return;
  if (u) {
    // Unsaved edits (e.g. the session expired mid-edit) go back to the editor and get saved.
    if (H.quiz && H.save !== "saved") { H.view = "edit"; setTimeout(cloudSave, 0); }
    else if (H.view === "auth" || (H.view === "edit" && !H.quiz)) H.view = "home";
    if (H.view === "home") loadHome();
  } else {
    H.view = "auth"; H.quizzes = H.games = H.report = null;
  }
  if (!H.game) render();
}

function authView() {
  const a = H.auth, up = a.mode === "signup", forgot = a.mode === "forgot";
  return `<div class="auth-wrap">
    <div class="auth-card">
      <img class="brand-logo" src="/assets/logo.png" alt="eventpadi">
      <h1>${forgot ? "Reset your password" : up ? "Create your host account" : "Host a live game"}</h1>
      <p class="note">${forgot ? "We'll email you a link to choose a new password." : "Quizzes, polls, fastest fingers and raffles for your events. Attendees join from their phones, no app needed."}</p>
      ${forgot ? "" : `<div class="seg" role="tablist">
        <button role="tab" aria-selected="${!up}" data-act="authmode" data-mode="signin">Sign in</button>
        <button role="tab" aria-selected="${up}" data-act="authmode" data-mode="signup">Create account</button>
      </div>`}
      <form class="auth-form" data-form="${a.mode}" novalidate>
        ${up ? `<div class="field"><label for="au-name">Your name</label><input class="input" id="au-name" name="name" autocomplete="name" maxlength="60" placeholder="e.g. Tolu Adeyemi"></div>` : ""}
        <div class="field"><label for="au-email">Email</label><input class="input" id="au-email" name="email" type="email" autocomplete="email" required placeholder="you@company.com" value="${esc(a.email)}"></div>
        ${forgot ? "" : `<div class="field"><label for="au-pw">Password</label><input class="input" id="au-pw" name="password" type="password" autocomplete="${up ? "new-password" : "current-password"}" minlength="8" required placeholder="${up ? "At least 8 characters" : "Your password"}"></div>`}
        ${a.msg ? `<div class="${a.ok ? "ok-box" : "err-box"}" role="alert">${esc(a.msg)}</div>` : ""}
        <button class="btn primary big" type="submit" ${a.busy ? "disabled" : ""}>${a.busy ? "Please wait…" : forgot ? "Send reset link" : up ? "Create account" : "Sign in"}</button>
      </form>
      ${forgot ? `<button class="btn link" data-act="authmode" data-mode="signin">Back to sign in</button>`
               : up ? "" : `<button class="btn link" data-act="authmode" data-mode="forgot">Forgot your password?</button>`}
    </div>
    <p class="auth-foot">Playing a game? <a href="/">Join with a PIN</a></p>
  </div>`;
}

function resetView() {
  const a = H.auth;
  return `<div class="auth-wrap"><div class="auth-card">
    <img class="brand-logo" src="/assets/logo.png" alt="eventpadi">
    <h1>Choose a new password</h1>
    <form class="auth-form" data-form="reset" novalidate>
      <div class="field"><label for="au-pw">New password</label><input class="input" id="au-pw" name="password" type="password" autocomplete="new-password" minlength="8" required placeholder="At least 8 characters"></div>
      ${a.msg ? `<div class="${a.ok ? "ok-box" : "err-box"}" role="alert">${esc(a.msg)}</div>` : ""}
      <button class="btn primary big" type="submit" ${a.busy ? "disabled" : ""}>${a.busy ? "Saving…" : "Save password"}</button>
    </form>
  </div></div>`;
}

const AUTH_ERR = {
  "Invalid login credentials": "That email and password don't match. Try again, or reset your password.",
  "Email not confirmed": "Please confirm your email first. Check your inbox for the link we sent.",
  "User already registered": "There's already an account with that email. Sign in instead."
};
const authErr = (e) => AUTH_ERR[e.message] || (/rate limit/i.test(e.message) ? "Too many attempts. Please wait a few minutes and try again." : e.message || "Something went wrong. Please try again.");

async function submitAuth(form) {
  const a = H.auth, f = new FormData(form);
  const email = String(f.get("email") || "").trim(), password = String(f.get("password") || "");
  a.email = email || a.email;
  const fail = (msg) => { a.busy = false; a.msg = msg; a.ok = false; render(); };
  if (form.dataset.form !== "reset" && !/^\S+@\S+\.\S+$/.test(email)) return fail("Enter a valid email address.");
  if (["signin", "signup", "reset"].includes(form.dataset.form) && password.length < 8) return fail("Passwords have at least 8 characters.");
  a.busy = true; a.msg = ""; render();
  const back = location.origin + "/host";
  let res;
  try {
    if (form.dataset.form === "signin") res = await sb.auth.signInWithPassword({ email, password });
    else if (form.dataset.form === "signup") res = await sb.auth.signUp({ email, password, options: { emailRedirectTo: back, data: { full_name: String(f.get("name") || "").trim().slice(0, 60) } } });
    else if (form.dataset.form === "forgot") res = await sb.auth.resetPasswordForEmail(email, { redirectTo: back });
    else res = await sb.auth.updateUser({ password });
  } catch { return fail(NET_ERR); }
  if (res.error) return fail(authErr(res.error));
  a.busy = false;
  if (form.dataset.form === "signup" && !res.data.session) {
    a.mode = "signin"; a.ok = true; a.msg = "Account created. We've sent you an email: click the link in it, then sign in here.";
  } else if (form.dataset.form === "forgot") {
    a.ok = true; a.msg = "If there's an account for that email, a reset link is on its way.";
  } else if (form.dataset.form === "reset") {
    a.msg = ""; H.view = "home"; loadHome(); toast("Password updated");
  } else {
    a.msg = "";
  }
  render();
}

/* ---------- Dashboard ---------- */
async function loadHome() {
  const [q, g] = await Promise.all([rpc("my_quizzes", {}), rpc("my_games", { p_limit: 50 })]);
  if (q.auth || g.auth) return sb.auth.signOut();
  if (q.error || g.error) { H.homeErr = q.error || g.error; } else { H.homeErr = ""; H.quizzes = q.quizzes; H.games = g.games; }
  if (!H.game && H.view === "home") render();
}

function homeView() {
  const name = firstName(H.user);
  const qs = H.quizzes, gs = H.games;
  const live = (gs || []).filter((x) => x.phase !== "ended");
  const past = (gs || []).filter((x) => x.phase === "ended" || x.phase === "podium");
  const filter = H.search.trim().toLowerCase();
  const shown = (qs || []).filter((x) => !filter || (x.title + " " + x.event).toLowerCase().includes(filter));
  const legacy = legacyGames();

  const liveCards = live.filter((x) => x.phase !== "podium").map((x) => `
    <div class="live-card">
      <span class="live-dot" aria-hidden="true"></span>
      <div><b>${esc(x.title)}</b><span class="note">PIN ${esc(x.pin)} · ${x.players} player${x.players === 1 ? "" : "s"} · ${x.phase === "lobby" ? "in the lobby" : "in progress"} · opened ${timeAgo(x.created_at)}</span></div>
      <div class="row"><button class="btn small primary" data-act="resume" data-id="${esc(x.id)}">Return to game</button>
      <button class="btn small ghost danger" data-act="endlive" data-id="${esc(x.id)}">End</button></div>
    </div>`).join("");

  const cards = qs == null
    ? Array.from({ length: 3 }, () => `<div class="game-card skeleton"></div>`).join("")
    : shown.length ? shown.map((x) => `
      <article class="game-card">
        <div class="gc-top">${typePills(x.types)}</div>
        <h3>${esc(x.title || "Untitled game")}</h3>
        <p class="note">${esc(x.event || "No event set")}</p>
        <p class="gc-meta">${x.rounds} round${x.rounds === 1 ? "" : "s"} · edited ${timeAgo(x.updated_at)}${x.played ? ` · played ${x.played}×` : ""}</p>
        <div class="gc-actions">
          <button class="btn small primary" data-act="hostq" data-id="${esc(x.id)}" ${x.rounds ? "" : "disabled"}>Host</button>
          <button class="btn small" data-act="editq" data-id="${esc(x.id)}">Edit</button>
          <button class="btn small ghost" data-act="dupq" data-id="${esc(x.id)}" title="Make a copy">Copy</button>
          <button class="btn small ghost danger" data-act="delq" data-id="${esc(x.id)}" data-name="${esc(x.title)}" aria-label="Delete ${esc(x.title)}">Delete</button>
        </div>
      </article>`).join("")
    : filter ? `<div class="empty">No games match "${esc(H.search)}".</div>`
    : `<div class="empty">You haven't made a game yet. Start from a template below or create one from scratch.</div>`;

  const rows = past.map((x) => `
    <tr>
      <td><b>${esc(x.title)}</b>${x.event ? `<span class="note"> · ${esc(x.event)}</span>` : ""}</td>
      <td>${esc(dateTime(x.started_at || x.created_at))}</td>
      <td>${x.players}</td>
      <td class="right"><button class="btn small" data-act="report" data-id="${esc(x.id)}">View report</button>
        ${x.phase === "ended" ? `<button class="btn small ghost danger" data-act="forget" data-id="${esc(x.id)}" aria-label="Delete report">Delete</button>` : ""}</td>
    </tr>`).join("");

  return `
    <div class="page-head">
      <div><h1>${name ? `Welcome back, ${esc(name)}` : "Your games"}</h1><p class="note">Build a game once, host it at any event. Attendees join at <b>${esc(joinBase().replace(/^https?:\/\//, ""))}</b> with a PIN.</p></div>
      <button class="btn primary big" data-act="newgame">+ New game</button>
    </div>
    ${H.homeErr ? `<div class="err-box" role="alert">${esc(H.homeErr)} <button class="btn small" data-act="reloadhome">Try again</button></div>` : ""}
    ${liveCards ? `<section class="live-now"><h2 class="sec-title">Live now</h2>${liveCards}</section>` : ""}
    ${legacy.length ? `<div class="notice"><span>We found ${legacy.length} game${legacy.length === 1 ? "" : "s"} saved in this browser from before accounts. Add ${legacy.length === 1 ? "it" : "them"} to your account?</span>
      <div class="row"><button class="btn small primary" data-act="importlegacy">Add to my account</button><button class="btn small ghost" data-act="dismisslegacy">No thanks</button></div></div>` : ""}
    <section>
      <div class="sec-head"><h2 class="sec-title">My games</h2>
        <div class="row">${(qs || []).length > 6 ? `<input class="input search" id="search" data-search placeholder="Search games" value="${esc(H.search)}" aria-label="Search games">` : ""}
        <button class="btn small ghost" data-act="import">Import JSON</button></div></div>
      <div class="game-grid">${cards}</div>
    </section>
    <section>
      <h2 class="sec-title">Start from a template</h2>
      <div class="tpl-grid">${TEMPLATES.map((t, i) => `
        <button class="tpl-card t-${t.tone}" data-act="template" data-i="${i}">
          <span class="tpl-ico" aria-hidden="true">${t.icon}</span>
          <b>${esc(t.quiz.title)}</b><span class="note">${esc(t.blurb)}</span>
          <span class="gc-meta">${t.quiz.questions.length} rounds</span>
        </button>`).join("")}
        <button class="tpl-card blank" data-act="newgame"><span class="tpl-ico" aria-hidden="true">+</span><b>Blank game</b><span class="note">Start from scratch.</span></button>
      </div>
    </section>
    <section>
      <h2 class="sec-title">Past games</h2>
      ${gs == null ? `<div class="game-card skeleton wide"></div>` : rows
        ? `<div class="table-card"><table class="results"><thead><tr><th>Game</th><th>Played</th><th>Players</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty">Reports from games you host will appear here.</div>`}
    </section>`;
}

/* Games saved in this browser before accounts existed. */
function legacyGames() {
  if (store.get("ep-live:legacy-done")) return [];
  const lib = store.get("ep-live:library") || [];
  const draft = store.get("ep-live:draft");
  const all = lib.slice();
  if (draft && draft.questions && !lib.some((x) => x.id === draft.id)) all.push(draft);
  return all.filter((x) => x && Array.isArray(x.questions) && x.questions.length);
}

async function importLegacy() {
  const list = legacyGames();
  for (const x of list) {
    const r = await rpc("save_quiz", { p_id: null, p_quiz: normaliseQuiz({ ...x, id: null }) });
    if (r.error) return toast(r.error, true);
  }
  store.set("ep-live:legacy-done", true);
  toast(`Added ${list.length} game${list.length === 1 ? "" : "s"} to your account`);
  loadHome();
}

/* ---------- Report ---------- */
async function openReport(id) {
  H.view = "report"; H.report = null; render();
  const r = await rpc("game_report", { p_game: id });
  if (r.error) { toast(r.error, true); H.view = "home"; loadHome(); render(); return; }
  H.report = r;
  if (H.view === "report") render();
}

function reportView() {
  const r = H.report;
  const back = `<button class="btn ghost" data-act="home">← My games</button>`;
  if (!r) return `${back}<div class="center-load"><div class="spinner" aria-hidden="true"></div><p class="note">Loading report…</p></div>`;
  const g = r.game, ps = r.players;
  const avg = ps.length && g.scored ? Math.round(ps.reduce((s, p) => s + p.score, 0) / ps.length) : null;
  const tiles = [
    ["Players", ps.length],
    ["Rounds played", `${g.played} of ${g.rounds}`],
    [g.scored ? "Average score" : "Prizes given", g.scored ? (avg || 0).toLocaleString() : r.rounds.reduce((s, x) => s + ((x.winners || []).length), 0)],
    ["Duration", duration(g.started_at, g.ended_at)]
  ].map(([k, v]) => `<div class="tile"><span class="lbl">${k}</span><b>${esc(v)}</b></div>`).join("");

  const rounds = r.rounds.map((x) => {
    const head = `<div class="rc-head"><span class="pill t-${x.type}">${roundLabel(x.type)}</span><span class="note">Round ${x.i + 1}${x.played ? "" : " · not played"}</span></div>`;
    let body = "";
    if (x.type === "quiz" || x.type === "poll") {
      const total = Math.max(1, (x.counts || []).reduce((a, b) => a + b, 0));
      body = `<h3>${esc(x.text)}</h3><div class="hbars">${(x.options || []).map((o, k) => {
        const n = (x.counts || [])[k] || 0, pct = Math.round((n / total) * 100), ok = x.type === "quiz" && k === x.correct;
        return `<div class="hbar ${ok ? "ok" : ""}"><span class="hb-label"><span class="letter ${COLORS[k]}">${LETTERS[k]}</span>${esc(o)}${ok ? " ✓" : ""}</span><span class="hb-track"><span class="hb-fill ${COLORS[k]}" style="width:${pct}%"></span></span><span class="hb-n">${n} · ${pct}%</span></div>`;
      }).join("")}</div>
      <p class="note">${x.answered} answered${x.type === "quiz" && x.avg_ms ? ` · correct answers took ${(x.avg_ms / 1000).toFixed(1)}s on average` : ""}</p>`;
    } else if (x.type === "type") {
      body = `<h3>Type "${esc(x.answer)}"</h3><p class="note">${x.answered} typed it correctly</p>
        ${(x.fastest || []).length ? `<ol class="mini-list">${x.fastest.map((f) => `<li><span>${esc(f.name)}</span><b>${fmtSecs(f.ms)}</b></li>`).join("")}</ol>` : ""}`;
    } else if (x.type === "raffle") {
      body = `<h3>Prize: ${esc(x.text)}</h3>${(x.winners || []).length ? `<p class="winners-line">★ ${x.winners.map(esc).join(", ")}</p>` : `<p class="note">No winner drawn.</p>`}`;
    }
    return `<article class="round-card t-${x.type}">${head}${body}</article>`;
  }).join("");

  const table = ps.map((p) => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td>${g.scored ? `<td>${p.score.toLocaleString()}</td><td>${p.correct} / ${g.scored}</td>` : ""}<td>${esc((p.prizes || []).join(", "))}</td></tr>`).join("");

  return `
    <div class="row spread no-print">${back}
      <div class="row"><button class="btn" data-act="reportcsv">Download CSV</button><button class="btn" data-act="print">Print / PDF</button></div></div>
    <div class="report-head">
      <div><span class="lbl">Game report</span><h1>${esc(g.title)}</h1><p class="note">${g.event ? esc(g.event) + " · " : ""}${esc(dateTime(g.started_at || g.created_at))} · PIN ${esc(g.pin)}</p></div>
    </div>
    <div class="tiles">${tiles}</div>
    <section><h2 class="sec-title">${g.scored ? "Leaderboard" : "Players"}</h2>
      <div class="table-card"><table class="results"><thead><tr><th>Rank</th><th>Name</th>${g.scored ? "<th>Score</th><th>Correct</th>" : ""}<th>Prizes</th></tr></thead>
      <tbody>${table || `<tr><td colspan="5" class="note">Nobody joined this game.</td></tr>`}</tbody></table></div></section>
    <section><h2 class="sec-title">Round by round</h2><div class="round-grid">${rounds}</div></section>`;
}

function exportReportCsv() {
  const r = H.report, g = r.game;
  const lines = [["Rank", "Name", "Score", "Correct answers", "Scored rounds", "Prizes won", "Joined"]]
    .concat(r.players.map((p) => [p.rank, p.name, p.score, p.correct, g.scored, (p.prizes || []).join("; "), new Date(p.joined_at).toISOString()]));
  lines.push([], ["Round", "Type", "Question / prize", "Answered", "Results"]);
  for (const x of r.rounds) {
    let res = "";
    if (x.options) res = x.options.map((o, k) => `${LETTERS[k]} ${o}: ${(x.counts || [])[k] || 0}${x.type === "quiz" && k === x.correct ? " (correct)" : ""}`).join(" | ");
    if (x.type === "type") res = `Word: ${x.answer}. Fastest: ` + (x.fastest || []).map((f) => `${f.name} ${fmtSecs(f.ms)}`).join(", ");
    if (x.type === "raffle") res = "Winners: " + (x.winners || []).join(", ");
    lines.push([x.i + 1, roundLabel(x.type), x.type === "type" ? x.answer : x.text, x.answered, res]);
  }
  download(`${slug(g.title)}-report-${g.pin}.csv`, "﻿" + lines.map((row) => row.map(csvCell).join(",")).join("\r\n"), "text/csv");
}
