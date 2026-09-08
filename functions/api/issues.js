// Shared data store for the tracker, backed by D1.
//
// This makes the tracker's data shared across everyone who uses the tool —
// not per-browser like the original artifact version. All issues are kept
// as a single JSON blob in one row (id = 'issues'), the same shape the
// tracker already worked with client-side; this just moves that same blob
// from the browser's local storage to a real shared database.
//
// Requires a D1 binding named `DB` (configured in wrangler.toml — see
// README.md for how to create the database and wire up the binding, all
// from the Cloudflare dashboard).
//
// Every request here already passes through functions/_middleware.js first,
// so these endpoints are gated behind the same password/session check as
// the rest of the site — there's no separate auth to add.

const ROW_ID = "issues";

export async function onRequestGet(context) {
  const { env } = context;

  if (!env.DB) {
    return jsonResponse({ error: "D1 database not bound. See README.md." }, 500);
  }

  try {
    const row = await env.DB
      .prepare("SELECT data, data_version FROM tracker_data WHERE id = ?")
      .bind(ROW_ID)
      .first();

    if (!row) {
      // Nothing saved yet — let the client fall back to its seed data.
      return jsonResponse({ issues: [], dataVersion: 0 });
    }

    let issues;
    try {
      issues = JSON.parse(row.data);
    } catch (e) {
      return jsonResponse({ error: "Stored data is corrupted JSON." }, 500);
    }

    return jsonResponse({ issues, dataVersion: row.data_version || 0 });
  } catch (e) {
    return jsonResponse({ error: "Database read failed: " + e.message }, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;

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
