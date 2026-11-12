-- D1専用。アプリ起動時には適用しない。
CREATE TABLE compass_d1_guard (
  id TEXT PRIMARY KEY NOT NULL,
  satisfied INTEGER NOT NULL,
  CONSTRAINT compass_d1_precondition CHECK (satisfied = 1)
);
