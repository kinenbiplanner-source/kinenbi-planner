-- keywords テーブルに SEO 列を足す（2026-09-10）。
--
-- schema.sql は CREATE TABLE IF NOT EXISTS なので、既にあるテーブルには列が増えない。
-- 既存の D1 にはこのファイルを流す。SQLite の ADD COLUMN には IF NOT EXISTS が無いので、
-- **直接流さず `scripts/seo/migrate.ts` から流す**（PRAGMA table_info で無い列だけ足す。何度流しても安全）。
--
-- 列の意味は schema.sql の keywords のコメントが正。ここは複製。
ALTER TABLE keywords ADD COLUMN seed          TEXT    NOT NULL DEFAULT '';
ALTER TABLE keywords ADD COLUMN volume_num    INTEGER;
ALTER TABLE keywords ADD COLUMN volume_source TEXT    NOT NULL DEFAULT '';
ALTER TABLE keywords ADD COLUMN demand_score  INTEGER;
ALTER TABLE keywords ADD COLUMN kd            INTEGER;
ALTER TABLE keywords ADD COLUMN serp_grade    TEXT    NOT NULL DEFAULT '';
ALTER TABLE keywords ADD COLUMN serp_note     TEXT    NOT NULL DEFAULT '';
ALTER TABLE keywords ADD COLUMN researched_at TEXT    NOT NULL DEFAULT '';
