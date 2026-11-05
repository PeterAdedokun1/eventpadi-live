// Single sign-on from the Eventpadi platform.
//
// Eventpadi's backend signs a short-lived pass (a JWT, HS256, with the shared secret
// EVENTPADI_SSO_SECRET) and sends the organiser to
//   https://<live site>/host#sso=<pass>
// The host page POSTs the pass here. We check it, find or create the organiser's
// account, and return a Supabase session, so they're signed in without a password.
//
// Pass claims:
//   aud   "eventpadi-live"                       required
//   sub   Eventpadi user id (string)             required, the stable link to the account
//   email user's email                           required
//   name  display name                           optional
//   email_verified  true if Eventpadi verified the email   optional (see below)
//   back  https URL of the Eventpadi page to return to     optional
//   iat, exp  issued / expiry (seconds); exp - iat <= 300 required
//   jti   random id, single use                  required
//
// Security notes:
// - Each pass works once (jti is recorded) and only for a few minutes.
// - Accounts are linked by Eventpadi user id, so a later email change keeps the same account.
// - If someone already signed up directly with the same email, the pass is linked to that
//   account only when email_verified is true; otherwise we refuse rather than risk a takeover.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRET = Deno.env.get("EVENTPADI_SSO_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const AUDIENCE = "eventpadi-live";
const MAX_LIFETIME = 300; // seconds a pass may be valid for
const SKEW = 60;          // allowed clock difference between servers, seconds

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const refuse = (code: string, why: string) => {
  console.warn("sso refused:", code, why);
  return reply(401, { error: "We couldn't sign you in from Eventpadi. Please go back and try again.", code });
};

const enc = new TextEncoder();
function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function verifyPass(token: string): Promise<Record<string, unknown> | string> {
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed";
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return "malformed"; }
  if (header.alg !== "HS256") return "bad_alg";
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return "bad_signature";

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(AUDIENCE)) return "bad_audience";
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return "no_expiry";
  if (claims.exp < now - SKEW) return "expired";
  if (claims.iat > now + SKEW) return "not_yet_valid";
  if (claims.exp - claims.iat > MAX_LIFETIME) return "lifetime_too_long";
  if (typeof claims.jti !== "string" || claims.jti.length < 8 || claims.jti.length > 128) return "no_jti";
  if (typeof claims.sub !== "string" && typeof claims.sub !== "number") return "no_sub";
  if (String(claims.sub).length > 128) return "bad_sub";
  if (typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 254) return "bad_email";
  return claims;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  if (SECRET.length < 32) return reply(500, { error: "Single sign-on isn't configured yet." });

  let token = "";
  try { token = String((await req.json()).token || ""); } catch { /* handled below */ }
  if (!token || token.length > 4096) return refuse("missing", "no token");

  const claims = await verifyPass(token);
  if (typeof claims === "string") return refuse(claims, "verify");

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const externalId = String(claims.sub);
  const email = String(claims.email).trim().toLowerCase();
  const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 60) : "";

  // Each pass works once.
  const used = await admin.from("sso_used").insert({ jti: claims.jti });
  if (used.error) return refuse(used.error.code === "23505" ? "replayed" : "jti_store_failed", used.error.message);

  // Find the linked account, or create / link one.
  let userId: string | null = null;
  const link = await admin.from("sso_links").select("user_id").eq("provider", "eventpadi").eq("external_id", externalId).maybeSingle();
  if (link.error) return reply(500, { error: "Something went wrong. Please try again." });
  if (link.data) {
    userId = link.data.user_id;
    const { data: u } = await admin.auth.admin.getUserById(userId!);
    const meta = { ...(u?.user?.user_metadata || {}), eventpadi_id: externalId, ...(name ? { full_name: name } : {}) };
    const update: Record<string, unknown> = { user_metadata: meta };
    if (u?.user && u.user.email !== email) { update.email = email; update.email_confirm = true; }
    const upd = await admin.auth.admin.updateUserById(userId!, update);
    if (upd.error && update.email) await admin.auth.admin.updateUserById(userId!, { user_metadata: meta }); // email taken: keep the old one
    await admin.from("sso_links").update({ last_seen_at: new Date().toISOString() }).eq("provider", "eventpadi").eq("external_id", externalId);
  } else {
    const created = await admin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { full_name: name, eventpadi_id: externalId },
    });
    if (created.data?.user) {
      userId = created.data.user.id;
    } else {
      // The email already has an account (they signed up directly). Link only if Eventpadi verified the email.
      const { data: existing } = await admin.rpc("_sso_user_by_email", { p_email: email });
      if (!existing) return reply(500, { error: "Something went wrong. Please try again." });
      if (claims.email_verified !== true) return refuse("email_in_use", "existing account, email not verified by Eventpadi");
      userId = existing as string;
    }
    const ins = await admin.from("sso_links").insert({ provider: "eventpadi", external_id: externalId, user_id: userId });
    if (ins.error && ins.error.code !== "23505") return reply(500, { error: "Something went wrong. Please try again." });
  }

  // Make a session without sending any email: an admin magic-link token, redeemed here.
  const { data: u } = await admin.auth.admin.getUserById(userId!);
  const gen = await admin.auth.admin.generateLink({ type: "magiclink", email: u!.user!.email! });
  if (gen.error) return reply(500, { error: "Something went wrong. Please try again." });
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const ses = await anon.auth.verifyOtp({ type: "magiclink", token_hash: gen.data.properties.hashed_token });
  if (ses.error || !ses.data.session) return reply(500, { error: "Something went wrong. Please try again." });

  const back = typeof claims.back === "string" && /^https:\/\/[^\s]{1,300}$/.test(claims.back) ? claims.back : null;
  return reply(200, {
    access_token: ses.data.session.access_token,
    refresh_token: ses.data.session.refresh_token,
    back,
  });
});
