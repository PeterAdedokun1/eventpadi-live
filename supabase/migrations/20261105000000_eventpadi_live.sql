-- Eventpadi Live: real-time quiz game on Supabase.
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

/* ---------------- Internal helpers ---------------- */

create or replace function public._ms(ts timestamptz) returns bigint
language sql immutable as $$ select (extract(epoch from ts) * 1000)::bigint $$;

create or replace function public._clean(v text, max_len int) returns text
language sql immutable as $$
  select btrim(left(btrim(regexp_replace(regexp_replace(coalesce(v, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')), max_len))
$$;

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
begin
  return jsonb_build_object(
    'game_id', g.id, 'pin', g.pin, 'phase', g.phase, 'qi', g.qi, 'total', g.total,
    'title', g.title, 'event', g.event, 'locked', g.locked, 'version', g.version,
    'q_starts_at', public._ms(g.q_starts_at), 'q_ends_at', public._ms(g.q_ends_at),
    'server_now', public._ms(clock_timestamp()),
    'is_last', g.qi = g.total - 1,
    'question', case when q is null or g.phase in ('lobby', 'podium', 'ended') then null else
      jsonb_build_object(
        'type', q ->> 'type', 'text', q ->> 'text', 'options', q -> 'options', 'time', (q ->> 'time')::int,
        'correct', case when g.phase = 'question' then null else q -> 'correct' end)
    end);
end $$;

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

-- Close the current question and score it.
-- Correct answer: 500–1000 points for speed, +100 per consecutive correct answer (max +500). Polls score nothing.
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
  v_correct := (q ->> 'correct')::int;
  v_limit := (q ->> 'time')::int * 1000;

  update public.players p set
    score = p.score + x.points,
    streak = case when v_type <> 'quiz' then p.streak when x.correct then p.streak + 1 else 0 end,
    correct_count = p.correct_count + x.correct::int,
    last = jsonb_build_object('answered', x.choice is not null, 'choice', x.choice, 'correct', x.correct, 'points', x.points)
  from (
    select p2.id, a.choice,
      coalesce(v_type = 'quiz' and a.choice = v_correct, false) as correct,
      case when v_type = 'quiz' and a.choice = v_correct
        then round(1000 * (1 - least(a.ms, v_limit)::numeric / v_limit / 2))::int + least(p2.streak, 5) * 100
        else 0 end as points
    from public.players p2
    left join public.answers a on a.player_id = p2.id and a.qi = g.qi
    where p2.game_id = g.id
  ) x
  where p.id = x.id;

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
    update public.games set phase = 'ended' where id = g.id;
    perform public._bump(g.id);
  end loop;
  delete from public.games where updated_at < now() - interval '2 days';
  delete from public.pin_attempts where minute < now() - interval '10 minutes';
end $$;

/* ---------------- Host API ---------------- */

create or replace function public.create_game(p_quiz jsonb, p_host_key text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_key text;
  v_qs jsonb := '[]'::jsonb;
  v_n int;
  x jsonb;
  v_type text;
  v_text text;
  v_opts jsonb;
  v_correct int;
  v_time int;
  o text;
  v_pin text;
  g public.games;
begin
  select value into v_key from public.settings where key = 'host_key';
  if coalesce(v_key, '') <> '' and v_key is distinct from p_host_key then
    return jsonb_build_object('error', 'Wrong host password.', 'need_key', true);
  end if;
  if (select count(*) from public.games where phase <> 'ended') >= 500 then
    return public._err('The server is busy. Try again in a few minutes.');
  end if;

  if jsonb_typeof(p_quiz -> 'questions') is distinct from 'array' then return public._err('Add at least one question.'); end if;
  v_n := jsonb_array_length(p_quiz -> 'questions');
  if v_n = 0 then return public._err('Add at least one question.'); end if;
  if v_n > 100 then return public._err('A quiz can have at most 100 questions.'); end if;

  for i in 0 .. v_n - 1 loop
    x := p_quiz -> 'questions' -> i;
    v_type := case when x ->> 'type' = 'poll' then 'poll' else 'quiz' end;
    v_text := public._clean(x ->> 'text', 200);
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
      insert into public.games (pin, quiz, title, event, total)
      values (v_pin, jsonb_build_object('questions', v_qs),
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
    v := v || jsonb_build_object('results', coalesce((
      select jsonb_agg(jsonb_build_object('rank', rn, 'name', name, 'score', score, 'correct', correct_count,
                                          'of', (select count(*) from jsonb_array_elements(g.quiz -> 'questions') e where e ->> 'type' = 'quiz'))
                       order by rn)
      from (select *, row_number() over (order by score desc, joined_at) rn from public.players where game_id = g.id) t), '[]'::jsonb));
  end if;
  return v;
end $$;

create or replace function public.host_action(p_game uuid, p_token uuid, p_action text, p_arg jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  v_pid uuid;
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
    perform public._start_question(g.id, 0);

  elsif p_action = 'reveal' then
    perform public._reveal(g.id);  -- no-op unless a question is open

  elsif p_action = 'next' then
    if g.phase = 'question' then
      perform public._reveal(g.id);
    elsif g.phase = 'reveal' and g.quiz -> 'questions' -> g.qi ->> 'type' = 'quiz' then
      update public.games set phase = 'leaderboard' where id = g.id;
      perform public._bump(g.id);
    elsif g.phase in ('reveal', 'leaderboard') then
      if g.qi >= g.total - 1 then
        update public.games set phase = 'podium' where id = g.id;
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

  elsif p_action = 'lock' then
    update public.games set locked = coalesce((p_arg ->> 'locked')::boolean, not locked) where id = g.id;
    perform public._bump(g.id);

  elsif p_action = 'end' then
    update public.games set phase = 'ended' where id = g.id;
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

/* ---------------- Permissions ---------------- */

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.create_game(jsonb, text),
  public.host_view(uuid, uuid),
  public.host_action(uuid, uuid, text, jsonb),
  public.check_pin(text),
  public.join_game(uuid, text),
  public.player_view(uuid, uuid),
  public.submit_answer(uuid, uuid, int, int),
  public.leave_game(uuid, uuid)
to anon, authenticated;

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
