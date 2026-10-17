# BizPilot

Sales and expense tracking for barbershops, salons, print shops and any small shop.
Works as a website and as an installable app. Works **offline**; backs up and syncs when online.
Each shop has its own login and its own encrypted records.

## Deploy it as a real website

See **[DEPLOY.md](DEPLOY.md)** for step-by-step instructions (Render, free tier, environment variables, persistent data, etc.).

---

## Run it on Windows (PyCharm)

1. Open this folder in PyCharm. Create a virtual environment (Python 3.10+).
2. In the PyCharm terminal:
   ```
   pip install -r requirements.txt
   python app.py
   ```
3. Open http://localhost:5000/app and click **Start a free trial**.
4. The first time it starts it prints **an admin password** (shown once) and creates `instance/master.key`.
   **Back up `instance/master.key` somewhere safe and separate.** Without it, saved records cannot be read.
5. Owner admin panel: http://localhost:5000/admin

To try it from a phone on the same Wi-Fi: set `BIZPILOT_LAN=1`, run again, and open `http://<your PC's IP>:5000/app`.
(Installing as an app on a phone needs HTTPS, which comes with real hosting.)

## Bring in the old "sk printing" data

1. Start the app, register the account you want the data in.
2. Run: `python manage.py import-legacy --legacy path\to\bizpilot.db --email you@example.com`
   (add `--dry-run` first to preview). It is safe to run twice; nothing is duplicated.
3. Log in on any device; the records appear after the next sync.

## Subscriptions and licence keys (offline-capable)

You sell licence keys; customers type them in. Keys are signed so they cannot be forged, and each works once.

```
python license_tool.py generate-keys          # once. Keep license_private.pem secret and backed up.
python license_tool.py issue --private license_private.pem --customer "Sk Printing" --days 30
```

Put `license_public.pem` next to `app.py` (or set `BIZPILOT_LICENSE_PUBLIC_KEY`). Send the key to the customer after they pay you.
You can also grant time from the admin panel or `python manage.py grant --email x --days 30`.
Automatic online payments (Paynow) come in the next bit.

## What is encrypted, honestly

- Passwords: hashed (scrypt); never stored.
- Records (sales, expenses, items): encrypted with AES-256-GCM, a separate key per shop, those keys wrapped by the master key. Someone who copies the database file without the master key sees only ciphertext. Records can't be swapped between rows or shops without detection.
- Not encrypted: email, business name, subscription dates (needed to run the service).
- The server must decrypt records to sync them, so this protects stored data and backups, not against someone controlling the running server. Use full-disk encryption on the host too.
- In the browser, records are stored on the device for offline use; they are protected by the device's own security.
- Use HTTPS in production.

## Production checklist

- `BIZPILOT_PROD=1` (secure cookies), `BIZPILOT_PROXY=1` behind nginx/Caddy, HTTPS only.
- `BIZPILOT_MASTER_KEY` from `python manage.py new-master-key`, stored outside the database; `BIZPILOT_SECRET` set to a long random string.
- `gunicorn -w 2 -b 127.0.0.1:8000 app:app`
- Regular `python manage.py backup`; keep the master key backup separate.
- Add your contact details in the admin panel settings before charging real customers (the terms and privacy pages show a "Draft" note until set), and have a local professional review them.
- Rotating the master key: `python manage.py rotate-master-key --generate`.

## Tests

```
python -I tests/test_server.py        # server, encryption, licences, admin
python tests/e2e_browser.py http://localhost:5000   # real browser: offline + sync (server running)
```
