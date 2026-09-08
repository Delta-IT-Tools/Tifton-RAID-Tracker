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
      const justFailed = url.pathname === "/login";
      return renderLoginPage(justFailed);
    }

    if (url.pathname === "/api/issues") {
      if (request.method === "GET") return handleGetIssues(env);
      if (request.method === "PUT") return handlePutIssues(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    // Authenticated — serve the static tracker (public/index.html, etc).
    return env.ASSETS.fetch(request);
  },
};

// ---------- Auth (same logic as the original _middleware.js) ----------

async function isAuthenticated(request, env) {
  if (!env.SITE_PASSWORD || !env.SESSION_SECRET) {
    // Secrets not configured yet — fail closed (show login) rather than
    // silently letting everyone through.
    return false;
  }
  const token =
