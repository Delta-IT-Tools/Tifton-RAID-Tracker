# TIFTON Go-Live Tracker

A password-protected RAID/issue tracker for the TIFTON go-live — Board,
Table, Calendar, and Completed views, DevOps ticket linking, Walmart
blocker flagging, due-date calendaring, and an email-friendly Copy View —
deployed as a Cloudflare Worker, with a shared database so everyone who
signs in sees the same data.

**Everything below is done through your web browser — GitHub's website and
the Cloudflare dashboard. No terminal, no command line, no local installs.**

## How this is put together

- **`public/index.html`** — the tracker itself: all the UI, views, and
  logic, as one self-contained page. Served as a static file.
- **`src/index.js`** — a single Worker script that: checks the password
  and a signed session cookie before anything else is served, handles the
  `/api/issues` endpoint (reads/writes the shared issue list via D1), and
  otherwise serves `public/index.html` and its assets.
- **`schema.sql`** — the one-time database setup script (Part 2 below).
- **`wrangler.toml`** — tells Cloudflare where the static files live
  (`[assets]`), which script runs (`main`), and which database to bind
  (`[[d1_databases]]`).

Nothing sensitive lives in this repo: the password and the database ID are
both configured after deployment, through the Cloudflare dashboard, never
committed to git.

### Why a single Worker script instead of Pages Functions

Cloudflare has two related products here — classic "Pages" (with a
`functions/` folder of separate files) and plain "Workers" (one script,
now with a `[assets]` binding for serving static files too). Depending on
your account, connecting a repo through the dashboard can register the
project as either one. This repo targets the **Worker** model — one
script (`src/index.js`) handling everything — because that's what several
rounds of troubleshooting confirmed this account actually creates. If
`wrangler pages deploy` ever tells you a Pages project "does not exist",
that's the same signal: the project is a Worker, and `wrangler deploy` is
the right command for it.

## Part 1 — Get this repo onto GitHub

1. Unzip the downloaded folder on your computer (double-click it — no
   terminal needed, your OS's built-in unzip handles this).
2. Go to **github.com** and sign in. Click the **+** icon (top right) →
   **New repository**.
3. Name it (e.g. `tifton-raid-tracker`), choose **Private** or **Public**
   as you prefer, and click **Create repository** — leave it empty, don't
   check any of the "initialize with" boxes.
4. On the new empty repo's page, click the **"uploading an existing
   file"** link in the middle of the page.
5. Open the unzipped folder on your computer and **drag the whole thing**
   in — the `public` folder, `src` folder, `wrangler.toml`, `schema.sql`,
   and `.gitignore`. (Modern browsers preserve folder structure when you
   drag folders in, so `public/index.html` stays at that path rather than
   landing loose at the top level. If your browser only accepts
   individual files, open each folder and drag its contents in one at a
   time, recreating the same folder names.)
6. Scroll down and click **Commit changes**.
7. Confirm the file list on the repo's main page shows `public/`, `src/`,
   `wrangler.toml`, `schema.sql`, and `.gitignore` as separate
   folders/files — not everything dumped loose at the top level. If the
   structure looks wrong, delete the files (each file's page has a
   trash-can icon) and re-upload.

## Part 2 — Create the shared database (D1)

1. Cloudflare dashboard → look for **Storage & Databases** in the left
   sidebar → **D1 SQL Database** → **Create**.
2. Name it `tifton-golive-tracker-db` and create it.
3. Once it's created, open it and find the **Console** tab (sometimes
   labeled "Query"). This lets you run SQL directly in the browser.
4. Open `schema.sql` from this repo (on github.com, click the file, then
   copy everything shown). Paste it into the Console and run it. You
   should see a success message — this creates the one table the tracker
   needs.
5. On the database's **Overview** tab, find and copy the **Database ID**
   (a long string of letters/numbers/dashes).
6. Back in your GitHub repo, open `wrangler.toml`, click the **pencil
   (edit) icon**, and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the
   ID you just copied. Commit the change directly on the `main` branch.

## Part 3 — Connect the repo to Cloudflare

1. Cloudflare dashboard → **Workers & Pages** → **Create**.
2. Connect to Git, authorize Cloudflare's GitHub App if prompted, and
   select the repo you just created.
3. Build settings:
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy`
     (Not `wrangler pages deploy` — see the note above on why.)
4. **Before** clicking Deploy, go to this project's **Settings → Builds →
   API token** field. Don't leave whatever default is auto-selected —
   click into it and either pick or create a token that has **Account →
   Cloudflare Pages → Edit** *and* the general Workers permissions
   (creating a token from Cloudflare's own suggested templates and adding
   both if unsure is fine). Confirm the token you intend is actually
   selected in this field before deploying.
5. Click **Save and Deploy**.

If the deployment fails with `wrangler: not found`, the Deploy command is
missing `npx` at the front.

If it fails with an **Authentication error [code: 10000]**, the token
selected in that API token field doesn't have the right permissions —
open that exact token at dash.cloudflare.com/profile/api-tokens and check
its Permissions list line by line rather than assuming it's right.

If it fails with **"The Pages project does not exist"**, the Deploy
command is still set to `wrangler pages deploy` somewhere — it needs to
be plain `wrangler deploy` for this repo.

## Part 4 — Set your password

1. In your Worker's project, go to **Settings → Variables and Secrets**.
2. Click **Add**. Name it exactly `SITE_PASSWORD`, enter the password you
   want to use, and toggle **Encrypt** before saving.
3. Click **Add** again. Name it exactly `SESSION_SECRET`, and paste in any
   long random string (it doesn't need to be memorable — it just signs
   your session cookies). One easy source:
   [randomkeygen.com](https://randomkeygen.com), any of the long keys
   shown there. Encrypt this one too.
4. Go to the **Deployments** tab and **Retry deployment** on the latest
   one so it picks up everything from Parts 2–4.
5. Visit your `*.workers.dev` URL. You should see a login page. Enter the
   password — you'll be signed in for 30 days, and so will anyone else you
   share the password and URL with.

## Using it day to day

- Visit your site's URL, enter the password once.
- All the tracker features work as before: Board/Table/Calendar/Completed
  views, filters (area, status, Walmart blocker, missing DevOps#/due date),
  search, add/edit/delete issues, Copy View (rich HTML + plain text), and
  JSON Export/Import.
- **Data is shared** — anyone who signs in with the password sees the same
  issues you do, and edits from any of you show up for everyone else
  (refresh to see someone else's latest changes; there's no live
  auto-refresh). If two people edit at the exact same moment, the last
  save wins — there's no merge logic.
- Click "Log out" at the bottom of the tool to clear your session early.

## Making future changes

**For a small change:** open `public/index.html` in your repo on
github.com, click the **pencil (edit) icon**, make the change directly in
the browser, and commit. Cloudflare picks up the change and redeploys
automatically within a minute or two.

**For a change Claude makes for you:** Claude will give you the full,
updated `public/index.html` file. On github.com, open that file, click the
trash-can icon to delete it, commit that deletion, then use **Add file →
Upload files** to upload the new version at the same path. Commit again —
that triggers the redeploy.

`src/index.js` (the password gate and database API) shouldn't need to
change unless you want to adjust session length or the data model.

## Changing the password later

Cloudflare dashboard → your project → **Settings → Variables and
Secrets** → edit `SITE_PASSWORD` → save → **Retry deployment** so it takes
effect. Existing signed-in sessions stay valid until their cookie expires
(30 days) or you also rotate `SESSION_SECRET`, which invalidates every
session at once.

## Backing up or moving your data

Because the data lives in D1 rather than any one person's browser, the
tracker's own **Export JSON** button (at the bottom of the tool) is the
easiest way to get a full backup at any time — it downloads everything
currently in the shared database. **Import JSON** does the reverse:
replaces everything in the shared database with the contents of a file
you pick (with a confirmation step first, since this affects everyone).

## Project structure

```
tifton-raid-tracker/
├── public/index.html   ← the tracker itself
├── src/index.js        ← password gate + session cookie + D1-backed API + static serving
├── schema.sql           ← one-time database setup (Part 2)
├── wrangler.toml        ← entry point, static assets, D1 binding
├── .gitignore
└── README.md
```
