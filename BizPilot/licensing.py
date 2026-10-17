"""Signed licence keys.

Keys are made on YOUR computer with license_tool.py (the private signing key never goes on the
server). The server only holds the public key, so it can check a key is genuine but cannot make one.
Each key has a unique id and works for one shop, once.
"""
import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_KEY_PATH = Path(os.environ.get("BIZPILOT_LICENSE_PUBLIC_KEY") or BASE_DIR / "license_public.pem")
FAR_FUTURE = int(datetime(2100, 1, 1, tzinfo=timezone.utc).timestamp())
DAY = 86400


class LicenseError(Exception):
    """Raised with a message that is safe to show to the customer."""


def _b64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_token(token, now=None):
    """Return the payload of a genuine, unexpired key, or raise LicenseError."""
    now = now or datetime.now(timezone.utc).timestamp()
    if not PUBLIC_KEY_PATH.is_file():
        raise LicenseError("Licence keys are not set up on this server yet. Please contact support.")
    try:
        prefix, payload_part, signature_part = "".join(str(token).split()).split(".", 2)
        if prefix != "BP1":
            raise ValueError("prefix")
        payload_bytes, signature = _b64(payload_part), _b64(signature_part)
        public_key = serialization.load_pem_public_key(PUBLIC_KEY_PATH.read_bytes())
        public_key.verify(signature, payload_bytes)
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (ValueError, TypeError, InvalidSignature, OSError, json.JSONDecodeError):
        raise LicenseError("That licence key is not valid. Check it was copied completely.") from None

    jti = payload.get("jti")
    if payload.get("product") != "bizpilot" or not isinstance(jti, str) or not 8 <= len(jti) <= 64:
        raise LicenseError("That licence key is an old format. Ask for a new one.")
    days = payload.get("days")
    if days is not None:
        if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 3660:
            raise LicenseError("That licence key is not valid.")
    else:
        expires = payload.get("expires")
        if expires != "never":
            try:
                end = datetime.strptime(expires, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
            except (ValueError, TypeError):
                raise LicenseError("That licence key is not valid.") from None
            if end.timestamp() < now:
                raise LicenseError("That licence key has expired.")
    return payload


def apply_license(paid_until, payload, now=None):
    """Work out the new paid-until time (epoch seconds) after adding this key."""
    now = int(now or datetime.now(timezone.utc).timestamp())
    if payload.get("days") is not None:
        return max(now, paid_until) + payload["days"] * DAY
    if payload["expires"] == "never":
        return FAR_FUTURE
    end = datetime.strptime(payload["expires"], "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
    return max(paid_until, int(end.timestamp()))
