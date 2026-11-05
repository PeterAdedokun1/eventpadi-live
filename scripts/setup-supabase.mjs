// Creates (or reuses) a Supabase project, applies the schema, sets the host
// password and writes public/config.js.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/setup-supabase.mjs
//
// Optional env:
//   SUPABASE_PROJECT_REF  use an existing project instead of creating one
//   SUPABASE_ORG_ID       organisation for the new project (default: your first one)
//   SUPABASE_REGION       region for the new project (default: eu-west-2, London)
//   HOST_KEY              host password (default: keep the current one, or generate one)
//   PUBLIC_URL            site URL shown on the projector and in the QR code
//
// Secrets (project ref, database password, host password) are saved to .env.local.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env.local");
const API = "https://api.supabase.com/v1";

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
const saved = readEnvFile();
const env = (k) => process.env[k] || saved[k] || "";

const TOKEN = env("SUPABASE_ACCESS_TOKEN");
if (!TOKEN) { console.error("Set SUPABASE_ACCESS_TOKEN (create one at https://supabase.com/dashboard/account/tokens)."); process.exit(1); }

async function api(method, p, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if ((res.status >= 500 || res.status === 429) && attempt < 8) { await sleep(5000); continue; }
    throw new Error(`${method} ${p} → ${res.status}: ${text}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secret = (n = 24) => crypto.randomBytes(n).toString("base64url");

let ref = env("SUPABASE_PROJECT_REF");
let dbPass = env("SUPABASE_DB_PASSWORD");

if (!ref) {
  const orgs = await api("GET", "/organizations");
  if (!orgs.length) throw new Error("Your Supabase account has no organisation. Create one in the dashboard first.");
  const org = env("SUPABASE_ORG_ID") || orgs[0].id;
  dbPass = secret(24);
  console.log(`Creating project "eventpadi-live" in organisation ${org}…`);
  const proj = await api("POST", "/projects", {
    name: "eventpadi-live",
    organization_id: org,
    region: env("SUPABASE_REGION") || "eu-west-2",
    db_pass: dbPass
  });
  ref = proj.id || proj.ref;
  console.log(`Project created: ${ref}`);
  writeEnv({ SUPABASE_PROJECT_REF: ref, SUPABASE_DB_PASSWORD: dbPass });
}

process.stdout.write("Waiting for the project to be ready");
for (let i = 0; ; i++) {
  const p = await api("GET", `/projects/${ref}`);
  if (p.status === "ACTIVE_HEALTHY") break;
  if (i > 120) throw new Error("Project did not become ready in 10 minutes (status " + p.status + ").");
  process.stdout.write(".");
  await sleep(5000);
}
console.log(" ready.");

async function query(sql) {
  for (let i = 0; ; i++) {
    try { return await api("POST", `/projects/${ref}/database/query`, { query: sql }); }
    catch (e) { if (i > 12) throw e; await sleep(5000); }
  }
}

const migrations = fs.readdirSync(path.join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  console.log(`Applying ${f}…`);
  await query(fs.readFileSync(path.join(ROOT, "supabase", "migrations", f), "utf8"));
}

const hostKey = env("HOST_KEY") || secret(9);
await query(`insert into public.settings (key, value) values ('host_key', '${hostKey.replace(/'/g, "''")}')
             on conflict (key) do update set value = excluded.value`);

// Single sign-on from the Eventpadi platform: shared secret + the sso Edge Function.
const ssoSecret = env("EVENTPADI_SSO_SECRET") || secret(32);
await api("POST", `/projects/${ref}/secrets`, [{ name: "EVENTPADI_SSO_SECRET", value: ssoSecret }]);
writeEnv({ EVENTPADI_SSO_SECRET: ssoSecret });
{
  const dir = path.join(ROOT, "supabase", "functions", "sso");
  const form = new FormData();
  form.append("metadata", JSON.stringify({ entrypoint_path: "index.ts", name: "sso", verify_jwt: false }));
  form.append("file", new Blob([fs.readFileSync(path.join(dir, "index.ts"))], { type: "application/typescript" }), "index.ts");
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions/deploy?slug=sso`, {
      method: "POST", headers: { Authorization: `Bearer ${env("SUPABASE_ACCESS_TOKEN")}` }, body: form
    });
    if (res.ok) { console.log("Deployed Edge Function sso."); break; }
    if (attempt >= 4) throw new Error(`Deploying the sso function failed: ${res.status} ${await res.text()}`);
    await sleep(5000);
  }
}

const keys = await api("GET", `/projects/${ref}/api-keys?reveal=true`);
const anon = keys.find((k) => k.name === "anon") || keys.find((k) => k.type === "publishable");
if (!anon) throw new Error("Couldn't find the project's anon/publishable key.");

const url = `https://${ref}.supabase.co`;
const publicUrl = env("PUBLIC_URL");
fs.writeFileSync(path.join(ROOT, "public", "config.js"),
`// Generated by scripts/setup-supabase.mjs. The anon key is public by design:
// all access goes through the database functions, and tables are locked by RLS.
window.EP_CONFIG = {
  supabaseUrl: ${JSON.stringify(url)},
  supabaseAnonKey: ${JSON.stringify(anon.api_key)},
  publicUrl: ${JSON.stringify(publicUrl)}
};
`);
writeEnv({ SUPABASE_PROJECT_REF: ref, HOST_KEY: hostKey, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon.api_key, ...(publicUrl ? { PUBLIC_URL: publicUrl } : {}) });

console.log(`
Done.
  Supabase URL:   ${url}
  Host password:  ${hostKey}
  Config written: public/config.js
  Secrets saved:  .env.local (keep this file private)`);

function writeEnv(vals) {
  const cur = readEnvFile();
  Object.assign(cur, vals);
  fs.writeFileSync(ENV_FILE, Object.entries(cur).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}
