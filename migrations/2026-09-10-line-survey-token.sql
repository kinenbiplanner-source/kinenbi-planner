-- line_users にアンケート用の本人確認トークンを足す（2026-09-10）。
--
-- 友だち追加のときに push するアンケートの案内リンクへ `?t=<token>` を付けるため。
-- 「どの LINE ユーザーに送ったか」はこちらが知っているのに、素の URL を送っていたので
-- その情報を捨てていた。結果、回答者と LINE の友だちが結びつかず、
-- 申し込みと違うメールアドレスを入れると 404 で回答ごと消えていた。
--
-- schema.sql は CREATE TABLE IF NOT EXISTS なので既存のテーブルには列が増えない。
-- SQLite の ADD COLUMN には IF NOT EXISTS が無いので、**直接流さず
-- `scripts/seo/migrate.ts` から流す**（PRAGMA table_info で無い列だけ足す。何度流しても安全）。
--
-- 列の意味は schema.sql の line_users のコメントが正。ここは複製。
ALTER TABLE line_users ADD COLUMN survey_token    TEXT NOT NULL DEFAULT '';
ALTER TABLE line_users ADD COLUMN survey_token_at TEXT NOT NULL DEFAULT '';
