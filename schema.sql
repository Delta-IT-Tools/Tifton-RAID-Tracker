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

-- Records a full snapshot every time a new RAID log is uploaded via the
-- "Upload RAID Log" button. status_counts is a small JSON summary
-- (e.g. {"open":40,"closed":12,...}) for quick display in the History
-- view without needing to load the full item list; data is the complete
-- item-level snapshot at that moment, kept so trend/duration analysis
-- (e.g. "how long has item #128 been in Testing") can be computed later
-- by comparing snapshots, not just the current totals.

CREATE TABLE IF NOT EXISTS raid_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uploaded_at TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  status_counts TEXT NOT NULL,
  data TEXT NOT NULL
);
