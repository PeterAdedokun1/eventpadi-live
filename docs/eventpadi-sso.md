# Signing Eventpadi users in to Eventpadi Live

When a signed-in Eventpadi user clicks **Live Games**, they should land on their Eventpadi Live dashboard already signed in. To do this, Eventpadi's backend creates a short-lived signed **pass** (a JWT) and redirects the browser to Eventpadi Live with it.

This guide covers everything needed on the Eventpadi side: one new endpoint, roughly 15 lines.

## How it works

```
User clicks "Live Games" in Eventpadi
  → GET https://<eventpadi>/live-games            (your new endpoint; user must be logged in)
  → your server signs a pass for that user
  → 302 redirect to https://eventpadi-live.vercel.app/host#sso=<pass>
  → Eventpadi Live checks the pass, creates or finds the organiser account, signs them in
```

On the first visit an account is created automatically. After that, the same Eventpadi user always maps to the same account, even if their email changes, because accounts are linked by your user ID.

## The shared secret

The pass is signed with a secret shared between Eventpadi and Eventpadi Live. It's `EVENTPADI_SSO_SECRET` in the Eventpadi Live project's `.env.local`, and the Eventpadi Live admin will send it to you through a secure channel.

- Store it in your server's environment, for example as `EVENTPADI_LIVE_SSO_SECRET`.
- **Never** put it in front-end code or a mobile app, and never commit it.
- If it leaks, Eventpadi Live generates a new one and you update yours. Existing sessions stay signed in.

## The pass

A JWT signed with **HS256**, with these claims:

| Claim | Value | Required |
|---|---|---|
| `aud` | `"eventpadi-live"` | Yes |
| `sub` | Your user's ID (string), the permanent link to their account | Yes |
| `email` | The user's email | Yes |
| `name` | Display name, shown as "Welcome back, …" | No |
| `email_verified` | `true` only if you have verified this email. See below. | No |
| `back` | `https://` URL of the Eventpadi page their "Back to Eventpadi" button should open | No |
| `iat` | Now, in Unix seconds | Yes |
| `exp` | `iat + 60`. The maximum allowed is `iat + 300`. | Yes |
| `jti` | A random UUID. Each pass can be used once. | Yes |

**About `email_verified`:** if someone has already created an Eventpadi Live account directly with the same email, the pass is linked to that account only when `email_verified` is `true`. Otherwise sign-in is refused, so nobody can take over an account by putting someone else's email on an unverified Eventpadi profile. Send `true` only for emails you have actually confirmed.

**Rules:**
- Create a new pass **on every click**, on the server, for the user who is logged in. Never cache or reuse passes.
- Put the pass after `#`, not `?`, so it doesn't reach server logs or other websites.
- The endpoint must require an Eventpadi login. If the user isn't logged in, send them to your login page first.

## Code

### Node.js (Express) — `npm install jsonwebtoken`

```js
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

app.get("/live-games", requireLogin, (req, res) => {
  const u = req.user;
  const pass = jwt.sign(
    {
      sub: String(u.id),
      email: u.email,
      name: u.fullName,
      email_verified: u.emailVerified === true,
      back: "https://eventpadi.com/dashboard",
      jti: crypto.randomUUID()
    },
    process.env.EVENTPADI_LIVE_SSO_SECRET,
    { algorithm: "HS256", audience: "eventpadi-live", expiresIn: 60 }
  );
  res.redirect(302, "https://eventpadi-live.vercel.app/host#sso=" + pass);
});
```

### PHP (Laravel) — `composer require firebase/php-jwt`

```php
use Firebase\JWT\JWT;
use Illuminate\Support\Str;

Route::middleware('auth')->get('/live-games', function () {
    $u = auth()->user();
    $now = time();
    $pass = JWT::encode([
        'aud' => 'eventpadi-live',
        'sub' => (string) $u->id,
        'email' => $u->email,
        'name' => $u->name,
        'email_verified' => $u->hasVerifiedEmail(),
        'back' => 'https://eventpadi.com/dashboard',
        'iat' => $now,
        'exp' => $now + 60,
        'jti' => (string) Str::uuid(),
    ], env('EVENTPADI_LIVE_SSO_SECRET'), 'HS256');
    return redirect()->away('https://eventpadi-live.vercel.app/host#sso=' . $pass);
});
```

### Python (Django / Flask) — `pip install pyjwt`

```python
import time, uuid, jwt, os

def live_games(request):            # protect with your login decorator
    u = request.user
    now = int(time.time())
    token = jwt.encode({
        "aud": "eventpadi-live", "sub": str(u.id), "email": u.email, "name": u.get_full_name(),
        "email_verified": True,       # only if your app verifies emails
        "back": "https://eventpadi.com/dashboard",
        "iat": now, "exp": now + 60, "jti": str(uuid.uuid4()),
    }, os.environ["EVENTPADI_LIVE_SSO_SECRET"], algorithm="HS256")
    return redirect("https://eventpadi-live.vercel.app/host#sso=" + token)
```

### C# (ASP.NET Core) — `System.IdentityModel.Tokens.Jwt`

```csharp
[Authorize, HttpGet("/live-games")]
public IActionResult LiveGames()
{
    var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_config["EVENTPADI_LIVE_SSO_SECRET"]));
    var token = new JwtSecurityToken(
        audience: "eventpadi-live",
        claims: new[] {
            new Claim("sub", User.FindFirstValue(ClaimTypes.NameIdentifier)),
            new Claim("email", User.FindFirstValue(ClaimTypes.Email)),
            new Claim("name", User.Identity.Name ?? ""),
            new Claim("jti", Guid.NewGuid().ToString()),
            new Claim("back", "https://eventpadi.com/dashboard"),
        },
        notBefore: DateTime.UtcNow,
        expires: DateTime.UtcNow.AddSeconds(60),
        signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
    // JwtSecurityTokenHandler adds iat when you set IssuedAt; set it explicitly:
    token.Payload["iat"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    var pass = new JwtSecurityTokenHandler().WriteToken(token);
    return Redirect("https://eventpadi-live.vercel.app/host#sso=" + pass);
}
```

## The button

Wherever Live Games appears in Eventpadi (menu, event page, dashboard card), link to your endpoint:

```html
<a href="/live-games">Live Games</a>
```

Opening it in a new tab is fine: `target="_blank"`.

## Testing

1. Log in to Eventpadi on a test account and click Live Games. You should land on the Eventpadi Live dashboard with "Welcome back, <name>".
2. Click Live Games again. It should be the same account, with the same saved games.
3. Paste the same `…#sso=` URL into another browser. It must be refused, because each pass works only once.
4. If sign-in fails, the page shows "We couldn't sign you in from Eventpadi automatically". The usual causes:

| Problem | Cause |
|---|---|
| Wrong or different secret | Signature check fails |
| Server clock more than a minute off | Pass is treated as expired or not yet valid |
| `exp` more than 5 minutes after `iat` | Pass lifetime too long |
| `aud` missing or misspelled | Wrong audience |
| An account already exists with that email and `email_verified` isn't `true` | Linking refused |

   The Eventpadi Live admin can see the exact reason in Supabase → Edge Functions → `sso` → Logs.
