"use strict";
/* Attendee phone. Public game state arrives by Realtime broadcast; personal
   results (score, rank, correct or not) are read with player_view(). */

const K_SESSION = "ep-live:player";

const P = {
  step: "pin",          // pin | nick (only used when not in a game)
  avatar: AVATARS.includes(store.get("ep-live:avatar")) ? store.get("ep-live:avatar") : AVATARS[Math.floor(Math.random() * AVATARS.length)],
  reactAt: 0,
  pin: "",
  gameId: null,
  info: null,           // { event, title } from the PIN check
  err: "",
  state: null,          // latest view of the game for this player
  session: store.get(K_SESSION), // { game_id, player_id, token }
  connected: false,
  resuming: !!store.get(K_SESSION),
  pending: null,        // choice sent but not yet confirmed
  busy: false,
  timers: [],
  ch: null,
  lastKey: "",
  typeErr: "",          // fastest fingers: "try again" message
  typeMs: null          // fastest fingers: my time once correct
};

/* ---------- Rendering ---------- */
function clearTimers() { P.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); P.timers = []; }

function render() {
  clearTimers();
  const s = P.state, me = s && s.me;
  const ph = s ? shownPhase(s) : null;
  const timer = ph === "question" && s.question.type !== "raffle" ? `<span class="ptimer" id="ptimer"></span>` : "";
  const top = `<div class="phone-top"><span>${s ? `PIN <b>${esc(s.pin)}</b>` : esc(location.host)}</span>${timer}<span>${me ? `${av(me.avatar)}<b>${esc(me.name)}</b>` : "Eventpadi Live"}</span></div>`;
  const off = P.session && !P.connected && !P.resuming ? `<div class="offline" role="status">Reconnecting…</div>` : "";
  const foot = me && s.phase !== "lobby" ? `<div class="phone-foot"><span>${esc(me.name)}</span><span>${me.score.toLocaleString()} pts</span></div>` : "";
  document.body.classList.toggle("joining", !s);
  applyTheme(s ? s.theme : P.step === "nick" && P.info ? P.info.theme : null);
  // Keep whatever is being typed across re-renders.
  const keep = ["nick", "typein"].map((id) => [id, $(id) && $(id).value, document.activeElement && document.activeElement.id === id]);
  const reacts = s && ["lobby", "reveal", "leaderboard", "podium"].includes(ph) ? reactBar() : "";
  $("phone").innerHTML = off + top + `<div class="phone-body">${body(ph)}${reacts}</div>` + foot;
  for (const [id, val, focused] of keep) {
    const el = $(id);
    if (!el) continue;
    if (val) el.value = val;
    if (focused) el.focus();
  }
  const ti = $("typein");
  if (ti && !keep[1][2] && !document.querySelector(".modal-backdrop")) ti.focus();
  if (ph === "intro") P.timers.push(setTimeout(render, Math.max(0, s.q_starts_at - clock.now()) + 20));
  if (ph === "question") startTimer();
}

function body(ph) {
  const s = P.state;
  if (!s) {
    if (P.resuming) return `<div class="center"><div class="join-card"><div class="spinner" aria-hidden="true" style="margin:0 auto"></div><p>Reconnecting to your game…</p></div></div>`;
    if (P.step === "nick") {
      return `<div class="center"><div class="join-card">
        ${P.info && P.info.theme && P.info.theme.logo ? themeLogo(P.info.theme, "event-logo join") : `<img class="brand-logo" src="/assets/logo.png" alt="eventpadi">`}
        ${P.info ? `<div><span class="event-name">${esc(P.info.event || P.info.title)}</span></div>` : ""}
        <h2>Pick a nickname</h2><p class="hint">This is how you'll appear on the big screen.</p>
        <div class="av-picked" aria-hidden="true">${P.avatar}</div>
        <input class="input" id="nick" maxlength="15" placeholder="Nickname" autocomplete="nickname" enterkeyhint="go">
        <div class="av-grid" role="radiogroup" aria-label="Choose your avatar">${AVATARS.map((a) => `<button class="av-btn" role="radio" aria-checked="${a === P.avatar}" data-act="pickav" data-a="${a}">${a}</button>`).join("")}</div>
        <div class="err" id="perr" role="alert">${esc(P.err)}</div>
        <button class="btn primary" data-act="join" ${P.busy ? "disabled" : ""}>${P.busy ? "Joining…" : "Join game"}</button>
        <button class="btn link" data-act="changepin">Use a different PIN</button></div></div>`;
    }
    return `<div class="center"><div class="join-card">
      <img class="brand-logo" src="/assets/logo.png" alt="eventpadi">
      <h2>Join a live game</h2>
      <input class="input" id="pinin" inputmode="numeric" pattern="[0-9]*" maxlength="7" placeholder="Game PIN" autocomplete="off" enterkeyhint="go" value="${esc(P.pin)}">
      <div class="err" id="perr" role="alert">${esc(P.err)}</div>
      <button class="btn primary" data-act="enterpin" ${P.busy ? "disabled" : ""}>${P.busy ? "Checking…" : "Enter"}</button></div>
      <p class="join-foot">The PIN is on the big screen.</p></div>`;
  }

  const me = s.me, q = s.question;
  switch (ph) {
    case "lobby":
      return `<div class="center">${s.event ? `<div class="event-name">${esc(s.event)}</div>` : ""}${themeLogo(s.theme, "event-logo phone-lobby")}<div class="lobby-av" aria-hidden="true">${esc(me.avatar || "🎉")}</div><h2>You're in!</h2><p>See your name on the screen?</p><p class="hint">The game starts when the host is ready.</p>${s.theme && s.theme.sponsor ? `<p class="sponsor-foot">Sponsored by <b>${esc(s.theme.sponsor)}</b></p>` : ""}
        <button class="btn link" data-act="leave">Not you? Change nickname</button></div>`;
    case "intro": {
      const chip = `<span class="chip">Round ${s.qi + 1} of ${s.total} · ${roundLabel(q.type)}</span>`;
      if (q.type === "type") return `<div class="center">${chip}<div class="round-ico t-type" aria-hidden="true">⌨</div><h2>Fastest fingers!</h2><p>Watch the big screen and type the word as fast as you can.</p></div>`;
      if (q.type === "raffle") return `<div class="center">${chip}<div class="round-ico t-raffle" aria-hidden="true">★</div><h2>Raffle time!</h2><p>Prize: <b>${esc(q.text)}</b></p><p class="hint">Everyone who joined is in the draw.</p></div>`;
      return `<div class="center">${chip}<h2>Get ready!</h2><div class="spinner" aria-hidden="true"></div></div>`;
    }
    case "question": {
      if (q.type === "raffle") {
        return `<div class="center"><div class="round-ico t-raffle spin" aria-hidden="true">★</div><h2>Drawing…</h2><p>Fingers crossed! Watch the big screen.</p><p class="hint">Prize: ${esc(q.text)}</p></div>`;
      }
      if (q.type === "type") {
        if (s.my_answer != null) {
          return `<div class="center"><div class="result-card good"><span class="lbl">Got it</span><h3>${P.typeMs != null ? (P.typeMs / 1000).toFixed(2) + " seconds" : "Locked in!"}</h3></div><p>Waiting for everyone else…</p><div class="spinner" aria-hidden="true"></div></div>`;
        }
        if (clock.now() > s.q_ends_at) {
          return `<div class="center"><h2>Time's up!</h2><p>Waiting for the results…</p><div class="spinner" aria-hidden="true"></div></div>`;
        }
        return `<div class="type-round">
          <p class="hint" style="text-align:center;margin:0">${esc(q.text)}</p>
          <input class="input type-in ${P.typeErr ? "shake" : ""}" id="typein" maxlength="60" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send" placeholder="Type it here" aria-label="Your answer">
          <div class="err" role="alert">${esc(P.typeErr)}</div>
          <button class="btn primary big-btn" data-act="typesend" ${P.busy ? "disabled" : ""}>${P.busy ? "Checking…" : "Send"}</button>
        </div>`;
      }
      const picked = s.my_answer != null ? s.my_answer : P.pending;
      if (picked != null) {
        return `<div class="center"><div class="result-card neutral"><span class="lbl">You picked</span><h3>${LETTERS[picked]} · ${esc(q.options[picked])}</h3></div><p>${s.my_answer != null ? "Answer locked in. Waiting for everyone else…" : "Sending…"}</p><div class="spinner" aria-hidden="true"></div></div>`;
      }
      if (clock.now() > s.q_ends_at) {
        return `<div class="center"><h2>Time's up!</h2><p>Waiting for the results…</p><div class="spinner" aria-hidden="true"></div></div>`;
      }
      return `<p class="hint" style="text-align:center;margin:0">${esc(q.text)}</p>
        <div class="pgrid ${q.options.length === 2 ? "two" : ""}">${q.options.map((o, i) => `<button class="pbtn ${COLORS[i]}" data-act="answer" data-i="${i}"><span class="letter">${LETTERS[i]}</span>${esc(o)}</button>`).join("")}</div>`;
    }
    case "reveal": {
      const r = s.result;
      if (!r) return `<div class="center"><div class="spinner" aria-hidden="true"></div><p>Getting your result…</p></div>`;
      const place = `<p>You're in ${ordinal(me.rank)} place</p>${s.ahead ? `<p class="hint">${s.ahead.gap.toLocaleString()} points behind ${esc(s.ahead.name)}</p>` : ""}`;
      if (q.type === "raffle") {
        const drawn = (q.drawn || []).map(esc).join(", ");
        if (r.won) return `<div class="center"><div class="result-card win"><span class="lbl">Congratulations!</span><h3>You won!</h3><p class="big-prize">${esc(q.text)}</p><p>Go to the help desk to collect your prize.</p></div></div>`;
        return `<div class="center"><div class="result-card neutral"><h3>Not this time</h3><p>${drawn ? (q.drawn.length > 1 ? "Winners: " : "Winner: ") + drawn : "No winner drawn."}</p></div><p class="hint">Prize: ${esc(q.text)}</p></div>`;
      }
      if (q.type === "type") {
        if (!r.correct) return `<div class="center"><div class="result-card bad"><h3>Time's up</h3><p>The word was <b>${esc(q.answer || "")}</b></p></div>${place}</div>`;
        return `<div class="center"><div class="result-card good"><h3>${r.place === 1 ? "Fastest fingers!" : "You typed it!"}</h3><div class="big-num">+${r.points.toLocaleString()}</div><p>${(r.ms / 1000).toFixed(2)}s · ${ordinal(r.place)} fastest</p></div>${place}</div>`;
      }
      if (q.type === "poll") return `<div class="center"><div class="result-card neutral"><h3>${r.answered ? "Thanks for voting" : "You didn't vote"}</h3><p>Results are on the big screen.</p></div></div>`;
      if (!r.answered) return `<div class="center"><div class="result-card bad"><h3>Time's up</h3><p>You didn't answer this one.</p></div>${place}</div>`;
      return `<div class="center"><div class="result-card ${r.correct ? "good" : "bad"}"><h3>${r.correct ? "Correct!" : "Not quite"}</h3>${r.correct ? `<div class="big-num">+${r.points.toLocaleString()}</div>${me.streak > 1 ? `<p>${me.streak} correct in a row</p>` : ""}` : `<p>The answer was ${LETTERS[q.correct]} · ${esc(q.options[q.correct])}</p>`}</div>${place}</div>`;
    }
    case "leaderboard":
      return `<div class="center"><span class="lbl">Your position</span><div class="big-num">${ordinal(me.rank)}</div><p>${me.score.toLocaleString()} points</p><p class="hint">${s.ahead ? `${s.ahead.gap.toLocaleString()} points behind ${esc(s.ahead.name)}` : "You're leading. Keep it up!"}</p></div>`;
    case "podium": {
      const prizes = (s.my_prizes || []).length ? `<div class="result-card win"><span class="lbl">You won</span><h3>${s.my_prizes.map(esc).join(", ")}</h3><p>Collect at the help desk.</p></div>` : "";
      if (!s.scored) return `<div class="center"><h2>That's a wrap!</h2>${prizes}<p class="hint">Thanks for joining${s.event ? " " + esc(s.event) : ""}.</p><button class="btn" data-act="done">Join another game</button></div>`;
      return `<div class="center">${prizes}<span class="lbl">Final position</span><div class="big-num">${ordinal(me.rank)}</div><p>${me.score.toLocaleString()} points</p><p class="hint">${me.rank <= 3 ? "You made the podium! Collect your prize at the help desk." : `Thanks for playing${s.event ? " at " + esc(s.event) : ""}.`}</p>
        <button class="btn" data-act="done">Join another game</button></div>`;
    }
  }
  return "";
}

function startTimer() {
  const s = P.state;
  // Re-render once when time runs out (to show "Time's up"), never from a render that already shows it.
  let shownUp = s.q_ends_at <= clock.now() || s.question.type === "raffle";
  const step = () => {
    const el = $("ptimer");
    const left = Math.max(0, s.q_ends_at - clock.now());
    if (el) el.textContent = Math.ceil(left / 1000) + "s";
    if (left <= 0 && !shownUp) { shownUp = true; if (s.my_answer == null && P.pending == null) render(); }
  };
  step();
  P.timers.push(setInterval(step, 200));
}

function focusInput() {
  const el = $("nick") || $("pinin");
  if (el && !P.state) el.focus();
}

/* ---------- Game state ---------- */
function setSession(s) { P.session = s; s ? store.set(K_SESSION, s) : store.del(K_SESSION); }

const LEFT_GAME = {
  "The host ended the game.": { title: "Game over", message: "The host has ended this game. Thanks for playing!", icon: "★" },
  "The game has ended.": { title: "Game over", message: "This game has ended. Thanks for playing!", icon: "★" },
  "The host removed you from the game.": { title: "You've been removed", message: "The host removed you from this game. You can join again with a new nickname if the lobby is still open.", icon: "!" }
};

function backToStart(msg) {
  const wasInGame = !!P.session;
  unlisten(P.ch); P.ch = null;
  setSession(null);
  P.state = null; P.pending = null; P.resuming = false; P.connected = false;
  P.step = "pin"; P.pin = ""; P.info = null; P.err = "";
  wake.off();
  render();
  if (msg && wasInGame) {
    const m = LEFT_GAME[msg] || { title: "You've left the game", message: msg, icon: "i" };
    popup({ ...m, confirmLabel: "OK", cancelLabel: null }).then(focusInput);
  } else {
    P.err = msg || "";
    if (msg) render();
    focusInput();
  }
}

function applyState(v) {
  const key = v.phase + ":" + v.qi;
  if (key !== P.lastKey) {
    P.pending = null;
    P.typeErr = "";
    P.typeMs = null;
    P.lastKey = key;
    if (navigator.vibrate && v.phase === "reveal" && v.result) navigator.vibrate(v.result.won ? [60, 40, 60, 40, 200] : v.result.correct ? [40] : [20, 60, 20]);
  }
  P.state = v;
  wake.on();
  render();
}

let fetching = false;
async function fetchView() {
  if (!P.session || fetching) return;
  fetching = true;
  const v = await rpc("player_view", { p_player: P.session.player_id, p_token: P.session.token });
  fetching = false;
  P.resuming = false;
  if (v.network) { if (!P.state) render(); return; }
  if (v.error) return backToStart(/ended/.test(v.error) ? "The game has ended." : v.error);
  if (P.state && v.version < P.state.version) return;
  applyState(v);
}

// A public state broadcast. Phases with personal results need player_view();
// spread those reads over half a second so a big room doesn't hit the database at once.
function onBroadcast(st) {
  if (!P.session) return;
  if (st.phase === "ended") return backToStart("The host ended the game.");
  if (P.state && st.version <= P.state.version) return;
  if (["reveal", "leaderboard", "podium"].includes(st.phase) || !P.state) {
    setTimeout(fetchView, Math.random() * 500);
    return;
  }
  const prev = P.state;
  applyState({ ...st, me: prev.me, my_answer: prev.qi === st.qi ? prev.my_answer : null });
}

function connect() {
  unlisten(P.ch);
  P.ch = listen("game:" + P.session.game_id, {
    state: onBroadcast,
    kicked: (d) => { if (P.session && d.player_id === P.session.player_id) backToStart("The host removed you from the game."); }
  }, (status) => {
    const on = status === "SUBSCRIBED";
    if (on && !P.connected) fetchView();   // catch up on anything missed while offline
    P.connected = on;
    if (P.state) render();
  });
}

// Safety net: re-read regularly, faster while the realtime connection is down.
setInterval(() => { if (P.session && !P.connected) fetchView(); }, 4000);
setInterval(() => { if (P.session) fetchView(); }, 20000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && P.session) fetchView(); });

/* ---------- Actions ---------- */
async function enterPin() {
  const v = ($("pinin").value || "").replace(/\D/g, "");
  P.pin = v;
  if (v.length !== 6) { P.err = "The game PIN has 6 digits."; render(); return focusInput(); }
  P.busy = true; P.err = ""; render();
  const r = await rpc("check_pin", { p_pin: v });
  P.busy = false;
  if (r.error) { P.err = r.error; render(); return focusInput(); }
  P.gameId = r.game_id;
  P.info = { event: r.event, title: r.title, theme: r.theme || {} };
  P.step = "nick"; P.err = "";
  render(); focusInput();
}

async function join() {
  const name = ($("nick").value || "").trim();
  if (!name) { P.err = "Enter a nickname to join."; render(); return focusInput(); }
  P.busy = true; P.err = ""; render();
  const r = await rpc("join_game", { p_game: P.gameId, p_name: name, p_avatar: P.avatar });
  P.busy = false;
  if (r.error) { P.err = r.error; render(); const n = $("nick"); if (n) { n.value = name; n.focus(); } return; }
  setSession({ game_id: r.game_id, player_id: r.player_id, token: r.token });
  connect();
  await fetchView();
}

async function answer(i) {
  const s = P.state;
  if (!s || shownPhase(s) !== "question" || s.my_answer != null || P.pending != null) return;
  P.pending = i;
  if (navigator.vibrate) navigator.vibrate(15);
  render();
  const r = await rpc("submit_answer", { p_player: P.session.player_id, p_token: P.session.token, p_qi: s.qi, p_choice: i });
  if (!P.state || P.state.qi !== s.qi) return;
  if (r.error) { P.pending = null; toast(r.error, true); render(); return; }
  if (P.state.phase === "question" && P.state.qi === s.qi) { P.state.my_answer = i; P.pending = null; render(); }
}

/* Emoji reactions: sent over Realtime's HTTP endpoint to the host only (phones don't
   receive each other's reactions), at most one every 0.8 s per phone. */
function reactBar() {
  return `<div class="react-bar" aria-label="Send a reaction to the big screen">${REACTIONS.map((e) => `<button class="react-btn" data-act="react" data-e="${e}" aria-label="Send ${e}">${e}</button>`).join("")}</div>`;
}
let reactCh = null;
function sendReaction(e, btn) {
  if (!P.session || !REACTIONS.includes(e)) return;
  const now = Date.now();
  if (now - P.reactAt < 800) return;
  P.reactAt = now;
  btn.classList.remove("sent"); void btn.offsetWidth; btn.classList.add("sent");
  if (navigator.vibrate) navigator.vibrate(10);
  if (!reactCh || reactCh.topic !== "realtime:react:" + P.session.game_id) reactCh = sb.channel("react:" + P.session.game_id, { config: { private: false } });
  reactCh.httpSend("r", { e }).catch(() => {});
}

async function sendTyped() {
  const s = P.state, el = $("typein");
  if (!s || !el || shownPhase(s) !== "question" || s.question.type !== "type" || s.my_answer != null || P.busy) return;
  const text = el.value;
  if (!text.trim()) { el.focus(); return; }
  P.busy = true; P.typeErr = ""; render();
  const r = await rpc("submit_text", { p_player: P.session.player_id, p_token: P.session.token, p_qi: s.qi, p_text: text });
  P.busy = false;
  if (!P.state || P.state.qi !== s.qi || P.state.phase !== "question") return render();
  if (r.wrong) {
    P.typeErr = "Not quite. Check the spelling and try again.";
    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    render();
    const n = $("typein"); if (n) { n.focus(); n.select(); }
    return;
  }
  if (r.error) { toast(r.error, true); render(); return; }
  if (navigator.vibrate) navigator.vibrate(30);
  P.typeMs = r.ms; P.state.my_answer = 0; render();
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  switch (b.dataset.act) {
    case "enterpin": enterPin(); break;
    case "join": join(); break;
    case "answer": answer(+b.dataset.i); break;
    case "typesend": sendTyped(); break;
    case "changepin": P.step = "pin"; P.err = ""; render(); focusInput(); break;
    case "pickav": P.avatar = b.dataset.a; store.set("ep-live:avatar", P.avatar); render(); break;
    case "react": sendReaction(b.dataset.e, b); break;
    case "leave": {
      const s = P.session;
      unlisten(P.ch); P.ch = null;
      await rpc("leave_game", { p_player: s.player_id, p_token: s.token });
      setSession(null);
      P.gameId = s.game_id; P.state = null; P.step = "nick"; P.err = ""; P.connected = false;
      render(); focusInput(); break;
    }
    case "done": backToStart(""); break;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "pinin") enterPin();
  if (e.target.id === "nick") join();
  if (e.target.id === "typein") sendTyped();
});

/* ---------- Start ---------- */
(function init() {
  const url = new URL(location.href);
  const pin = (url.searchParams.get("pin") || "").replace(/\D/g, "").slice(0, 6);
  if (pin) history.replaceState(null, "", url.pathname === "/play" ? "/" : url.pathname);
  if (P.session) {
    connect();
    fetchView().then(() => {
      // Scanned a QR code for a different game: offer that game instead.
      if (pin && (!P.state || P.state.pin !== pin)) { if (P.state) backToStart(""); P.pin = pin; render(); enterPin(); }
    });
  } else if (pin) {
    P.pin = pin;
    render();
    enterPin();
    return;
  }
  render();
  focusInput();
})();
