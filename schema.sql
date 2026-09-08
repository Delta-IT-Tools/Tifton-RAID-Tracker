-- Run this once in the D1 database's "Console" tab in the Cloudflare
-- dashboard, right after creating the database. See README.md for the
-- full walkthrough.
--
-- This creates a single table holding the tracker's entire issue list as
-- one JSON blob per row. There is (and only ever will be) exactly one row
-- in this table, with id = 'issues' -- that's intentional. The tracker's
-- UI already works with the full issue list as a single unit (the same
-- way it worked with browser storage before), so this mirrors that shape
-- rather than splitting issues into individual database rows.

CREATE TABLE IF NOT EXISTS tracker_data (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  data_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
