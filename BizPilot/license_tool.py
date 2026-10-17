"""Offline BizPilot licence helper. Run this on YOUR computer. Keep the private key secret and backed up.

  python license_tool.py generate-keys --private C:\\BizPilotSeller\\license_private.pem --public C:\\BizPilotSeller\\license_public.pem
  python license_tool.py issue --private C:\\BizPilotSeller\\license_private.pem --customer "Sharp Cuts" --days 30
  python license_tool.py issue --private ... --customer "Sharp Cuts" --expires 2027-12-31
  python license_tool.py issue --private ... --customer "Sharp Cuts" --expires never

--days adds that many days from the moment the customer enters the key (and stacks on top of any time
they already have). Each key has a unique id and can be used by one shop, once.
"""
import argparse
import base64
import getpass
import json
import secrets
import sys
from datetime import date
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def b64url(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def new_keys(private_path, public_path):
    if private_path.exists() or public_path.exists():
        raise SystemExit("Refusing to overwrite a key file. Choose new paths or back up and remove existing files yourself.")
    password = getpass.getpass("Create a strong passphrase for the private signing key: ")
    confirm = getpass.getpass("Confirm passphrase: ")
    if len(password) < 12 or password != confirm:
        raise SystemExit("Passphrases must match and be at least 12 characters.")
    key = Ed25519PrivateKey.generate()
    private_bytes = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.BestAvailableEncryption(password.encode("utf-8")))
    public_bytes = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    private_path.parent.mkdir(parents=True, exist_ok=True)
    public_path.parent.mkdir(parents=True, exist_ok=True)
    private_path.write_bytes(private_bytes)
    public_path.write_bytes(public_bytes)
    print(f"Public key (copy into the BizPilot project as license_public.pem): {public_path}")
    print(f"Encrypted private key (keep offline and backed up): {private_path}")


def issue_key(private_path, customer, days, expiry):
    password = getpass.getpass("Private key passphrase: ")
    key = serialization.load_pem_private_key(private_path.read_bytes(), password.encode("utf-8"))
    payload = {"product": "bizpilot", "customer": customer[:80], "issued": date.today().isoformat(),
               "jti": secrets.token_urlsafe(12)}
    if days:
        payload["days"] = days
    else:
        payload["expires"] = expiry
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = key.sign(raw)
    print("BP1." + b64url(raw) + "." + b64url(signature))
    what = f"{days} days" if days else (f"until {expiry}" if expiry != "never" else "no expiry")
    print(f"(key id {payload['jti']} for {payload['customer']}, {what}. Give it to this customer only.)", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Create BizPilot offline licence keys.")
    commands = parser.add_subparsers(dest="command", required=True)
    gen = commands.add_parser("generate-keys", help="Create a signing key pair (once, on your seller computer).")
    gen.add_argument("--private", type=Path, required=True, help="Private key path outside the BizPilot project.")
    gen.add_argument("--public", type=Path, required=True, help="Public key path; copy this into the project as license_public.pem.")
    issue = commands.add_parser("issue", help="Issue a licence after you confirm payment has cleared.")
    issue.add_argument("--private", type=Path, required=True)
    issue.add_argument("--customer", required=True, help="Customer or business name (no private financial details).")
    length = issue.add_mutually_exclusive_group()
    length.add_argument("--days", type=int, help="Number of days the key adds (1 to 3660).")
    length.add_argument("--expires", default=None, help="ISO date YYYY-MM-DD or 'never'.")
    args = parser.parse_args()
    if args.command == "generate-keys":
        new_keys(args.private, args.public)
        return
    if args.days is None and args.expires is None:
        args.days = 30
    if args.days is not None and not 1 <= args.days <= 3660:
        raise SystemExit("--days must be between 1 and 3660.")
    if args.expires not in (None, "never"):
        try:
            date.fromisoformat(args.expires)
        except ValueError:
            raise SystemExit("Expiry must be YYYY-MM-DD or 'never'.")
    issue_key(args.private, args.customer, args.days, args.expires)


if __name__ == "__main__":
    main()
