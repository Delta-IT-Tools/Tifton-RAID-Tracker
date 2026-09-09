// TIFTON Go-Live Tracker — single Worker (static assets + password gate +
// shared D1-backed API), for the modern "Workers with assets" model.
//
// Why this file exists instead of the functions/ directory: on some
// Cloudflare accounts, creating a project through the dashboard's
// Git-integration flow registers it as a plain Worker rather than a
// classic "Pages" project, even when using the Pages tab. `wrangler pages
// deploy` then fails with "The Pages project does not exist" because
// there genuinely is no Pages project — only a Worker. This file targets
// that Worker model directly: `wrangler deploy` (not `wrangler pages
// deploy`), a single `main` entry point, and a `[assets]` binding in
// wrangler.toml instead of a functions/ directory.
//
// Everything the old functions/_middleware.js + functions/api/issues.js
// did is preserved here, just combined into one script with manual
// routing instead of Pages' file-based routing.
//
// Secrets used (set via the Cloudflare dashboard → this Worker → Settings
// → Variables and Secrets → Encrypt — never commit them):
//   SITE_PASSWORD   — the shared password for the tool
//   SESSION_SECRET  — a random string used to sign session cookies
// Binding used (declared in wrangler.toml, not sensitive):
//   DB              — the D1 database storing the shared issue list
//   ASSETS          — the static files in public/ (wired up automatically
//                     by the [assets] block in wrangler.toml)

const COOKIE_NAME = "tgt_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ROW_ID = "issues";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/logout") {
      return handleLogout();
    }

    if (url.pathname === "/login" && request.method === "POST") {
      return handleLoginPost(request, env);
    }

    const authed = await isAuthenticated(request, env);
    if (!authed) {
      // Note: this branch only ever renders the plain login page, never
      // the error banner — a failed password attempt is handled directly
      // inside handleLoginPost() above (which returns its own response),
      // so there's no failed-login state to detect here. Checking the
      // URL path alone (e.g. "== /login") would incorrectly show
      // "Incorrect password" on a first, unsubmitted visit to that path.
      return renderLoginPage(false);
    }

    if (url.pathname === "/api/issues") {
      if (request.method === "GET") return handleGetIssues(env);
      if (request.method === "PUT") return handlePutIssues(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/snapshots") {
      if (request.method === "GET") return handleGetSnapshots(env);
      if (request.method === "POST") return handlePostSnapshot(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname.startsWith("/api/snapshots/")) {
      const id = url.pathname.slice("/api/snapshots/".length);
      if (request.method === "GET") return handleGetSnapshotDetail(env, id);
      if (request.method === "DELETE") return handleDeleteSnapshot(env, id);
      return new Response("Method not allowed", { status: 405 });
    }

    // Authenticated — serve the static tracker (public/index.html, etc).
    // The response's Content-Type header is what actually controls how the
    // browser decodes the bytes — the <meta charset="UTF-8"> tag in the
    // HTML is only advisory and gets overridden if the header specifies (or
    // omits) a charset. Cloudflare's static asset serving doesn't reliably
    // include "charset=utf-8" on its own, which is what caused em dashes
    // and other multi-byte characters to render as garbled text (e.g. "—"
    // showing up as "â€"") even though the underlying file bytes were
    // always correct UTF-8. Forcing it here guarantees correct decoding
    // regardless of what Cloudflare's default asset pipeline sends.
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("Content-Type") || "";
    if (contentType.startsWith("text/html")) {
      const headers = new Headers(assetResponse.headers);
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }
    return assetResponse;
  },
};

// ---------- Auth (same logic as the original _middleware.js) ----------

// Resolves a secret regardless of whether this account's dashboard bound
// it as a plain string (the traditional "Encrypted" Worker secret) or as
// a Secrets Store binding (a newer, separate Cloudflare product that
// returns an RPC object with an async .get() method instead of a plain
// string). Calling .trim() or .length directly on a Secrets Store binding
// silently produces garbage instead of throwing, which is what caused the
// "[object JsRpcProperty]" — this normalizes both shapes to a real string.
async function resolveSecret(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.get === "function") return await value.get();
  return "";
}

async function isAuthenticated(request, env) {
  const sitePassword = await resolveSecret(env.SITE_PASSWORD);
  const sessionSecret = await resolveSecret(env.SESSION_SECRET);
  if (!sitePassword || !sessionSecret) {
    // Secrets not configured yet — fail closed (show login) rather than
    // silently letting everyone through.
    return false;
  }
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiryStr, sig] = parts;

  const expected = await hmac(sessionSecret, expiryStr);
  if (!timingSafeEqual(sig, expected)) return false;

  const expiry = parseInt(expiryStr, 10);
  if (Number.isNaN(expiry) || Date.now() > expiry) return false;

  return true;
}

async function handleLoginPost(request, env) {
  const sitePassword = await resolveSecret(env.SITE_PASSWORD);
  const sessionSecret = await resolveSecret(env.SESSION_SECRET);
  if (!sitePassword || !sessionSecret) {
    return new Response(
      "Server is missing SITE_PASSWORD / SESSION_SECRET. Set them in this Worker's Settings → Variables and Secrets.",
      { status: 500 }
    );
  }

  const formData = await request.formData();
  // .trim() guards against the common case of a stray trailing space or
  // newline getting carried along when pasting the password value into
  // the Cloudflare dashboard's Variables and Secrets field — that would
  // otherwise make a visually-identical password silently never match.
  const password = (formData.get("password") || "").trim();
  const expectedPassword = sitePassword.trim();

  if (!timingSafeEqual(password, expectedPassword)) {
    return renderLoginPage(true);
  }

  const expiry = Date.now() + SESSION_DURATION_MS;
  const sig = await hmac(sessionSecret, String(expiry));
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

// ---------- Shared issue-list API (same logic as functions/api/issues.js) ----------

const META_ROW_ID = "meta";

async function handleGetIssues(env) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  try {
    const row = await env.DB
      .prepare("SELECT data, data_version FROM tracker_data WHERE id = ?")
      .bind(ROW_ID)
      .first();

    let asOfDate = null;
    try {
      const metaRow = await env.DB
        .prepare("SELECT data FROM tracker_data WHERE id = ?")
        .bind(META_ROW_ID)
        .first();
      if (metaRow) asOfDate = JSON.parse(metaRow.data).asOfDate || null;
    } catch (e) { /* no meta row yet, or corrupted — just omit asOfDate */ }

    if (!row) {
      return jsonResponse({ issues: [], dataVersion: 0, asOfDate });
    }

    let issues;
    try {
      issues = JSON.parse(row.data);
    } catch (e) {
      return jsonResponse({ error: "Stored data is corrupted JSON." }, 500);
    }

    return jsonResponse({ issues, dataVersion: row.data_version || 0, asOfDate });
  } catch (e) {
    return jsonResponse({ error: "Database read failed: " + e.message }, 500);
  }
}

async function handlePutIssues(request, env) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Request body is not valid JSON." }, 400);
  }

  if (!Array.isArray(payload.issues)) {
    return jsonResponse({ error: "Expected { issues: [...], dataVersion: N }." }, 400);
  }

  const dataVersion = Number.isFinite(payload.dataVersion) ? payload.dataVersion : 0;
  const now = new Date().toISOString();

  try {
    await env.DB
      .prepare(
        `INSERT INTO tracker_data (id, data, data_version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           data_version = excluded.data_version,
           updated_at = excluded.updated_at`
      )
      .bind(ROW_ID, JSON.stringify(payload.issues), dataVersion, now)
      .run();

    // Only updates the "as of" date when the client explicitly supplies one
    // (i.e. a live RAID Log upload) — manual single-issue edits don't touch
    // this, since it's meant to reflect "when was this last bulk-uploaded
    // from Excel", not every small tweak.
    if (payload.asOfDate) {
      await env.DB
        .prepare(
          `INSERT INTO tracker_data (id, data, data_version, updated_at)
           VALUES (?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             updated_at = excluded.updated_at`
        )
        .bind(META_ROW_ID, JSON.stringify({ asOfDate: payload.asOfDate }), now)
        .run();
    }

    return jsonResponse({ ok: true, updatedAt: now });
  } catch (e) {
    return jsonResponse({ error: "Database write failed: " + e.message }, 500);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- Upload history / snapshots ----------
//
// Every time a new RAID log is uploaded through the "Upload RAID Log"
// button, the client POSTs the resulting item list here. We store the
// full item-level state at that moment (not just counts) so later
// analysis — e.g. how long a given item has sat in "Testing" — can be
// computed by comparing snapshots over time, not just looking at today.

async function handleGetSnapshots(env) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  try {
    const { results } = await env.DB
      .prepare("SELECT id, uploaded_at, item_count, status_counts FROM raid_snapshots ORDER BY uploaded_at DESC LIMIT 100")
      .all();
    const snapshots = (results || []).map((r) => ({
      id: r.id,
      uploadedAt: r.uploaded_at,
      itemCount: r.item_count,
      statusCounts: JSON.parse(r.status_counts),
    }));
    return jsonResponse({ snapshots });
  } catch (e) {
    return jsonResponse({ error: "Database read failed: " + e.message }, 500);
  }
}

async function handleGetSnapshotDetail(env, id) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  const numericId = parseInt(id, 10);
  if (Number.isNaN(numericId)) {
    return jsonResponse({ error: "Invalid snapshot id." }, 400);
  }
  try {
    const row = await env.DB
      .prepare("SELECT id, uploaded_at, item_count, status_counts, data FROM raid_snapshots WHERE id = ?")
      .bind(numericId)
      .first();
    if (!row) {
      return jsonResponse({ error: "Snapshot not found." }, 404);
    }
    return jsonResponse({
      id: row.id,
      uploadedAt: row.uploaded_at,
      itemCount: row.item_count,
      statusCounts: JSON.parse(row.status_counts),
      issues: JSON.parse(row.data),
    });
  } catch (e) {
    return jsonResponse({ error: "Database read failed: " + e.message }, 500);
  }
}

async function handleDeleteSnapshot(env, id) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  const numericId = parseInt(id, 10);
  if (Number.isNaN(numericId)) {
    return jsonResponse({ error: "Invalid snapshot id." }, 400);
  }
  try {
    await env.DB.prepare("DELETE FROM raid_snapshots WHERE id = ?").bind(numericId).run();
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "Database delete failed: " + e.message }, 500);
  }
}

async function handlePostSnapshot(request, env) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Request body is not valid JSON." }, 400);
  }
  if (!Array.isArray(payload.issues)) {
    return jsonResponse({ error: "Expected { issues: [...] }." }, 400);
  }

  const statusCounts = {};
  payload.issues.forEach((i) => {
    const s = i.status || "unknown";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  // Allows backdating a snapshot to when that RAID log export actually was
  // (e.g. uploading a historical copy from weeks ago), so History reflects
  // the real timeline rather than just upload order. Falls back to now if
  // the client doesn't supply a date, or supplies an unparseable one.
  let uploadedAt = new Date().toISOString();
  if (payload.uploadedAt) {
    const parsed = new Date(payload.uploadedAt);
    if (!isNaN(parsed)) uploadedAt = parsed.toISOString();
  }

  try {
    const result = await env.DB
      .prepare(
        `INSERT INTO raid_snapshots (uploaded_at, item_count, status_counts, data)
         VALUES (?, ?, ?, ?)`
      )
      .bind(uploadedAt, payload.issues.length, JSON.stringify(statusCounts), JSON.stringify(payload.issues))
      .run();

    return jsonResponse({ ok: true, id: result.meta.last_row_id, uploadedAt });
  } catch (e) {
    return jsonResponse({ error: "Database write failed: " + e.message }, 500);
  }
}
