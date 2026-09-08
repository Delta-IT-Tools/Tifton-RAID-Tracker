# TIFTON Go-Live Tracker

A password-protected RAID/issue tracker for the TIFTON go-live — Board,
Table, Calendar, and Completed views, DevOps ticket linking, Walmart
blocker flagging, due-date calendaring, and an email-friendly Copy View —
all in a single static page, deployed on Cloudflare Pages.

**Everything below is done through your web browser — GitHub's website and
the Cloudflare dashboard. No terminal, no command line, no local installs.**

## How the password protection works

Every request to the site passes through a Cloudflare Pages Function
(`functions/_middleware.js`) before anything is served:

- If you have a valid signed session cookie, you're let through.
- Otherwise, you see a login page. Enter the correct password and you're
  redirected back in, with a cookie that keeps you signed in for 30 days.
- The check happens **server-side**, so it can't be bypassed by viewing
  page source — unlike a password baked into client-side JavaScript.
- The actual password is never stored in this repo. It's set as an
  encrypted environment variable in the Cloudflare dashboard (Part 2
  below), which only you can see or change.

This is intentionally simple: one shared password for anyone who has it,
no individual user accounts, no audit trail of who signed in. That's a
reasonable fit for a small internal tool where everyone with the password
is trusted.

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
   — the `public` folder, `functions` folder, `wrangler.toml`, and
   `.gitignore` — into the browser upload area. (Modern browsers preserve
   folder structure when you drag folders in, so `public/index.html` stays
   at that path rather than landing loose at the top level. If your
   browser only accepts individual files, open each folder and drag its
   contents in one at a time, recreating the same folder names.)
6. Scroll down and click **Commit changes**.
7. Confirm the file list on the repo's main page now shows `public/`,
   `functions/`, `wrangler.toml`, and `.gitignore` as separate folders/files
   — not everything dumped loose at the top level. If the structure looks
   wrong, delete the files (each file's page has a trash-can icon) and
   re-upload.

## Part 2 — Connect it to Cloudflare Pages

1. Go to the **Cloudflare dashboard** → **Workers & Pages** → **Create** →
   **Pages** tab → **Connect to Git**.
2. Authorize Cloudflare's GitHub App if prompted, then select the repo you
   just created.
3. On the build settings screen:
   - **Framework preset:** None
   - **Build command:** leave empty
   - **Build output directory:** `public`
   (This site needs no build step at all — it's already ready to serve.)
4. Click **Save and Deploy**. The first deployment will go out working, but
   the password gate won't be live yet — that needs Part 3 first.

## Part 3 — Set your password

1. In your new Pages project, go to **Settings → Environment variables**.
2. Click **Add variable**. Name it exactly `SITE_PASSWORD`, enter the
   password you want to use, and — importantly — click the **Encrypt**
   toggle/button next to it before saving. Do this for both the
   **Production** and **Preview** environments (there's usually a toggle
   or separate tab for each).
3. Click **Add variable** again. Name it exactly `SESSION_SECRET`, and for
   the value, paste in any long random string — it doesn't need to be
   memorable, it's just used internally to sign your session cookies.
   (One easy way to get a random string: visit
   [randomkeygen.com](https://randomkeygen.com) and copy any of the long
   keys shown there.) Encrypt this one too, for both environments.
4. Save. Then go to the **Deployments** tab and use **Retry deployment**
   (or trigger a new one) on the latest deployment so it picks up the new
   variables.
5. Visit your `*.pages.dev` URL. You should see a login page. Enter the
   password from step 2 — you'll be signed in for 30 days.

## Using it day to day

- Visit your site's URL, enter the password once.
- All the tracker features work as before: Board/Table/Calendar/Completed
  views, filters (area, status, Walmart blocker, missing DevOps#/due date),
  search, add/edit/delete issues, Copy View (rich HTML + plain text), and
  JSON Export/Import.
- Data is stored in your browser's local storage tied to this page, per
  person — it does not sync between different browsers/devices
  automatically. Use Export/Import to move data between them, or to back
  it up.
- Click "Log out" at the bottom of the tool to clear your session early.

## Making future changes

If you want Claude to help you update the tracker later, the update itself
still happens entirely on github.com:

**For a small change:** open `public/index.html` in your repo on
github.com, click the **pencil (edit) icon** in the top right of the file
view, make the change directly in the browser, and commit. Cloudflare Pages
picks up the change and redeploys automatically within a minute or two.

**For a change Claude makes for you:** Claude will give you the full,
updated `public/index.html` file. On github.com, open that file, click the
trash-can icon to delete it, commit that deletion, then use **Add file →
Upload files** to upload the new version at the same path. Commit again —
that triggers the redeploy.

The password gate in `functions/_middleware.js` shouldn't need to change
unless you want to adjust session length or add features like changing
the password without touching environment variables.

## Changing the password later

Cloudflare dashboard → your Pages project → **Settings → Environment
variables** → edit `SITE_PASSWORD` → save → **Retry deployment** on the
latest deployment so it takes effect. Existing signed-in sessions stay
valid until their cookie expires (30 days) or you also rotate
`SESSION_SECRET`, which invalidates every session at once.

## Project structure

```
tifton-golive-tracker/
├── public/index.html          ← the tracker itself (self-contained HTML/CSS/JS)
├── functions/_middleware.js   ← password gate + signed session cookie
├── wrangler.toml              ← tells Cloudflare where the static files live
├── .gitignore
└── README.md
```

There's deliberately no `package.json` or build tooling here — this site
doesn't need one, and skipping it avoids an entire class of build-pipeline
problems (stale build tokens, dependency install failures, tool-version
mismatches) that only show up when a build step exists in the first place.
