# TIFTON Go-Live Tracker

A password-protected RAID/issue tracker for the TIFTON go-live — Board,
Table, Calendar, and Completed views, DevOps ticket linking, Walmart
blocker flagging, due-date calendaring, and an email-friendly Copy View —
deployed on Cloudflare Pages, with a shared database so everyone who signs
in sees the same data.

**Everything below is done through your web browser — GitHub's website and
the Cloudflare dashboard. No terminal, no command line, no local installs.**

## How this is put together

- **`public/index.html`** — the tracker itself: all the UI, views, and
  logic, as one self-contained page.
- **`functions/_middleware.js`** — a password gate that every request
  passes through first. Checks a password server-side and issues a signed
  30-day session cookie. Can't be bypassed by viewing page source, unlike
  a password baked into client-side JavaScript.
- **`functions/api/issues.js`** — a small API the tracker's page calls to
  read and save the issue list from a real, shared database (D1) rather
  than your own browser's local storage. This is what makes the data the
  same for everyone who logs in, on any device.
- **`schema.sql`** — the one-time database setup script (Part 2 below).

Nothing sensitive lives in this repo: the password and the database ID are
both configured after deployment, through the Cloudflare dashboard, never
committed to git.

## Part 1 — Get this repo onto GitHub

1. Unzip the downloaded folder on your computer (double-click it — no
   terminal needed, your OS's built-in unzip handles this).
2. Go to **github.com** and sign in. Click the **+** icon (top right) →
   **New repository**.
3. Name it (e.g. `tifton-golive-tracker`), choose **Private** or **Public**
   as you prefer, and click **Create repository** — leave it empty, don't
   check any of the "initialize with" boxes.
4. On the new empty repo's page, click the **"uploading an existing
   file"** link in the middle of the page.
5. Open the unzipped folder on your computer and **drag the whole thing**
   in — the `public` folder, `functions` folder, `wrangler.toml`,
   `schema.sql`, and `.gitignore`. (Modern browsers preserve folder
   structure when you drag folders in, so `public/index.html` stays at
   that path rather than landing loose at the top level. If your browser
   only accepts individual files, open each folder and drag its contents
   in one at a time, recreating the same folder names.)
6. Scroll down and click **Commit changes**.
7. Confirm the file list on the repo's main page shows `public/`,
   `functions/`, `wrangler.toml`, `schema.sql`, and `.gitignore` as
   separate folders/files — not everything dumped loose at the top level.
   If the structure looks wrong, delete the files (each file's page has a
   trash-can icon) and re-upload.

## Part 2 — Create the shared database (D1)

1. Cloudflare dashboard → look for **Storage & Databases** in the left
   sidebar (on some accounts this is still listed under **Workers &
   Pages**) → **D1 SQL Database** → **Create**.
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

## Part 3 — Connect the repo to Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** tab
   → **Connect to Git**.
2. Authorize Cloudflare's GitHub App if prompted, then select the repo you
   just created.
3. On the build settings screen:
   - **Framework preset:** None
   - **Build command:** leave empty
   - **Build output directory:** `public`
   - **Deploy command:** `npx wrangler pages deploy public`
     (Some Cloudflare accounts require this field to be non-empty; `npx`
     lets it fetch `wrangler` on the fly, no install needed.)
4. Click **Save and Deploy**.

If the deployment fails with `wrangler: not found`, the Deploy command
above is missing the `npx` prefix or the `public` argument — check it
matches exactly.

If it fails with an **Authentication error [code: 10000]** mentioning
`CLOUDFLARE_API_TOKEN`, go to **Settings → Environment variables** on this
project, check both the Production and Preview tabs for a variable named
`CLOUDFLARE_API_TOKEN`, and delete it if present (in both environments).
This project's native Cloudflare-triggered build doesn't need an injected
token — it already has implicit permission to deploy to itself.

## Part 4 — Set your password

1. In your Pages project, go to **Settings → Environment variables**.
2. Click **Add variable**. Name it exactly `SITE_PASSWORD`, enter the
   password you want to use, and click the **Encrypt** toggle before
   saving. Do this for both the **Production** and **Preview** environments.
3. Click **Add variable** again. Name it exactly `SESSION_SECRET`, and
   paste in any long random string (it doesn't need to be memorable — it
   just signs your session cookies). One easy source for a random string:
   [randomkeygen.com](https://randomkeygen.com), any of the long keys
   shown there. Encrypt this one too, for both environments.
4. Go to the **Deployments** tab and **Retry deployment** on the latest one
   so it picks up everything from Parts 2–4.
5. Visit your `*.pages.dev` URL. You should see a login page. Enter the
   password — you'll be signed in for 30 days, and so will anyone else you
   share the password and URL with.

## Using it day to day

- Visit your site's URL, enter the password once.
- All the tracker features work as before: Board/Table/Calendar/Completed
  views, filters (area, status, Walmart blocker, missing DevOps#/due date),
  search, add/edit/delete issues, Copy View (rich HTML + plain text), and
  JSON Export/Import.
- **Data is now shared** — anyone who signs in with the password sees the
  same issues you do, and edits from any of you show up for everyone else
  (refresh to see someone else's latest changes; there's no live
  auto-refresh). If two people edit at the exact same moment, the last
  save wins — there's no merge logic.
- Click "Log out" at the bottom of the tool to clear your session early.

## Making future changes

If you want Claude to help you update the tracker later, the update itself
still happens entirely on github.com:

**For a small change:** open `public/index.html` in your repo on
github.com, click the **pencil (edit) icon**, make the change directly in
the browser, and commit. Cloudflare Pages picks up the change and
redeploys automatically within a minute or two.

**For a change Claude makes for you:** Claude will give you the full,
updated `public/index.html` file. On github.com, open that file, click the
trash-can icon to delete it, commit that deletion, then use **Add file →
Upload files** to upload the new version at the same path. Commit again —
that triggers the redeploy.

The password gate (`functions/_middleware.js`) and the database API
(`functions/api/issues.js`) shouldn't need to change unless you want to
adjust session length or the data model.

## Changing the password later

Cloudflare dashboard → your Pages project → **Settings → Environment
variables** → edit `SITE_PASSWORD` → save → **Retry deployment** on the
latest deployment so it takes effect. Existing signed-in sessions stay
valid until their cookie expires (30 days) or you also rotate
`SESSION_SECRET`, which invalidates every session at once.

## Backing up or moving your data

Because the data now lives in D1 rather than any one person's browser,
the tracker's own **Export JSON** button (at the bottom of the tool) is
the easiest way to get a full backup at any time — it downloads everything
currently in the shared database. **Import JSON** does the reverse:
replaces everything in the shared database with the contents of a file you
pick (with a confirmation step first, since this affects everyone).

## Project structure

```
tifton-golive-tracker/
├── public/index.html          ← the tracker itself
├── functions/
│   ├── _middleware.js         ← password gate + signed session cookie
│   └── api/issues.js          ← reads/writes the shared issue list via D1
├── schema.sql                 ← one-time database setup (Part 2)
├── wrangler.toml              ← static file location + D1 binding
├── .gitignore
└── README.md
```

There's deliberately no `package.json` or build tooling here — this site
doesn't need one, and skipping it avoids an entire class of build-pipeline
problems (stale build tokens, dependency install failures, tool-version
mismatches) that only show up when a build step exists in the first place.
