// End-to-end test of single sign-on from Eventpadi (the sso Edge Function).
//   node test/sso.mjs        (reads .env.local; needs EVENTPADI_SSO_SECRET and SUPABASE_ACCESS_TOKEN)
import fs from "fs";
import crypto from "crypto";
import assert from "assert/strict";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const SECRET = env.EVENTPADI_SSO_SECRET;
assert.ok(SECRET, "EVENTPADI_SSO_SECRET missing: run npm run setup first");

// The same thing Eventpadi's backend does: an HS256 JWT signed with the shared secret.
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function pass(claims, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: "eventpadi-live", iat: now, exp: now + 60, jti: crypto.randomUUID(), ...claims };
  const head = b64({ alg: "HS256", typ: "JWT" }) + "." + b64(body);
  return head + "." + crypto.createHmac("sha256", secret).update(head).digest("base64url");
}
const exchange = async (token) => {
  const r = await fetch(`${env.SUPABASE_URL}/functions/v1/sso`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ token })
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const asUser = async (session) => {
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await sb.auth.setSession(session);
  return sb;
};

// Service key, only to clean up the test users afterwards.
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
const admin = createClient(env.SUPABASE_URL, keys.find((k) => k.name === "service_role").api_key, { auth: { persistSession: false } });
const cleanup = [];

const id = "test-" + Date.now();
let ok = false;
try {
  // 1. First visit: account created, signed in, can use organiser functions.
  const email = `sso-${Date.now()}@example.com`;
  let r = await exchange(pass({ sub: id, email, name: "Ade Test", back: "https://eventpadi.com/dashboard" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.back, "https://eventpadi.com/dashboard");
  let sb = await asUser(r.body);
  const { data: me } = await sb.auth.getUser();
  cleanup.push(me.user.id);
  assert.equal(me.user.email, email);
  assert.equal(me.user.user_metadata.full_name, "Ade Test");
  const q = await sb.rpc("my_quizzes");
  assert.ok(Array.isArray(q.data.quizzes), "signed-in organiser API works");

  // 2. Second visit, new email on Eventpadi: same account, email updated.
  const email2 = `sso2-${Date.now()}@example.com`;
  r = await exchange(pass({ sub: id, email: email2, name: "Ade Renamed" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { data: me2 } = await (await asUser(r.body)).auth.getUser();
  assert.equal(me2.user.id, me.user.id, "same Eventpadi user -> same account");
  assert.equal(me2.user.email, email2);
  assert.equal(me2.user.user_metadata.full_name, "Ade Renamed");

  // 3. Refusals
  const t = pass({ sub: id, email: email2 });
  assert.equal((await exchange(t)).status, 200);
  assert.equal((await exchange(t)).body.code, "replayed", "a pass works once");
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await exchange(pass({ sub: id, email: email2, iat: now - 400, exp: now - 100 }))).body.code, "expired");
  assert.equal((await exchange(pass({ sub: id, email: email2 }, "x".repeat(40)))).body.code, "bad_signature");
  assert.equal((await exchange(pass({ sub: id, email: email2, aud: "something-else" }))).body.code, "bad_audience");
  assert.equal((await exchange(pass({ sub: id, email: email2, exp: now + 3600 }))).body.code, "lifetime_too_long");
  assert.equal((await exchange(pass({ sub: id, email: email2, jti: undefined }))).body.code, "no_jti");
  assert.equal((await exchange("not.a.jwt")).body.code, "malformed");
  const none = b64({ alg: "none" }) + "." + b64({ aud: "eventpadi-live", sub: id, email: email2, iat: now, exp: now + 60, jti: crypto.randomUUID() }) + ".";
  assert.equal((await exchange(none)).body.code, "bad_alg");

  // 4. Someone already signed up directly with this email.
  const direct = `direct-${Date.now()}@example.com`;
  const created = await admin.auth.admin.createUser({ email: direct, password: crypto.randomUUID(), email_confirm: true });
  cleanup.push(created.data.user.id);
  r = await exchange(pass({ sub: id + "-b", email: direct }));
  assert.equal(r.body.code, "email_in_use", "not linked unless Eventpadi vouches for the email");
  r = await exchange(pass({ sub: id + "-c", email: direct, email_verified: true }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { data: me3 } = await (await asUser(r.body)).auth.getUser();
  assert.equal(me3.user.id, created.data.user.id, "linked to the existing account");

  ok = true;
  console.log("SSO TEST PASSED");
} catch (e) {
  console.error("SSO TEST FAILED:", e.message);
} finally {
  for (const u of cleanup) await admin.auth.admin.deleteUser(u);
  process.exit(ok ? 0 : 1);
}
