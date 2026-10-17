"""Database access shared by the web server (app.py) and the admin tool (manage.py)."""
import json
import os
import re
import sqlite3
import time
from pathlib import Path

from security import Vault

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("BIZPILOT_DATA") or BASE_DIR / "instance")
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "bizpilot-server.db"

vault = Vault(DATA_DIR)

RECORD_TYPES = {"tx", "item", "setting"}
RECORD_ID = re.compile(r"[A-Za-z0-9:_\-]{1,64}")
MAX_PAYLOAD_CHARS = 4000

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    business_name TEXT NOT NULL,
    business_type TEXT NOT NULL,
    dek BLOB NOT NULL DEFAULT x'',
    created_at INTEGER NOT NULL,
    trial_ends INTEGER NOT NULL,
    paid_until INTEGER NOT NULL DEFAULT 0,
    suspended INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL DEFAULT 0,
    last_sync INTEGER NOT NULL DEFAULT 0,
    tokens_valid_after INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS records (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    rt TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS records_seq ON records (account_id, seq);
CREATE TABLE IF NOT EXISTS redeemed_keys (
    jti TEXT PRIMARY KEY,
    account_id INTEGER,
    redeemed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    kind TEXT NOT NULL,
    ip TEXT,
    ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)   # autocommit; we use BEGIN where it matters
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")   # safe with WAL, much faster
    return conn


def init_db():
    conn = connect()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    conn.close()


def account_by_id(conn, account_id):
    return conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()


def account_by_email(conn, email):
    return conn.execute("SELECT * FROM accounts WHERE email = ?", (email.strip().lower(),)).fetchone()


def account_key(account):
    return vault.unwrap(account["dek"], account["id"])


def log_event(conn, account_id, kind, ip=None):
    conn.execute("INSERT INTO events (account_id, kind, ip, ts) VALUES (?,?,?,?)",
                 (account_id, kind, (ip or "")[:64], int(time.time())))
    conn.execute("DELETE FROM events WHERE ts < ?", (int(time.time()) - 90 * 86400,))


# ---------- encrypted records ----------
def clean_record(raw, now_ms):
    """Check one record sent by a device. Returns (id, type, updated_at, deleted, payload) or None."""
    if not isinstance(raw, dict):
        return None
    rid, rtype, updated = raw.get("id"), raw.get("rt"), raw.get("updated_at")
    if not isinstance(rid, str) or not RECORD_ID.fullmatch(rid) or rtype not in RECORD_TYPES:
        return None
    if not isinstance(updated, int) or isinstance(updated, bool) or updated <= 0:
        return None
    updated = min(updated, now_ms + 60_000)
    payload = {k: v for k, v in raw.items() if k not in ("id", "rt", "updated_at", "deleted", "dirty")}
    if len(json.dumps(payload, separators=(",", ":"))) > MAX_PAYLOAD_CHARS:
        return None
    return rid, rtype, updated, 1 if raw.get("deleted") else 0, payload


def put_records(conn, account, records, now_ms):
    """Encrypt and store records. The newest change to a record wins. Returns (accepted_ids, rejected_ids)."""
    dek = account_key(account)
    accepted, rejected = [], []
    conn.execute("BEGIN IMMEDIATE")
    try:
        seq = conn.execute("SELECT seq FROM accounts WHERE id = ?", (account["id"],)).fetchone()["seq"]
        for raw in records:
            rec = clean_record(raw, now_ms)
            if rec is None:
                rejected.append(raw.get("id") if isinstance(raw, dict) else None)
                continue
            rid, rtype, updated, deleted, payload = rec
            existing = conn.execute("SELECT updated_at FROM records WHERE account_id = ? AND id = ?",
                                    (account["id"], rid)).fetchone()
            if existing and existing["updated_at"] > updated:
                accepted.append(rid)                # the server already has something newer; the device will pull it
                continue
            seq += 1
            conn.execute(
                "INSERT OR REPLACE INTO records (account_id, id, rt, data, updated_at, deleted, seq) VALUES (?,?,?,?,?,?,?)",
                (account["id"], rid, rtype, vault.seal(dek, account["id"], rid, payload), updated, deleted, seq))
            accepted.append(rid)
        conn.execute("UPDATE accounts SET seq = ?, last_sync = ? WHERE id = ?", (seq, int(time.time()), account["id"]))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return accepted, rejected


def read_records(conn, account, since, limit):
    """Decrypt records changed after `since`. Returns (records, next_seq, more)."""
    dek = account_key(account)
    rows = conn.execute(
        "SELECT id, rt, data, updated_at, deleted, seq FROM records WHERE account_id = ? AND seq > ? "
        "ORDER BY seq LIMIT ?", (account["id"], since, limit + 1)).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    out = []
    for row in rows:
        rec = vault.unseal(dek, account["id"], row["id"], row["data"])
        rec.update(id=row["id"], rt=row["rt"], updated_at=row["updated_at"], deleted=bool(row["deleted"]))
        out.append(rec)
    return out, (rows[-1]["seq"] if rows else since), more
