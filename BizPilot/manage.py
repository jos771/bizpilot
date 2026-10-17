"""BizPilot admin tool. Run on the machine that hosts the app:  python manage.py <command> --help

  import-legacy      bring the records from the old single-shop bizpilot.db into an account
  backup             copy the database to backups/ (records stay encrypted inside the copy)
  grant              add subscription days to an account
  set-admin-password choose the password for /admin
  new-master-key     print a fresh random master key
  rotate-master-key  switch to a new master key (re-wraps every account key; records are not touched)
"""
import argparse
import getpass
import os
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import store
from werkzeug.security import generate_password_hash
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import secrets

from security import FORMAT, NONCE_BYTES, _decode_key, encode_key

DAY = 86400


def need_account(conn, email):
    account = store.account_by_email(conn, email)
    if not account:
        raise SystemExit(f"No account with email {email}. Register it in the app first, then run this again.")
    return account


def to_ms(text):
    """Legacy created_at looks like 2026-10-14 08:30:00 (UTC)."""
    try:
        return int(datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp() * 1000)
    except (ValueError, TypeError):
        return int(time.time() * 1000)


def import_legacy(args):
    legacy_path = Path(args.legacy)
    if not legacy_path.is_file():
        raise SystemExit(f"Cannot find {legacy_path}")
    old = sqlite3.connect(f"file:{legacy_path.resolve().as_posix()}?mode=ro", uri=True)
    old.row_factory = sqlite3.Row
    conn = store.connect()
    account = need_account(conn, args.email)

    existing, _, _ = store.read_records(conn, account, 0, 100000)
    have_items = {(r["kind"], r["name"].strip().lower()) for r in existing if r["rt"] == "item" and not r["deleted"]}
    have_ids = {r["id"] for r in existing}

    records = []
    for row in old.execute("SELECT * FROM catalog ORDER BY id"):
        if (row["kind"], row["name"].strip().lower()) in have_items or f"legacy-item-{row['id']}" in have_ids:
            continue
        records.append({"id": f"legacy-item-{row['id']}", "rt": "item", "updated_at": int(time.time() * 1000),
                        "kind": row["kind"], "name": row["name"], "price_cents": row["price_cents"], "order": 100 + row["id"]})
    tx_rows = old.execute("SELECT * FROM transactions ORDER BY id").fetchall()
    new_tx = 0
    for row in tx_rows:
        rid = f"legacy-{row['id']}"
        if rid in have_ids:
            continue
        created = to_ms(row["created_at"])
        records.append({"id": rid, "rt": "tx", "updated_at": created, "type": row["kind"], "label": row["label"],
                        "qty": row["qty"] or 1, "amount_cents": row["amount_cents"], "method": row["payment_method"] or "Cash",
                        "note": row["note"] or "", "date": row["tx_date"], "created": created})
        new_tx += 1
    new_items = len(records) - new_tx
    print(f"Account {args.email}: {new_tx} of {len(tx_rows)} transactions and {new_items} catalogue items to import "
          "(anything already there is skipped).")
    if args.dry_run or not records:
        print("Nothing written." if args.dry_run else "Nothing new to import.")
        return
    for start in range(0, len(records), 400):
        accepted, rejected = store.put_records(conn, store.account_by_id(conn, account["id"]), records[start:start + 400],
                                               int(time.time() * 1000))
        if rejected:
            raise SystemExit(f"Some records were rejected: {rejected}")
    print("Done. Open BizPilot on your devices; the records appear after the next sync.")


def backup(args):
    target = Path(args.to or store.BASE_DIR / "backups")
    target.mkdir(parents=True, exist_ok=True)
    dest = target / f"bizpilot-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    src = store.connect()
    out = sqlite3.connect(dest)
    src.backup(out)
    out.close()
    src.close()
    print(f"Backup written to {dest}")
    print("The records inside are encrypted. Keep the master key (instance/master.key) in a DIFFERENT safe place;\n"
          "without it a backup cannot be read.")


def grant(args):
    conn = store.connect()
    account = need_account(conn, args.email)
    paid = max(int(time.time()), account["paid_until"]) + args.days * DAY
    conn.execute("UPDATE accounts SET paid_until = ? WHERE id = ?", (paid, account["id"]))
    print(f"{args.email} is paid until {datetime.fromtimestamp(paid).strftime('%d %b %Y')}.")


def set_admin_password(_args):
    first = getpass.getpass("New admin password (12+ characters): ")
    if len(first) < 12 or first != getpass.getpass("Repeat it: "):
        raise SystemExit("Passwords must match and be at least 12 characters.")
    conn = store.connect()
    conn.execute("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('admin_pw_hash', ?)", (generate_password_hash(first),))
    print("Admin password updated.")


def new_master_key(_args):
    print(encode_key(secrets.token_bytes(32)))


def rotate_master_key(args):
    new_raw = secrets.token_bytes(32) if args.generate else None
    if args.new_key:
        new_raw = _decode_key(args.new_key, "--new-key")
    if new_raw is None:
        raise SystemExit("Give --generate or --new-key.")
    new_aes = AESGCM(new_raw)
    conn = store.connect()
    rewrapped = []
    for row in conn.execute("SELECT id, dek FROM accounts"):
        dek = store.vault.unwrap(row["dek"], row["id"])
        nonce = os.urandom(NONCE_BYTES)
        rewrapped.append((FORMAT + nonce + new_aes.encrypt(nonce, dek, f"dek:{row['id']}".encode()), row["id"]))
    key_file = store.DATA_DIR / "master.key"
    from_env = bool(os.environ.get("BIZPILOT_MASTER_KEY", "").strip())
    staged = store.DATA_DIR / "master.key.new"
    fd = os.open(staged, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(encode_key(new_raw))
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.executemany("UPDATE accounts SET dek = ? WHERE id = ?", rewrapped)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    print(f"Re-wrapped {len(rewrapped)} account keys with the new master key.")
    if from_env:
        print("Your key comes from BIZPILOT_MASTER_KEY. Set it to this NEW value now, then restart the app:\n  " + encode_key(new_raw))
        print(f"(also saved in {staged}; delete that file once you have stored the key safely)")
    else:
        if key_file.exists():
            shutil.copy2(key_file, store.DATA_DIR / "master.key.old")
        os.replace(staged, key_file)
        print(f"{key_file} now holds the new key. The previous one is in master.key.old. Back up the new key, "
              "then delete master.key.old once you are sure everything works.")


def main():
    parser = argparse.ArgumentParser(description="BizPilot admin tool.")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("import-legacy", help="Import records from the old single-shop bizpilot.db.")
    p.add_argument("--legacy", required=True, help="Path to the old bizpilot.db")
    p.add_argument("--email", required=True, help="Email of the account (already registered in the app) to import into")
    p.add_argument("--dry-run", action="store_true", help="Show what would be imported without writing")
    p.set_defaults(func=import_legacy)
    p = sub.add_parser("backup", help="Copy the database to backups/.")
    p.add_argument("--to", help="Folder to write the backup to")
    p.set_defaults(func=backup)
    p = sub.add_parser("grant", help="Add subscription days to an account.")
    p.add_argument("--email", required=True)
    p.add_argument("--days", type=int, required=True)
    p.set_defaults(func=grant)
    sub.add_parser("set-admin-password", help="Set the /admin password.").set_defaults(func=set_admin_password)
    sub.add_parser("new-master-key", help="Print a new random master key.").set_defaults(func=new_master_key)
    p = sub.add_parser("rotate-master-key", help="Switch to a new master key.")
    p.add_argument("--generate", action="store_true")
    p.add_argument("--new-key")
    p.set_defaults(func=rotate_master_key)
    args = parser.parse_args()
    store.init_db()
    args.func(args)


if __name__ == "__main__":
    main()
