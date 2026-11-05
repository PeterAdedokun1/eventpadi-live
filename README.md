# Eventpadi Live

Real-time, Kahoot-style games for events: quizzes, polls, fastest-fingers typing races and raffles, mixed in one game. The host runs the game on a projector, and attendees join from their own phones with a 6-digit PIN or a QR code.

- **Supabase** (its own dedicated project, separate from any other Eventpadi data): Postgres holds games, players and answers. All game logic is in Postgres functions. Realtime pushes live updates to every screen.
- **Vercel** hosts the static pages: `/host` (projector) and `/` (phones). There's no build step and no app server.

## Round types

A game is a list of rounds. Attendees join once and play every round with the same PIN.

| Round | What happens | Scored |
|---|---|---|
| Quiz | Multiple choice with one correct answer | 500–1000 for speed, plus a streak bonus |
| Poll | Multiple choice, results shown as a chart | No |
| Fastest fingers | A word appears only on the big screen; players type it on their phones. Capitals, spaces and punctuation are ignored, and a wrong entry can be retried. | 500–1000 for speed |
| Raffle | Names spin on the big screen and random winners are drawn. Earlier raffle winners go to the back of the queue. The host can redraw anyone who isn't in the room. | No |

The final screen shows the podium (when the game has scored rounds) and every raffle winner. The CSV export lists prizes won.

## How it works

```
 Projector (/host)            Supabase                         Phones (/)
 ─────────────────            ────────────────────────────     ──────────
 create_game / host_action ─▶ Postgres functions (RPC) ◀─────  check_pin / join_game /
 host_view                    games · players · answers         submit_answer / player_view
        ▲                     │ realtime.send()                      ▲
        └── host:<token> ◀────┤ broadcast topics ├──▶ game:<id> ─────┘
```

- **The database is the authority.** It validates quizzes, records answer times using database time, scores, and decides phase changes. Phones can't cheat by changing their clock or editing the page.
- **Correct answers are hidden.** They are never sent to phones until the question has closed.
- **Locked down.** Every table has RLS on with no policies. Anonymous visitors (phones) can only call the player and host-token functions (`check_pin`, `join_game`, `player_view`, `submit_answer`, `submit_text`, `leave_game`, `host_view`, `host_action`). Organiser functions (`create_game`, `my_quizzes`, `get_quiz`, `save_quiz`, `delete_quiz`, `my_games`, `game_report`, `forget_game`) need a signed-in account and only ever touch that account's data.
- **Organiser accounts.** Hosts sign up with email and password (Supabase Auth). Games are saved to the account with autosave, and every hosted game keeps a report (players, scores, each round's results, raffle winners) for a year. Each account can run up to 3 live games at once.
- **Timing comes from the server clock.** Every screen syncs to it, so countdowns match across devices. A question closes when its timer ends (the host screen triggers this) or as soon as everyone has answered (the database does it in the last answer).
- **Reconnects.** Refreshing a phone or the host screen resumes the game. Tokens are stored in `localStorage`. If Realtime drops, pages fall back to polling.
- **Cleanup.** A `pg_cron` job closes games idle for 3 h and finished games after 1 h. Reports are kept for 365 days; lobbies that never started are deleted after a day.

Scoring: a correct quiz answer earns 500 to 1000 points depending on speed, plus 100 per consecutive correct answer (up to +500). Fastest fingers earns 500 to 1000 for speed. Polls and raffles are not scored. Fastest-fingers words and raffle winners are never sent to phones while a round is open.

Host controls: kick a player (click their name in the lobby), lock or unlock joining, +10 seconds on an open round, end the question early, end the game, sound on/off, full screen, and a CSV download of results. Space, Enter or → advances from the reveal and scoreboard screens.

Event branding: each game can carry the organiser's colour, logo and a sponsor line. They appear on the projector (top bar, lobby, during rounds, final screen) and on phones (join screen and lobby). Colours too light for white text are darkened automatically to meet WCAG AA contrast. The organiser's dashboard and editor stay in Eventpadi colours.

Engagement:
- **Avatars.** Players pick an emoji avatar when they join; it shows in the lobby, scoreboards, raffle draws and on the podium.
- **Nickname filter.** Offensive nicknames are refused (whole-word match, so real names like "Dickson" are fine).
- **Images.** Quiz and poll questions can have an image, shown on the big screen. Images are shrunk in the browser and stored in the `quiz-images` Storage bucket (organisers can only upload to their own folder).
- **True / False** preset for quiz questions.
- **Sound.** The projector plays lobby music, a thinking loop, countdown ticks, reveal chimes and fanfares, all synthesised in the browser (no audio files). Sound starts after the first click on the page and can be muted.
- **Live reactions.** Phones can send 👏 😂 🔥 😮 ❤️ 🎉 in the lobby and between rounds; they float up the big screen. Reactions go straight to the host over Realtime's HTTP endpoint (phones don't receive each other's), limited to one every 0.8 s per phone.

## Set up and deploy

You need Node 18+ and a Supabase account.

1. **Create the Supabase project and schema**, using a personal access token from https://supabase.com/dashboard/account/tokens:
   ```bash
   npm install
   SUPABASE_ACCESS_TOKEN=sbp_xxx npm run setup
   ```
   This creates a project called `eventpadi-live` (region `eu-west-2`, London, the closest to Lagos), applies `supabase/migrations/*.sql` and writes `public/config.js`. The project ref and keys are saved to `.env.local`; keep that file private.
   To re-apply the schema to the same project later, run the same command again. It reads the project ref from `.env.local`.

2. **Test it against the real project.** The test signs in as an organiser, so create a confirmed test account (Supabase dashboard → Authentication → Add user, with "Auto confirm") and run:
   ```bash
   TEST_HOST_EMAIL=you@example.com TEST_HOST_PASSWORD=... npm test
   ```

3. **Deploy the pages to Vercel:**
   ```bash
   npx vercel deploy --prod
   ```
   Optional: add a short custom domain in Vercel (e.g. `live.eventpadi.com`). Then set `PUBLIC_URL=https://live.eventpadi.com` in `.env.local`, run `npm run setup` again, and redeploy, so the projector and QR code show the short URL.

Local development: `npm run dev`, then open http://localhost:3000/host. It uses the Supabase project in `public/config.js`.

**Email.** Supabase's built-in email sender is limited to a few emails an hour, which is too few for sign-up confirmations and password resets at scale. Before launch, connect your own email provider in Supabase → Authentication → Emails → SMTP settings (for example Resend, Postmark or Amazon SES), and set the sender to an Eventpadi address.

## Capacity

Each phone holds one Supabase Realtime connection. **The Supabase Free plan allows 200 concurrent Realtime connections; Pro allows 500 and can be raised.** For events with more than about 190 players, upgrade the project to Pro before the event. Free projects also pause after a week of inactivity; open the dashboard and restore the project before your event if that happens.

## Files

```
supabase/migrations/…_eventpadi_live.sql   Tables, RLS, game logic functions, broadcasts, cleanup job
public/host.html  + js/host.js             Projector: game editor (autosaved), lobby/QR, rounds, reveal, scoreboard, podium
public/js/dashboard.js                     Organiser sign-in, dashboard, templates, game reports
public/play.html  + js/play.js             Attendee phone
public/js/common.js                        Supabase client, server clock sync, realtime helpers, UI helpers
public/config.js                           Supabase URL and anon key (generated by setup)
public/vendor/                             supabase-js and qrcode-generator browser builds (no CDN needed)
public/css/styles.css                      All styles; brand tokens in :root (--accent: #9B0EED)
scripts/setup-supabase.mjs                 Creates the project, applies SQL, writes config
scripts/dev.js                             Local static server
test/live.mjs                              End-to-end test against the real Supabase project
vercel.json                                Static hosting, routes, security headers
```

## Next steps

- Ideas: images on questions, true/false and type-answer questions, team mode, sounds on the projector, a nickname profanity filter.
