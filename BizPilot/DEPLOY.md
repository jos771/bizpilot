# BizPilot — Production Deployment Guide

This guide gets you a **real public website** that works offline-first, keeps data encrypted, and is ready for real shops.

## Recommended free / cheap hosts

| Host       | Free tier? | Persistent data?          | Notes                              |
|------------|------------|---------------------------|------------------------------------|
| **Render** | Yes        | Ephemeral (or paid disk)  | Easiest. Use paid disk for real use |
| Railway    | Credits    | Yes (volume)              | Good alternative                   |
| Fly.io     | Free tier  | Yes (volume)              | Slightly more setup                |
| Neon + any | Free DB    | Yes (Postgres)            | Best long-term (needs code change) |

For most people starting out: **Render free** is fine for testing.  
For a real shop that must keep records: add a **persistent disk** on Render ($7/month) or move to a host with volumes.

---

## 1. Deploy on Render (recommended)

### A. Put code on GitHub
1. Create a new repository.
2. Upload the entire `BizPilot` folder (or the zip).

### B. Create Web Service
1. Go to https://dashboard.render.com → **New +** → **Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Name**: `bizpilot` (or your choice)
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: leave blank (uses `Procfile`)
   - **Instance Type**: Free (or Starter for always-on)

### C. Environment Variables (required)

| Key                     | Example / How to get it                                      | Required |
|-------------------------|--------------------------------------------------------------|----------|
| `BIZPILOT_PROD`         | `1`                                                          | Yes      |
| `BIZPILOT_PROXY`        | `1`                                                          | Yes      |
| `BIZPILOT_SECRET`       | long random string (40+ chars)                               | Yes      |
| `BIZPILOT_MASTER_KEY`   | generate with command below                                  | Yes      |
| `BIZPILOT_ADMIN_PASSWORD` | strong password you choose (min 12 chars)                  | Strongly recommended |

**Generate the master key** (run once on your computer):

```bash
python -c "from security import encode_key; import secrets; print(encode_key(secrets.token_bytes(32)))"
```

**Important**:  
- Copy `BIZPILOT_MASTER_KEY` somewhere safe (password manager).  
- If you lose it, **all encrypted shop records become unreadable forever**.

### D. Optional but recommended for real use
- Add a **Persistent Disk** on Render:
  - Mount path: `/var/data`
  - Size: 1 GB is enough to start
  - Then set env var: `BIZPILOT_DATA=/var/data`

Without a disk, the SQLite database is wiped every time the free service restarts or sleeps.

### E. Deploy
Click **Create Web Service**.  
Your site will be at: `https://your-name.onrender.com`

- App:        `https://your-name.onrender.com/app`
- Admin:      `https://your-name.onrender.com/admin`
- Health:     `https://your-name.onrender.com/healthz`

---

## 2. First login after deploy

1. Open `/admin` and log in with the password you set in `BIZPILOT_ADMIN_PASSWORD`.
2. Open `/app` and create a free trial account (or use the admin panel to grant days).
3. On a phone: open the site → browser menu → “Add to Home Screen”. It works offline.

---

## 3. Licence keys (optional)

You can sell offline licence keys:

```bash
# On your own computer (never put the private key on the server)
python license_tool.py generate-keys --private license_private.pem --public license_public.pem
python license_tool.py issue --private license_private.pem --customer "Shop Name" --days 30
```

Put only `license_public.pem` in the project (or set `BIZPILOT_LICENSE_PUBLIC_KEY`).  
Customers enter the key under Settings → Subscription.

---

## 4. Production checklist

- [ ] `BIZPILOT_PROD=1` and `BIZPILOT_PROXY=1` set
- [ ] Strong `BIZPILOT_SECRET` and `BIZPILOT_MASTER_KEY` set and backed up
- [ ] `BIZPILOT_ADMIN_PASSWORD` set (or change it immediately after first boot)
- [ ] Persistent disk mounted **or** you accept that free-tier data can be lost on restart
- [ ] You have tested `/app` registration + offline use on a phone
- [ ] You have tested the admin panel

---

## 5. Common issues

| Problem                        | Fix |
|--------------------------------|-----|
| Site sleeps / slow first load  | Normal on free tier. Upgrade to paid or use a host that stays awake. |
| Data disappeared after restart | Free filesystem is ephemeral. Add a persistent disk or external DB. |
| “Could not decrypt” errors     | Wrong or missing `BIZPILOT_MASTER_KEY`. Restore the original key. |
| Admin password unknown         | Set `BIZPILOT_ADMIN_PASSWORD` before first deploy, or use `manage.py set-admin-password` if you have shell access. |

---

## 6. Security notes (already built-in)

- Passwords hashed with scrypt
- All business records encrypted with AES-256-GCM (per-shop keys)
- Master key never stored in the database
- Secure cookies when `BIZPILOT_PROD=1`
- CSP, HSTS, X-Frame-Options headers
- Rate limiting on login / register
- Offline-first design so the app keeps working even if the server is down

You are ready for real customers once the checklist above is green.
