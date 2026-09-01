import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

const DB_PATH = process.env.PW_DB ?? "/mnt/usb/presswood-dev/presswood.db";
mkdirSync(DB_PATH.replace(/\/[^/]+$/, ""), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS presses(
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('har','spec','url')),
  label TEXT DEFAULT '',
  payload TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
  phase TEXT DEFAULT '',
  log TEXT DEFAULT '',
  artifact TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);`);

export function row(id: string) {
  return db.prepare("SELECT * FROM presses WHERE id=? OR token=?").get(id, id) as PressRow | undefined;
}

export interface PressRow {
  id: string; token: string; email: string; kind: string; label: string;
  payload: string; status: string; phase: string; log: string;
  artifact: string | null; error: string | null;
  created_at: number; updated_at: number; expires_at: number | null;
}
