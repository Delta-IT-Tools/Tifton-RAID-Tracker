// Password gate for the whole Pages site.
//
// How it works:
// - Every request passes through this middleware first.
// - If the request has a valid signed session cookie, it's allowed through
//   to the static site (index.html, etc).
// - Otherwise, a login page is shown. Submitting the correct password sets
//   a signed cookie (valid 30 days) and redirects back to the site.
//
// Secrets used (set these with `wrangler pages secret put <NAME>`,
// never commit them to the repo):
//   SITE_PASSWORD   — the shared password for the tool
//   SESSION_SECRET  — a random string used to sign session cookies
//
// Because the check happens here, server-side, before any page content is
// served, this can't be bypassed by viewing page source (unlike a password
// baked into client-side JavaScript).

const COOKIE_NAME = "tgt_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/logout") {
    return handleLogout();
  }

  if (url.pathname === "/login" && request.method === "POST") {
    return handleLoginPost(request, env);
  }

  if (await isAuthenticated(request, env)) {
    return context.next();
  }

  const justFailed = url.pathname === "/login";
  return renderLoginPage(justFailed);
}

async function isAuthenticated(request, env) {
  if (!env.SITE_PASSWORD || !env.SESSION_SECRET) {
    // Secrets not configured yet — fail closed (show login) rather than
    // silently letting everyone through.
    return false;
  }
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiryStr, sig] = parts;

  const expected = await hmac(env.SESSION_SECRET, expiryStr);
  if (!timingSafeEqual(sig, expected)) return false;

  const expiry = parseInt(expiryStr, 10);
  if (Number.isNaN(expiry) || Date.now() > expiry) return false;

  return true;
}

async function handleLoginPost(request, env) {
  if (!env.SITE_PASSWORD || !env.SESSION_SECRET) {
    return new Response(
      "Server is missing SITE_PASSWORD / SESSION_SECRET secrets. Set them with `wrangler pages secret put`.",
      { status: 500 }
    );
  }

  const formData = await request.formData();
  const password = formData.get("password") || "";

  if (!timingSafeEqual(password, env.SITE_PASSWORD)) {
    return renderLoginPage(true);
  }

  const expiry = Date.now() + SESSION_DURATION_MS;
  const sig = await hmac(env.SESSION_SECRET, String(expiry));
  const token = `${expiry}.${sig}`;

  const headers = new Headers();
  headers.set("Location", "/");
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
      SESSION_DURATION_MS / 1000
    )}`
  );
  return new Response(null, { status: 302, headers });
}

function handleLogout() {
  const headers = new Headers();
  headers.set("Location", "/");
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  return new Response(null, { status: 302, headers });
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) {
    // Still do a constant-time-ish comparison against a dummy to avoid
    // trivially leaking length via early return timing.
    let dummy = 0;
    for (let i = 0; i < a.length; i++) dummy |= a.charCodeAt(i);
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function renderLoginPage(showError) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in — TIFTON Go-Live Tracker</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%;
    background: linear-gradient(180deg, #9AC6E2 0%, #263138 100%);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  body { display: flex; align-items: center; justify-content: center; }
  .card {
    background: #334249;
    border-radius: 16px;
    padding: 32px 28px;
    width: 100%;
    max-width: 340px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.25);
  }
  .title { color: #fff; font-size: 19px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
  .subtitle { color: #a9b7c0; font-size: 13px; margin: 0 0 22px; }
  label { display: block; font-size: 11.5px; font-weight: 700; color: #b9c4cc; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
  input[type="password"] {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #4a5a63;
    background: rgba(255,255,255,0.06); color: #fff; font-size: 14px; outline: none;
    margin-bottom: 16px;
  }
  input[type="password"]::placeholder { color: #7c8a92; }
  button {
    width: 100%; padding: 11px; border-radius: 8px; border: none;
    background: #9AC6E2; color: #1e2532; font-size: 14px; font-weight: 700;
    cursor: pointer; font-family: inherit;
  }
  button:hover { filter: brightness(0.96); }
  .error {
    background: #fdeceb; border: 1px solid #f2c6c0; color: #c0392b;
    border-radius: 8px; padding: 8px 12px; font-size: 12.5px; margin-bottom: 16px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="title">TIFTON Go-Live Tracker</div>
    <div class="subtitle">Enter the password to continue</div>
    ${showError ? '<div class="error">Incorrect password — please try again.</div>' : ""}
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="••••••••" autofocus required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: showError ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
