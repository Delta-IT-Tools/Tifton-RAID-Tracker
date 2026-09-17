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

    // FDD (Functional Design Document) file storage — one file per issue,
    // stored as base64 text in D1 so it persists across page refreshes and
    // is shared with everyone using the tracker, not just kept in one
    // browser tab. /api/fdd (no id) returns lightweight metadata for every
    // stored file (name/size/type/uploadedAt, no file content) so the FDD
    // list can show what's there without pulling every file's bytes at
    // once; /api/fdd/<issueId> reads or writes one file's full content.
    if (url.pathname === "/api/fdd") {
      if (request.method === "GET") return handleGetFddList(env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname.startsWith("/api/fdd/")) {
      const issueId = decodeURIComponent(url.pathname.slice("/api/fdd/".length));
      if (request.method === "GET") return handleGetFddDetail(env, issueId);
      if (request.method === "PUT") return handlePutFdd(request, env, issueId);
      if (request.method === "DELETE") return handleDeleteFdd(env, issueId);
      return new Response("Method not allowed", { status: 405 });
    }

    // ---- ONE-TIME MIGRATION ROUTE ----
    // Re-derives every stored issue's stable `id` from its `devops` field
    // instead of the old `raidNumber`-based id (RAID # is just a
    // spreadsheet row position and isn't stable across uploads — see the
    // client-side comment above transformRaidRow() in index.html for the
    // full reasoning). This fixes up data already sitting in D1 (the
    // current live issue list, plus every historical raid_snapshots row)
    // so existing History stays comparable going forward without anyone
    // needing to re-upload old RAID logs.
    //
    // Safe to run more than once by accident — it's a pure recomputation
    // from each item's own `devops`/`raidNumber` fields, not something
    // that accumulates state. Intended to be triggered once, by hand
    // (see README), then this route can be deleted in a later deploy.
    if (url.pathname === "/api/migrate-devops-ids" && request.method === "POST") {
      return handleMigrateDevopsIds(env);
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

// ---------- One-time migration: re-derive issue ids from DevOps # ----------
//
// Background: every stored issue used to get its stable `id` from RAID #
// (`'raid-' + raidNumber`). RAID # is just that row's position in the
// source Excel sheet, so it shifts whenever rows are added, removed, or
// resorted — which meant History's added/removed diff kept treating
// unchanged items as "new" every upload. The client (index.html) now
// derives `id` from DevOps # instead (`'devops-' + devopsNumber`, since
// that's assigned to the actual issue and doesn't move), with items that
// have no DevOps # yet getting a distinct, deliberately-unmatchable
// `nodevops-...` id so they're flagged rather than silently miscounted.
//
// This endpoint applies that same recomputation to data already sitting
// in D1 — the current live issue list (tracker_data, id='issues') and
// every historical raid_snapshots row — using each item's own stored
// `devops`/`raidNumber` fields. No RAID log needs to be re-uploaded.
//
// Idempotent: re-running this is harmless. It's a pure recomputation from
// fields already on each item, not something that accumulates state.
function recomputeIssueId(item, index) {
  const devops = (item && item.devops ? item.devops : "").toString().trim();
  const raidNumber = (item && item.raidNumber ? item.raidNumber : "").toString().trim();
  if (devops) return "devops-" + devops;
  return "nodevops-" + (raidNumber || "row") + "-" + index;
}

function migrateIssueArray(issues) {
  if (!Array.isArray(issues)) return { issues, changed: 0 };
  let changed = 0;
  const migrated = issues.map((item, index) => {
    const newId = recomputeIssueId(item, index);
    if (newId !== item.id) changed++;
    return Object.assign({}, item, { id: newId });
  });
  return { issues: migrated, changed };
}

async function handleMigrateDevopsIds(env) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }

  const report = { liveIssues: null, snapshots: [] };

  try {
    // 1. The current live issue list (what the Board/Table/etc. show).
    const liveRow = await env.DB
      .prepare("SELECT data FROM tracker_data WHERE id = ?")
      .bind(ROW_ID)
      .first();
    if (liveRow) {
      let liveIssues;
      try {
        liveIssues = JSON.parse(liveRow.data);
      } catch (e) {
        liveIssues = null;
      }
      if (Array.isArray(liveIssues)) {
        const { issues: migrated, changed } = migrateIssueArray(liveIssues);
        await env.DB
          .prepare("UPDATE tracker_data SET data = ? WHERE id = ?")
          .bind(JSON.stringify(migrated), ROW_ID)
          .run();
        report.liveIssues = { totalItems: migrated.length, idsChanged: changed };
      }
    }

    // 2. Every historical upload snapshot.
    const { results } = await env.DB
      .prepare("SELECT id, data FROM raid_snapshots")
      .all();

    for (const row of results || []) {
      let issues;
      try {
        issues = JSON.parse(row.data);
      } catch (e) {
        report.snapshots.push({ id: row.id, error: "Could not parse stored data — skipped." });
        continue;
      }
      if (!Array.isArray(issues)) {
        report.snapshots.push({ id: row.id, error: "Stored data was not an array — skipped." });
        continue;
      }
      const { issues: migrated, changed } = migrateIssueArray(issues);
      await env.DB
        .prepare("UPDATE raid_snapshots SET data = ? WHERE id = ?")
        .bind(JSON.stringify(migrated), row.id)
        .run();
      report.snapshots.push({ id: row.id, totalItems: migrated.length, idsChanged: changed });
    }

    return jsonResponse({ ok: true, report });
  } catch (e) {
    return jsonResponse({ error: "Migration failed: " + e.message, report }, 500);
  }
}

// ---------- FDD document storage ----------
//
// One row per issue (issue_id is the primary key, so uploading a new file
// for the same issue replaces the previous one). The file itself is
// stored as base64 text — D1 doesn't have a separate blob storage product
// bound to this Worker, so this keeps everything in the one database
// that's already set up, at the cost of the usual ~33% base64 size
// overhead. MAX_FDD_BASE64_LENGTH keeps individual files comfortably
// under D1's per-value size ceiling; if you need to store larger FDDs
// than that regularly, this would need to move to Cloudflare R2 (object
// storage) instead, bound as a separate step.
const MAX_FDD_BASE64_LENGTH = 14_000_000; // ~10 MB of actual file content

async function handleGetFddList(env) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  try {
    const { results } = await env.DB
      .prepare("SELECT issue_id, filename, content_type, size, uploaded_at FROM fdd_documents")
      .all();
    const files = (results || []).map((r) => ({
      issueId: r.issue_id,
      filename: r.filename,
      contentType: r.content_type,
      size: r.size,
      uploadedAt: r.uploaded_at,
    }));
    return jsonResponse({ files });
  } catch (e) {
    return jsonResponse({ error: "Database read failed: " + e.message }, 500);
  }
}

async function handleGetFddDetail(env, issueId) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  if (!issueId) {
    return jsonResponse({ error: "Missing issue id." }, 400);
  }
  try {
    const row = await env.DB
      .prepare("SELECT issue_id, filename, content_type, size, data, uploaded_at FROM fdd_documents WHERE issue_id = ?")
      .bind(issueId)
      .first();
    if (!row) {
      return jsonResponse({ error: "No FDD file stored for this item." }, 404);
    }
    return jsonResponse({
      issueId: row.issue_id,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size,
      data: row.data,
      uploadedAt: row.uploaded_at,
    });
  } catch (e) {
    return jsonResponse({ error: "Database read failed: " + e.message }, 500);
  }
}

async function handlePutFdd(request, env, issueId) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  if (!issueId) {
    return jsonResponse({ error: "Missing issue id." }, 400);
  }
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Request body is not valid JSON." }, 400);
  }
  const filename = payload && payload.filename;
  const data = payload && payload.data;
  const contentType = (payload && payload.contentType) || "";
  const size = payload && Number.isFinite(payload.size) ? payload.size : (data ? data.length : 0);

  if (!filename || typeof data !== "string" || !data) {
    return jsonResponse({ error: "Expected { filename, contentType, size, data } where data is base64 file content." }, 400);
  }
  if (data.length > MAX_FDD_BASE64_LENGTH) {
    return jsonResponse({ error: "File is too large to store (limit is roughly 10 MB)." }, 413);
  }

  const now = new Date().toISOString();
  try {
    await env.DB
      .prepare(
        `INSERT INTO fdd_documents (issue_id, filename, content_type, size, data, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           filename = excluded.filename,
           content_type = excluded.content_type,
           size = excluded.size,
           data = excluded.data,
           uploaded_at = excluded.uploaded_at`
      )
      .bind(issueId, filename, contentType, size, data, now)
      .run();
    return jsonResponse({ ok: true, uploadedAt: now });
  } catch (e) {
    return jsonResponse({ error: "Database write failed: " + e.message }, 500);
  }
}

async function handleDeleteFdd(env, issueId) {
  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }
  if (!issueId) {
    return jsonResponse({ error: "Missing issue id." }, 400);
  }
  try {
    await env.DB.prepare("DELETE FROM fdd_documents WHERE issue_id = ?").bind(issueId).run();
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "Database delete failed: " + e.message }, 500);
  }
}

