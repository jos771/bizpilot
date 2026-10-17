"""Encryption for BizPilot business records.

Design (envelope encryption):
  * One master key (the "KEK") lives OUTSIDE the database: in the BIZPILOT_MASTER_KEY environment
    variable, or in instance/master.key (created with owner-only permissions on first run).
  * Every account gets its own random data key (the "DEK"). The DEK is stored in the database only
    after being encrypted ("wrapped") with the master key.
  * Every business record is encrypted with the account's DEK using AES-256-GCM. The account id and
    record id are bound into the ciphertext, so a record cannot be copied into another account or row.

Someone who steals only the database file can read nothing inside the records. They would also need
the master key. Losing the master key makes the records unrecoverable, so back it up separately.
"""
import base64
import json
import os
import secrets
import time
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

FORMAT = b"\x01"          # first byte of every encrypted blob; lets us change the format later
NONCE_BYTES = 12


class DecryptError(Exception):
    """A stored value could not be decrypted (wrong master key, or the data was altered)."""


def _decode_key(text, where):
    try:
        raw = base64.urlsafe_b64decode(text.strip() + "=" * (-len(text.strip()) % 4))
    except (ValueError, TypeError):
        raw = b""
    if len(raw) != 32:
        raise RuntimeError(f"The master key in {where} is not valid. It must be 32 random bytes, "
                           "base64url encoded. Run: python manage.py new-master-key")
    return raw


def encode_key(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii")


def load_master_key(data_dir: Path):
    configured = os.environ.get("BIZPILOT_MASTER_KEY", "").strip()
    if configured:
        return _decode_key(configured, "the BIZPILOT_MASTER_KEY environment variable")
    path = Path(data_dir) / "master.key"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        for _ in range(60):                         # another process may still be writing it
            text = path.read_text(encoding="utf-8").strip()
            if text:
                return _decode_key(text, str(path))
            time.sleep(0.05)
        raise RuntimeError(f"{path} is empty. Restore it from your backup.")
    raw = secrets.token_bytes(32)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(encode_key(raw))
    print(f"\n  Created a new master encryption key: {path}\n"
          "  BACK IT UP somewhere safe and separate from the database. Without it, saved records\n"
          "  cannot be decrypted. On a real server, put it in BIZPILOT_MASTER_KEY instead.\n", flush=True)
    return raw


class Vault:
    def __init__(self, data_dir: Path):
        self._kek = AESGCM(load_master_key(data_dir))

    # ---- account data keys ----
    @staticmethod
    def new_dek():
        return secrets.token_bytes(32)

    def wrap(self, dek, account_id):
        nonce = os.urandom(NONCE_BYTES)
        return FORMAT + nonce + self._kek.encrypt(nonce, dek, f"dek:{account_id}".encode())

    def unwrap(self, blob, account_id):
        try:
            if not blob or blob[:1] != FORMAT:
                raise ValueError("bad format")
            nonce, body = blob[1:1 + NONCE_BYTES], blob[1 + NONCE_BYTES:]
            return self._kek.decrypt(nonce, body, f"dek:{account_id}".encode())
        except Exception as exc:
            raise DecryptError("could not unlock the account key") from exc

    # ---- records ----
    @staticmethod
    def seal(dek, account_id, record_id, payload):
        nonce = os.urandom(NONCE_BYTES)
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return FORMAT + nonce + AESGCM(dek).encrypt(nonce, raw, f"rec:{account_id}:{record_id}".encode())

    @staticmethod
    def unseal(dek, account_id, record_id, blob):
        try:
            if not blob or blob[:1] != FORMAT:
                raise ValueError("bad format")
            nonce, body = blob[1:1 + NONCE_BYTES], blob[1 + NONCE_BYTES:]
            raw = AESGCM(dek).decrypt(nonce, body, f"rec:{account_id}:{record_id}".encode())
            return json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise DecryptError(f"could not read record {record_id}") from exc
