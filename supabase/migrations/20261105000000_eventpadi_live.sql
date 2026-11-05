-- Eventpadi Live: real-time event games on Supabase.
--
-- A game is a list of rounds. Round types:
--   quiz    multiple choice, scored for speed and streaks
--   poll    multiple choice, no right answer
--   type    "fastest fingers": type the word shown on the big screen, scored for speed
--   raffle  draw random winners from the players who joined
--
-- All game logic lives in these functions. Browsers only call the RPCs granted
-- at the bottom; every table has RLS on with no policies, so tables can't be
-- read or written directly with the anon key.
--
-- Live updates use Realtime "broadcast from database" (realtime.send):
--   topic  game:<game id>     event "state"    public game state, every phase change
--                             event "kicked"   { player_id }
--   topic  host:<host token>  event "players"  lobby changed (only the host knows this topic)
--                             event "answered" { answered, players }
-- Correct answers are never sent before the question closes.
--
-- Safe to re-run.

create table if not exists public.settings (
  key   text primary key,
  value text
);

create table if not exists public.games (
  id          uuid primary key default gen_random_uuid(),
  pin         text not null,
  host_token  uuid not null default gen_random_uuid(),
  quiz        jsonb not null,
  title       text not null,
  event       text not null default '',
  total       int  not null,
  phase       text not null default 'lobby'
              check (phase in ('lobby', 'question', 'reveal', 'leaderboard', 'podium', 'ended')),
  locked      boolean not null default false,
  qi          int not null default -1,
  q_starts_at timestamptz,          -- answers open (after the 3 s "get ready" intro)
  q_ends_at   timestamptz,          -- answers close
  version     int not null default 0,
  max_players int not null default 1000,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists games_active_pin on public.games (pin) where phase <> 'ended';
alter table public.games add column if not exists owner      uuid references auth.users (id) on delete cascade;
alter table public.games add column if not exists quiz_id    uuid;
alter table public.games add column if not exists started_at timestamptz;
alter table public.games add column if not exists ended_at   timestamptz;
create index if not exists games_owner on public.games (owner, created_at desc);

-- Games saved by organisers (drafts allowed; validated when a lobby opens).
create table if not exists public.quizzes (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users (id) on delete cascade,
  title      text not null default '',
  event      text not null default '',
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists quizzes_owner on public.quizzes (owner, updated_at desc);

create table if not exists public.players (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references public.games (id) on delete cascade,
  token         uuid not null default gen_random_uuid(),
  name          text not null,
  score         int not null default 0,
  streak        int not null default 0,
  correct_count int not null default 0,
  last          jsonb,
  joined_at     timestamptz not null default clock_timestamp()
);
create unique index if not exists players_game_name on public.players (game_id, lower(name));
create index if not exists players_game_score on public.players (game_id, score desc, joined_at);

create table if not exists public.answers (
  game_id    uuid not null references public.games (id) on delete cascade,
  player_id  uuid not null references public.players (id) on delete cascade,
  qi         int  not null,
  choice     int  not null,
  ms         int  not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (player_id, qi)
);
create index if not exists answers_game_q on public.answers (game_id, qi);

-- Raffle winners. A forfeited winner (not in the room) was replaced by a redraw.
create table if not exists public.winners (
  game_id   uuid not null references public.games (id) on delete cascade,
  qi        int  not null,
  player_id uuid not null references public.players (id) on delete cascade,
  place     int  not null,
  forfeited boolean not null default false,
  primary key (game_id, qi, player_id)
);
create index if not exists winners_game_player on public.winners (game_id, player_id);

create table if not exists public.pin_attempts (
  ip     text not null,
  minute timestamptz not null,
  n      int not null default 0,
  primary key (ip, minute)
);

alter table public.settings     enable row level security;
alter table public.games        enable row level security;
alter table public.players      enable row level security;
alter table public.answers      enable row level security;
alter table public.pin_attempts enable row level security;
alter table public.winners      enable row level security;
alter table public.quizzes      enable row level security;

/* ---------------- Internal helpers ---------------- */

create or replace function public._ms(ts timestamptz) returns bigint
language sql immutable as $$ select (extract(epoch from ts) * 1000)::bigint $$;

create or replace function public._clean(v text, max_len int) returns text
language sql immutable as $$
  select btrim(left(btrim(regexp_replace(regexp_replace(coalesce(v, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')), max_len))
$$;

-- Fastest-fingers comparison: ignore case, spaces and punctuation.
create or replace function public._norm(v text) returns text
language sql immutable as $$ select lower(regexp_replace(coalesce(v, ''), '[^[:alnum:]]', '', 'g')) $$;

create or replace function public._err(msg text) returns jsonb
language sql immutable as $$ select jsonb_build_object('error', msg) $$;

create or replace function public._send(p_topic text, p_event text, p_payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform realtime.send(p_payload, p_event, p_topic, false);
exception when others then
  raise warning 'realtime.send failed: %', sqlerrm;
end $$;

create or replace function public._public_state(g public.games) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  q jsonb := case when g.qi >= 0 and g.qi < g.total then g.quiz -> 'questions' -> g.qi end;
  open boolean := g.phase = 'question';
begin
  -- Never send a correct answer, a fastest-fingers word or raffle winners while a round is open.
  return jsonb_build_object(
    'game_id', g.id, 'pin', g.pin, 'phase', g.phase, 'qi', g.qi, 'total', g.total,
    'title', g.title, 'event', g.event, 'locked', g.locked, 'version', g.version,
    'q_starts_at', public._ms(g.q_starts_at), 'q_ends_at', public._ms(g.q_ends_at),
    'server_now', public._ms(clock_timestamp()),
    'is_last', g.qi = g.total - 1,
    'question', case when q is null or g.phase in ('lobby', 'podium', 'ended') then null else
      jsonb_build_object(
        'type', q ->> 'type', 'text', q ->> 'text', 'options', q -> 'options', 'time', (q ->> 'time')::int,
        'winners', (q ->> 'winners')::int,
        'correct', case when open then null else q -> 'correct' end,
        'answer', case when open then null else q -> 'answer' end,
        'drawn', case when open or q ->> 'type' <> 'raffle' then null else coalesce((
          select jsonb_agg(p.name order by w.place)
          from public.winners w join public.players p on p.id = w.player_id
          where w.game_id = g.id and w.qi = g.qi and not w.forfeited), '[]'::jsonb) end)
    end);
end $$;

-- Number of rounds that score points (quiz and fastest fingers).
create or replace function public._scored_rounds(g public.games) returns int
language sql immutable as $$
  select count(*)::int from jsonb_array_elements(g.quiz -> 'questions') e where e ->> 'type' in ('quiz', 'type')
$$;

-- Bump the version and broadcast the new public state.
create or replace function public._bump(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g public.games;
begin
  update public.games set version = version + 1, updated_at = now() where id = p_game returning * into g;
  perform public._send('game:' || g.id, 'state', public._public_state(g));
end $$;

create or replace function public._start_question(p_game uuid, p_qi int) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.games set
    phase = 'question',
    qi = p_qi,
    q_starts_at = clock_timestamp() + interval '3 seconds',
    q_ends_at   = clock_timestamp() + interval '3 seconds'
                  + make_interval(secs => (quiz -> 'questions' -> p_qi ->> 'time')::int)
  where id = p_game;
  perform public._bump(p_game);
end $$;

-- Raffle: record each player's personal result for the current round.
create or replace function public._raffle_results(p_game uuid, p_qi int) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.players p set last = jsonb_build_object('raffle', true, 'won', w.place is not null, 'place', w.place)
  from public.players p2
  left join public.winners w on w.player_id = p2.id and w.game_id = p_game and w.qi = p_qi and not w.forfeited
  where p2.game_id = p_game and p.id = p2.id;
end $$;

-- Close the current round and score it.
--   quiz: correct answer earns 500–1000 points for speed, +100 per consecutive correct answer (max +500)
--   type: typing the word earns 500–1000 points for speed (only correct entries are stored)
--   poll: no points.  raffle: draw the winners now.
create or replace function public._reveal(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  q jsonb;
  v_type text;
  v_correct int;
  v_limit int;
begin
  select * into g from public.games where id = p_game;
  if g.phase <> 'question' then return; end if;
  q := g.quiz -> 'questions' -> g.qi;
  v_type := q ->> 'type';

  if v_type = 'raffle' then
    -- Random draw. People who already won a raffle in this game go to the back of the queue.
    insert into public.winners (game_id, qi, player_id, place)
    select g.id, g.qi, t.id, row_number() over (order by t.won, t.r)
    from (
      select p.id, random() as r,
             exists (select 1 from public.winners w where w.game_id = g.id and w.player_id = p.id and not w.forfeited) as won
      from public.players p where p.game_id = g.id
      order by won, r
      limit greatest(1, coalesce((q ->> 'winners')::int, 1))
    ) t
    on conflict do nothing;
    perform public._raffle_results(g.id, g.qi);
    update public.games set phase = 'reveal' where id = g.id;
    perform public._bump(g.id);
    return;
  end if;

  v_correct := (q ->> 'correct')::int;
  v_limit := (q ->> 'time')::int * 1000;

  with a as (
    select player_id, choice, ms, rank() over (order by ms) as place
    from public.answers where game_id = g.id and qi = g.qi
  ), x as (
    select p2.id, a.choice, a.ms, a.place, p2.streak,
      coalesce(case v_type when 'quiz' then a.choice = v_correct when 'type' then a.choice is not null else false end, false) as correct
    from public.players p2
    left join a on a.player_id = p2.id
    where p2.game_id = g.id
  ), y as (
    select x.*,
      case when x.correct
        then round(1000 * (1 - least(x.ms, v_limit)::numeric / v_limit / 2))::int
             + case when v_type = 'quiz' then least(x.streak, 5) * 100 else 0 end
        else 0 end as points
    from x
  )
  update public.players p set
    score = p.score + y.points,
    streak = case when v_type <> 'quiz' then p.streak when y.correct then p.streak + 1 else 0 end,
    correct_count = p.correct_count + y.correct::int,
    last = jsonb_build_object('answered', y.choice is not null, 'choice', y.choice, 'correct', y.correct, 'points', y.points,
                              'ms', case when v_type = 'type' then y.ms end,
                              'place', case when v_type = 'type' then y.place end)
  from y
  where p.id = y.id;

  update public.games set phase = 'reveal' where id = g.id;
  perform public._bump(g.id);
end $$;

create or replace function public._cleanup() returns void
language plpgsql security definer set search_path = public as $$
declare g public.games;
begin
  for g in
    select * from public.games
    where phase <> 'ended'
      and (updated_at < now() - interval '3 hours'
           or (phase = 'podium' and updated_at < now() - interval '1 hour'))
  loop
    update public.games set phase = 'ended', ended_at = coalesce(ended_at, now()) where id = g.id;
    perform public._bump(g.id);
  end loop;
  -- Organisers keep their game history (reports) for a year; games with no owner go after 2 days.
  delete from public.games where owner is null and updated_at < now() - interval '2 days';
  delete from public.games where updated_at < now() - interval '365 days';
  -- Lobbies that never started are not worth keeping.
  delete from public.games where phase = 'ended' and started_at is null and updated_at < now() - interval '1 day';
  delete from public.pin_attempts where minute < now() - interval '10 minutes';
end $$;

/* ---------------- Host API ---------------- */

drop function if exists public.create_game(jsonb, text);
create or replace function public.create_game(p_quiz jsonb, p_quiz_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_qs jsonb := '[]'::jsonb;
  v_n int;
  x jsonb;
  v_type text;
  v_text text;
  v_opts jsonb;
  v_correct int;
  v_time int;
  v_word text;
  o text;
  v_pin text;
  g public.games;
begin
  if v_uid is null then return jsonb_build_object('error', 'Please sign in to host a game.', 'auth', true); end if;
  -- Per-organiser limit: a few live games at once (e.g. two rooms), so one account can't exhaust capacity.
  if (select count(*) from public.games where owner = v_uid and phase <> 'ended') >= 3 then
    return public._err('You already have 3 live games. End one before opening another.');
  end if;
  if (select count(*) from public.games where phase <> 'ended') >= 500 then
    return public._err('The server is busy. Try again in a few minutes.');
  end if;

  if jsonb_typeof(p_quiz -> 'questions') is distinct from 'array' then return public._err('Add at least one round.'); end if;
  v_n := jsonb_array_length(p_quiz -> 'questions');
  if v_n = 0 then return public._err('Add at least one round.'); end if;
  if v_n > 100 then return public._err('A game can have at most 100 rounds.'); end if;

  for i in 0 .. v_n - 1 loop
    x := p_quiz -> 'questions' -> i;
    v_type := case when x ->> 'type' in ('poll', 'type', 'raffle') then x ->> 'type' else 'quiz' end;
    v_text := public._clean(x ->> 'text', 200);

    if v_type = 'type' then
      v_word := public._clean(x ->> 'answer', 40);
      if public._norm(v_word) = '' then
        return jsonb_build_object('error', format('Round %s: enter the word or phrase players must type.', i + 1), 'index', i);
      end if;
      v_time := case when x ->> 'time' in ('10', '15', '20', '30', '45', '60', '90', '120') then (x ->> 'time')::int else 30 end;
      v_qs := v_qs || jsonb_build_object('type', 'type', 'text', coalesce(nullif(v_text, ''), 'Type the word on the big screen'),
                                         'options', '[]'::jsonb, 'answer', v_word, 'norm', public._norm(v_word), 'time', v_time);
      continue;
    elsif v_type = 'raffle' then
      if v_text = '' then
        return jsonb_build_object('error', format('Round %s: what is the raffle prize?', i + 1), 'index', i);
      end if;
      v_qs := v_qs || jsonb_build_object('type', 'raffle', 'text', v_text, 'options', '[]'::jsonb, 'time', 6,
                                         'winners', case when x ->> 'winners' ~ '^\d{1,2}$'
                                                         then least(20, greatest(1, (x ->> 'winners')::int)) else 1 end);
      continue;
    end if;

    if v_text = '' then
      return jsonb_build_object('error', format('Question %s needs some text.', i + 1), 'index', i);
    end if;
    v_opts := '[]'::jsonb;
    v_correct := null;
    if jsonb_typeof(x -> 'options') = 'array' then
      for j in 0 .. least(3, jsonb_array_length(x -> 'options') - 1) loop
        o := public._clean(x -> 'options' ->> j, 80);
        if o <> '' then
          if v_type = 'quiz' and x ->> 'correct' = j::text then v_correct := jsonb_array_length(v_opts); end if;
          v_opts := v_opts || to_jsonb(o);
        end if;
      end loop;
    end if;
    if jsonb_array_length(v_opts) < 2 then
      return jsonb_build_object('error', format('Question %s needs at least two answers.', i + 1), 'index', i);
    end if;
    if v_type = 'quiz' and v_correct is null then
      return jsonb_build_object('error', format('Question %s: tick a correct answer that isn''t blank.', i + 1), 'index', i);
    end if;
    v_time := case when x ->> 'time' in ('5', '10', '15', '20', '30', '45', '60', '90', '120') then (x ->> 'time')::int else 20 end;
    v_qs := v_qs || jsonb_build_object('type', v_type, 'text', v_text, 'options', v_opts, 'correct', v_correct, 'time', v_time);
  end loop;

  for attempt in 1 .. 50 loop
    v_pin := (100000 + floor(random() * 900000))::int::text;
    begin
      insert into public.games (owner, quiz_id, pin, quiz, title, event, total)
      values (v_uid, p_quiz_id, v_pin, jsonb_build_object('questions', v_qs),
              coalesce(nullif(public._clean(p_quiz ->> 'title', 80), ''), 'Live quiz'),
              public._clean(p_quiz ->> 'event', 80), v_n)
      returning * into g;
      exit;
    exception when unique_violation then
      g := null;
    end;
  end loop;
  if g.id is null then return public._err('Couldn''t create a game PIN. Try again.'); end if;

  return jsonb_build_object('game_id', g.id, 'pin', g.pin, 'host_token', g.host_token, 'server_now', public._ms(clock_timestamp()));
end $$;

create or replace function public.host_view(p_game uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  v jsonb;
  q jsonb;
begin
  select * into g from public.games where id = p_game and host_token = p_token;
  if not found or g.phase = 'ended' then return public._err('That game has ended.'); end if;
  q := g.quiz -> 'questions' -> g.qi;
  v := public._public_state(g) || jsonb_build_object(
    'player_count', (select count(*) from public.players where game_id = g.id),
    'answered', (select count(*) from public.answers where game_id = g.id and qi = g.qi));

  if g.phase = 'lobby' then
    v := v || jsonb_build_object('players', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by joined_at)
      from public.players where game_id = g.id), '[]'::jsonb));
  elsif g.phase = 'question' and q ->> 'type' = 'type' then
    v := v || jsonb_build_object('word', q ->> 'answer');   -- shown only on the big screen
  elsif g.phase = 'question' and q ->> 'type' = 'raffle' then
    v := v || jsonb_build_object('pool', coalesce((         -- names for the spinning draw animation
      select jsonb_agg(name) from (select name from public.players where game_id = g.id order by random() limit 60) t), '[]'::jsonb));
  elsif g.phase = 'reveal' and q ->> 'type' = 'type' then
    v := v || jsonb_build_object('fastest', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'ms', a.ms) order by a.ms, a.created_at)
      from (select * from public.answers where game_id = g.id and qi = g.qi order by ms, created_at limit 10) a
      join public.players p on p.id = a.player_id), '[]'::jsonb));
  elsif g.phase = 'reveal' and q ->> 'type' = 'raffle' then
    v := v || jsonb_build_object(
      'winner_list', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'place', w.place) order by w.place)
        from public.winners w join public.players p on p.id = w.player_id
        where w.game_id = g.id and w.qi = g.qi and not w.forfeited), '[]'::jsonb),
      'can_redraw', exists (
        select 1 from public.players p where p.game_id = g.id
          and not exists (select 1 from public.winners w where w.game_id = g.id and w.qi = g.qi and w.player_id = p.id)));
  elsif g.phase = 'reveal' then
    v := v || jsonb_build_object('counts', (
      select jsonb_agg(coalesce(c.n, 0) order by i)
      from generate_series(0, jsonb_array_length(q -> 'options') - 1) i
      left join (select choice, count(*) n from public.answers where game_id = g.id and qi = g.qi group by choice) c
        on c.choice = i));
  elsif g.phase = 'leaderboard' then
    v := v || jsonb_build_object('leaderboard', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'score', score, 'streak', streak,
                                          'delta', coalesce((last ->> 'points')::int, 0)) order by score desc, joined_at)
      from (select * from public.players where game_id = g.id order by score desc, joined_at limit 5) t), '[]'::jsonb));
  elsif g.phase = 'podium' then
    v := v || jsonb_build_object(
      'scored', public._scored_rounds(g),
      'results', coalesce((
        select jsonb_agg(jsonb_build_object('rank', rn, 'name', name, 'score', score, 'correct', correct_count,
                                            'of', public._scored_rounds(g), 'prizes', prizes)
                         order by rn)
        from (select t.*, row_number() over (order by score desc, joined_at) rn,
                     (select coalesce(jsonb_agg(g.quiz -> 'questions' -> w.qi ->> 'text' order by w.qi), '[]'::jsonb)
                      from public.winners w where w.game_id = g.id and w.player_id = t.id and not w.forfeited) prizes
              from public.players t where t.game_id = g.id) t), '[]'::jsonb),
      'raffles', coalesce((
        select jsonb_agg(jsonb_build_object('prize', g.quiz -> 'questions' -> r.qi ->> 'text', 'winners', r.names) order by r.qi)
        from (select w.qi, jsonb_agg(p.name order by w.place) names
              from public.winners w join public.players p on p.id = w.player_id
              where w.game_id = g.id and not w.forfeited group by w.qi) r), '[]'::jsonb));
  end if;
  return v;
end $$;

create or replace function public.host_action(p_game uuid, p_token uuid, p_action text, p_arg jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  v_pid uuid;
  v_new uuid;
  v_place int;
begin
  select * into g from public.games where id = p_game and host_token = p_token for update;
  if not found then return public._err('You''re not hosting this game.'); end if;
  if g.phase = 'ended' then return public._err('That game has ended.'); end if;

  if p_action = 'start' then
    if g.phase <> 'lobby' then return public._err('The game has already started.'); end if;
    if not exists (select 1 from public.players where game_id = g.id) then
      return public._err('Wait for at least one player to join.');
    end if;
    update public.players set score = 0, streak = 0, correct_count = 0, last = null where game_id = g.id;
    update public.games set started_at = now() where id = g.id;
    perform public._start_question(g.id, 0);

  elsif p_action = 'reveal' then
    perform public._reveal(g.id);  -- no-op unless a question is open

  elsif p_action = 'next' then
    if g.phase = 'question' then
      perform public._reveal(g.id);
    elsif g.phase = 'reveal' and g.quiz -> 'questions' -> g.qi ->> 'type' in ('quiz', 'type') then
      update public.games set phase = 'leaderboard' where id = g.id;
      perform public._bump(g.id);
    elsif g.phase in ('reveal', 'leaderboard') then
      if g.qi >= g.total - 1 then
        update public.games set phase = 'podium', ended_at = now() where id = g.id;
        perform public._bump(g.id);
      else
        perform public._start_question(g.id, g.qi + 1);
      end if;
    end if;

  elsif p_action = 'kick' then
    v_pid := (p_arg ->> 'player_id')::uuid;
    delete from public.players where id = v_pid and game_id = g.id;
    if found then
      perform public._send('game:' || g.id, 'kicked', jsonb_build_object('player_id', v_pid));
      perform public._send('host:' || g.host_token, 'players', '{}'::jsonb);
    end if;

  elsif p_action = 'redraw' then
    -- Replace a raffle winner who isn't in the room with a new random winner.
    if g.phase <> 'reveal' or g.quiz -> 'questions' -> g.qi ->> 'type' <> 'raffle' then
      return public._err('You can only redraw while showing raffle winners.');
    end if;
    v_pid := (p_arg ->> 'player_id')::uuid;
    select place into v_place from public.winners
    where game_id = g.id and qi = g.qi and player_id = v_pid and not forfeited;
    if not found then return public._err('That person isn''t a current winner.'); end if;
    -- Prefer people who haven't won anything in this game yet.
    select p.id into v_new from public.players p
    where p.game_id = g.id
      and not exists (select 1 from public.winners w where w.game_id = g.id and w.qi = g.qi and w.player_id = p.id)
    order by exists (select 1 from public.winners w where w.game_id = g.id and w.player_id = p.id and not w.forfeited), random()
    limit 1;
    if v_new is null then return public._err('There''s no one left to draw.'); end if;
    update public.winners set forfeited = true where game_id = g.id and qi = g.qi and player_id = v_pid;
    insert into public.winners (game_id, qi, player_id, place) values (g.id, g.qi, v_new, v_place);
    perform public._raffle_results(g.id, g.qi);
    perform public._bump(g.id);

  elsif p_action = 'lock' then
    update public.games set locked = coalesce((p_arg ->> 'locked')::boolean, not locked) where id = g.id;
    perform public._bump(g.id);

  elsif p_action = 'end' then
    update public.games set phase = 'ended', ended_at = coalesce(ended_at, now()) where id = g.id;
    perform public._bump(g.id);

  else
    return public._err('Unknown action.');
  end if;

  return jsonb_build_object('ok', true, 'server_now', public._ms(clock_timestamp()));
end $$;

/* ---------------- Player API ---------------- */

create or replace function public.check_pin(p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_headers jsonb := nullif(current_setting('request.headers', true), '')::jsonb;
  v_ip text := coalesce(nullif(v_headers ->> 'cf-connecting-ip', ''),
                        nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
                        'unknown');
  v_min timestamptz := date_trunc('minute', now());
  v_fails int;
  g public.games;
begin
  -- Limit failed guesses per IP. Generous, because a whole venue can share one Wi-Fi IP.
  select n into v_fails from public.pin_attempts where ip = v_ip and minute = v_min;
  if coalesce(v_fails, 0) >= 60 then return public._err('Too many attempts. Wait a minute and try again.'); end if;

  select * into g from public.games where pin = regexp_replace(coalesce(p_pin, ''), '\D', '', 'g') and phase <> 'ended';
  if not found then
    insert into public.pin_attempts (ip, minute, n) values (v_ip, v_min, 1)
    on conflict (ip, minute) do update set n = public.pin_attempts.n + 1;
    return public._err('We couldn''t find a game with that PIN. Check the big screen.');
  end if;
  if g.phase = 'podium' then return public._err('This game has finished.'); end if;
  if g.locked then return public._err('The host has locked this game.'); end if;
  return jsonb_build_object('ok', true, 'game_id', g.id, 'title', g.title, 'event', g.event);
end $$;

create or replace function public.join_game(p_game uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  p public.players;
  v_name text := public._clean(p_name, 15);
begin
  select * into g from public.games where id = p_game;
  if not found or g.phase = 'ended' then return public._err('That game has ended.'); end if;
  if g.phase = 'podium' then return public._err('This game has finished.'); end if;
  if g.locked then return public._err('The host has locked this game.'); end if;
  if v_name = '' then return public._err('Enter a nickname to join.'); end if;
  if (select count(*) from public.players where game_id = g.id) >= g.max_players then
    return public._err('This game is full.');
  end if;
  begin
    insert into public.players (game_id, name) values (g.id, v_name) returning * into p;
  exception when unique_violation then
    return public._err('Someone already has that name. Try another.');
  end;
  perform public._send('host:' || g.host_token, 'players', '{}'::jsonb);
  return jsonb_build_object('game_id', g.id, 'player_id', p.id, 'token', p.token, 'server_now', public._ms(clock_timestamp()));
end $$;

create or replace function public.player_view(p_player uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.players;
  g public.games;
  v jsonb;
  v_rank int;
  a record;
begin
  select * into p from public.players where id = p_player and token = p_token;
  if not found then return public._err('You''re no longer in that game.'); end if;
  select * into g from public.games where id = p.game_id;
  if g.phase = 'ended' then return public._err('That game has ended.'); end if;

  v_rank := 1 + (select count(*) from public.players
                 where game_id = g.id and (score > p.score or (score = p.score and joined_at < p.joined_at)));
  v := public._public_state(g) || jsonb_build_object(
    'me', jsonb_build_object('id', p.id, 'name', p.name, 'score', p.score, 'streak', p.streak, 'rank', v_rank),
    'my_answer', (select choice from public.answers where player_id = p.id and qi = g.qi));

  if g.phase = 'reveal' then
    v := v || jsonb_build_object('result', coalesce(p.last, '{"answered": false, "correct": false, "points": 0}'::jsonb));
  end if;
  if g.phase = 'podium' then
    v := v || jsonb_build_object('scored', public._scored_rounds(g), 'my_prizes', (
      select coalesce(jsonb_agg(g.quiz -> 'questions' -> w.qi ->> 'text' order by w.qi), '[]'::jsonb)
      from public.winners w where w.game_id = g.id and w.player_id = p.id and not w.forfeited));
  end if;
  if v_rank > 1 and g.phase in ('reveal', 'leaderboard', 'podium') then
    select name, score into a from public.players
    where game_id = g.id and (score > p.score or (score = p.score and joined_at < p.joined_at))
    order by score, joined_at desc limit 1;
    v := v || jsonb_build_object('ahead', jsonb_build_object('name', a.name, 'gap', a.score - p.score));
  end if;
  return v;
end $$;

create or replace function public.submit_answer(p_player uuid, p_token uuid, p_qi int, p_choice int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.players;
  g public.games;
  t timestamptz := clock_timestamp();
  v_limit int;
  v_ms int;
  v_answered int;
  v_players int;
begin
  select * into p from public.players where id = p_player and token = p_token;
  if not found then return public._err('You''re not in this game.'); end if;
  select * into g from public.games where id = p.game_id for update;
  if g.phase <> 'question' or g.qi <> p_qi then return public._err('Too late, this question has closed.'); end if;
  if t < g.q_starts_at - interval '250 milliseconds' then return public._err('Wait for the question to open.'); end if;
  if t > g.q_ends_at + interval '500 milliseconds' then return public._err('Too late, this question has closed.'); end if;
  if p_choice is null or p_choice < 0 or p_choice >= jsonb_array_length(g.quiz -> 'questions' -> g.qi -> 'options') then
    return public._err('That''s not a valid answer.');
  end if;

  v_limit := (g.quiz -> 'questions' -> g.qi ->> 'time')::int * 1000;
  v_ms := greatest(0, least(v_limit, (extract(epoch from (t - g.q_starts_at)) * 1000)::int));
  insert into public.answers (game_id, player_id, qi, choice, ms) values (g.id, p.id, g.qi, p_choice, v_ms)
  on conflict do nothing;
  if not found then return public._err('You''ve already answered.'); end if;

  select count(*) into v_answered from public.answers where game_id = g.id and qi = g.qi;
  select count(*) into v_players from public.players where game_id = g.id;
  if v_answered >= v_players then
    perform public._reveal(g.id);  -- everyone has answered: close the question now
  else
    perform public._send('host:' || g.host_token, 'answered', jsonb_build_object('answered', v_answered, 'players', v_players));
  end if;
  return jsonb_build_object('ok', true, 'server_now', public._ms(clock_timestamp()));
end $$;

-- Fastest fingers: only a correct entry is stored; a wrong one just says "try again".
create or replace function public.submit_text(p_player uuid, p_token uuid, p_qi int, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.players;
  g public.games;
  q jsonb;
  t timestamptz := clock_timestamp();
  v_limit int;
  v_ms int;
  v_answered int;
  v_players int;
begin
  select * into p from public.players where id = p_player and token = p_token;
  if not found then return public._err('You''re not in this game.'); end if;
  select * into g from public.games where id = p.game_id for update;
  if g.phase <> 'question' or g.qi <> p_qi then return public._err('Too late, this round has closed.'); end if;
  q := g.quiz -> 'questions' -> g.qi;
  if q ->> 'type' <> 'type' then return public._err('This round doesn''t take typed answers.'); end if;
  if t < g.q_starts_at - interval '250 milliseconds' then return public._err('Wait for the round to start.'); end if;
  if t > g.q_ends_at + interval '500 milliseconds' then return public._err('Too late, this round has closed.'); end if;
  if exists (select 1 from public.answers where player_id = p.id and qi = g.qi) then
    return public._err('You''ve already got this one.');
  end if;

  if public._norm(left(p_text, 200)) <> q ->> 'norm' then
    return jsonb_build_object('ok', false, 'wrong', true, 'server_now', public._ms(clock_timestamp()));
  end if;

  v_limit := (q ->> 'time')::int * 1000;
  v_ms := greatest(0, least(v_limit, (extract(epoch from (t - g.q_starts_at)) * 1000)::int));
  insert into public.answers (game_id, player_id, qi, choice, ms) values (g.id, p.id, g.qi, 0, v_ms)
  on conflict do nothing;

  select count(*) into v_answered from public.answers where game_id = g.id and qi = g.qi;
  select count(*) into v_players from public.players where game_id = g.id;
  if v_answered >= v_players then
    perform public._reveal(g.id);  -- everyone has typed it: close the round now
  else
    perform public._send('host:' || g.host_token, 'answered', jsonb_build_object('answered', v_answered, 'players', v_players));
  end if;
  return jsonb_build_object('ok', true, 'ms', v_ms, 'server_now', public._ms(clock_timestamp()));
end $$;

create or replace function public.leave_game(p_player uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.games;
begin
  select gm.* into g from public.games gm join public.players p on p.game_id = gm.id
  where p.id = p_player and p.token = p_token;
  if found and g.phase = 'lobby' then
    delete from public.players where id = p_player;
    perform public._send('host:' || g.host_token, 'players', '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true);
end $$;

/* ---------------- Organiser API (signed in) ---------------- */

-- Saved games, newest first. "types" lists the round types for the card badges.
create or replace function public.my_quizzes() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('error', 'Please sign in.', 'auth', true); end if;
  return jsonb_build_object('quizzes', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id, 'title', q.title, 'event', q.event, 'updated_at', public._ms(q.updated_at),
      'rounds', coalesce(jsonb_array_length(q.data -> 'questions'), 0),
      'types', (select coalesce(jsonb_agg(distinct e ->> 'type'), '[]'::jsonb) from jsonb_array_elements(q.data -> 'questions') e),
      'played', (select count(*) from public.games g where g.quiz_id = q.id and g.started_at is not null))
      order by q.updated_at desc)
    from public.quizzes q where q.owner = v_uid), '[]'::jsonb));
end $$;

create or replace function public.get_quiz(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q public.quizzes;
begin
  if auth.uid() is null then return jsonb_build_object('error', 'Please sign in.', 'auth', true); end if;
  select * into q from public.quizzes where id = p_id and owner = auth.uid();
  if not found then return public._err('That game wasn''t found.'); end if;
  return q.data || jsonb_build_object('id', q.id, 'title', q.title, 'event', q.event, 'updated_at', public._ms(q.updated_at));
end $$;

-- Create (p_id null) or update a saved game. Drafts may be incomplete.
create or replace function public.save_quiz(p_id uuid, p_quiz jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_data jsonb;
  q public.quizzes;
begin
  if v_uid is null then return jsonb_build_object('error', 'Please sign in.', 'auth', true); end if;
  if jsonb_typeof(p_quiz -> 'questions') is distinct from 'array' then return public._err('That isn''t a valid game.'); end if;
  if jsonb_array_length(p_quiz -> 'questions') > 100 then return public._err('A game can have at most 100 rounds.'); end if;
  v_data := p_quiz - 'id' - 'title' - 'event' - 'updated_at' - 'savedAt';
  if octet_length(v_data::text) > 300000 then return public._err('This game is too large to save.'); end if;

  if p_id is not null then
    update public.quizzes set data = v_data, updated_at = now(),
      title = public._clean(p_quiz ->> 'title', 80), event = public._clean(p_quiz ->> 'event', 80)
    where id = p_id and owner = v_uid
    returning * into q;
  end if;
  if q.id is null then
    if (select count(*) from public.quizzes where owner = v_uid) >= 300 then
      return public._err('You can save up to 300 games. Delete some old ones first.');
    end if;
    insert into public.quizzes (owner, title, event, data)
    values (v_uid, public._clean(p_quiz ->> 'title', 80), public._clean(p_quiz ->> 'event', 80), v_data)
    returning * into q;
  end if;
  return jsonb_build_object('ok', true, 'id', q.id, 'updated_at', public._ms(q.updated_at));
end $$;

create or replace function public.delete_quiz(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('error', 'Please sign in.', 'auth', true); end if;
  delete from public.quizzes where id = p_id and owner = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- Games this organiser has hosted: live ones (to resume) and finished ones (for reports).
create or replace function public.my_games(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('error', 'Please sign in.', 'auth', true); end if;
  return jsonb_build_object('games', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', g.id, 'title', g.title, 'event', g.event, 'pin', g.pin, 'phase', g.phase, 'rounds', g.total,
      'created_at', public._ms(g.created_at), 'started_at', public._ms(g.started_at), 'ended_at', public._ms(g.ended_at),
      'players', (select count(*) from public.players p where p.game_id = g.id),
      'host_token', case when g.phase <> 'ended' then g.host_token end)
      order by g.created_at desc)
    from (select * from public.games where owner = v_uid and (started_at is not null or phase <> 'ended')
          order by created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) g), '[]'::jsonb));
end $$;

-- Full report of one hosted game: every round's results and the final standings.
create or replace function public.game_report(p_game uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  q jsonb;
  v_rounds jsonb := '[]'::jsonb;
  v_r jsonb;
  v_type text;
begin
  if auth.uid() is null then return jsonb_build_object('error', 'Please sign in.', 'auth', true); end if;
  select * into g from public.games where id = p_game and owner = auth.uid();
  if not found then return public._err('That game wasn''t found.'); end if;

  for i in 0 .. g.total - 1 loop
    q := g.quiz -> 'questions' -> i;
    v_type := q ->> 'type';
    v_r := jsonb_build_object('i', i, 'type', v_type, 'text', q ->> 'text', 'played', i <= g.qi,
      'answered', (select count(*) from public.answers a where a.game_id = g.id and a.qi = i));
    if v_type in ('quiz', 'poll') then
      v_r := v_r || jsonb_build_object('options', q -> 'options', 'correct', q -> 'correct', 'counts', (
        select jsonb_agg(coalesce(c.n, 0) order by k)
        from generate_series(0, jsonb_array_length(q -> 'options') - 1) k
        left join (select choice, count(*) n from public.answers where game_id = g.id and qi = i group by choice) c on c.choice = k));
      if v_type = 'quiz' then
        v_r := v_r || jsonb_build_object('avg_ms', (select round(avg(ms)) from public.answers
                                                   where game_id = g.id and qi = i and choice = (q ->> 'correct')::int));
      end if;
    elsif v_type = 'type' then
      v_r := v_r || jsonb_build_object('answer', q ->> 'answer', 'fastest', coalesce((
        select jsonb_agg(jsonb_build_object('name', p.name, 'ms', a.ms) order by a.ms)
        from (select * from public.answers where game_id = g.id and qi = i order by ms limit 5) a
        join public.players p on p.id = a.player_id), '[]'::jsonb));
    elsif v_type = 'raffle' then
      v_r := v_r || jsonb_build_object('winners', coalesce((
        select jsonb_agg(p.name order by w.place)
        from public.winners w join public.players p on p.id = w.player_id
        where w.game_id = g.id and w.qi = i and not w.forfeited), '[]'::jsonb));
    end if;
    v_rounds := v_rounds || v_r;
  end loop;

  return jsonb_build_object(
    'game', jsonb_build_object('id', g.id, 'title', g.title, 'event', g.event, 'pin', g.pin, 'phase', g.phase,
      'rounds', g.total, 'played', greatest(g.qi + 1, 0), 'scored', public._scored_rounds(g),
      'created_at', public._ms(g.created_at), 'started_at', public._ms(g.started_at), 'ended_at', public._ms(g.ended_at)),
    'rounds', v_rounds,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('rank', rn, 'name', name, 'score', score, 'correct', correct_count,
                                          'joined_at', public._ms(joined_at), 'prizes', prizes) order by rn)
      from (select t.*, row_number() over (order by score desc, joined_at) rn,
                   (select coalesce(jsonb_agg(g.quiz -> 'questions' -> w.qi ->> 'text' order by w.qi), '[]'::jsonb)
                    from public.winners w where w.game_id = g.id and w.player_id = t.id and not w.forfeited) prizes
            from public.players t where t.game_id = g.id) x), '[]'::jsonb));
end $$;

-- Remove a finished game (and its players' data) from the organiser's history.
create or replace function public.forget_game(p_game uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('error', 'Please sign in.', 'auth', true); end if;
  delete from public.games where id = p_game and owner = auth.uid() and phase = 'ended';
  if not found then return public._err('Only finished games can be deleted.'); end if;
  return jsonb_build_object('ok', true);
end $$;

/* ---------------- Permissions ---------------- */

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.host_view(uuid, uuid),
  public.host_action(uuid, uuid, text, jsonb),
  public.check_pin(text),
  public.join_game(uuid, text),
  public.player_view(uuid, uuid),
  public.submit_answer(uuid, uuid, int, int),
  public.submit_text(uuid, uuid, int, text),
  public.leave_game(uuid, uuid)
to anon, authenticated;
grant execute on function
  public.create_game(jsonb, uuid),
  public.my_quizzes(),
  public.get_quiz(uuid),
  public.save_quiz(uuid, jsonb),
  public.delete_quiz(uuid),
  public.my_games(int),
  public.game_report(uuid),
  public.forget_game(uuid)
to authenticated;

/* ---------------- Scheduled cleanup (pg_cron) ---------------- */
do $outer$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('eventpadi-live-cleanup', '*/10 * * * *', 'select public._cleanup()');
exception when others then
  raise notice 'pg_cron unavailable, skipping cleanup schedule: %', sqlerrm;
end
$outer$;

notify pgrst, 'reload schema';
