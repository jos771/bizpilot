"""BizPilot server: accounts, encrypted record storage, device sync, subscriptions and the owner admin panel.

The app itself runs in the browser and keeps every record on the device first, so it works with no
internet. This server logs people in, keeps an encrypted backup, and syncs devices.
"""
import json
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import (Flask, abort, flash, g, jsonify, redirect, render_template, request,
                   send_from_directory, session, url_for)
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

import store
from licensing import LicenseError, apply_license, verify_token
from security import DecryptError

BASE_DIR = Path(__file__).resolve().parent
DAY = 86400
TRIAL_DAYS = int(os.environ.get("BIZPILOT_TRIAL_DAYS", "14"))
GRACE_DAYS = 3                       # the app keeps working offline this long after a subscription ends
TOKEN_MAX_AGE = 120 * DAY            # a login lasts 120 days on a device
PRODUCTION = os.environ.get("BIZPILOT_PROD") == "1"
COOKIE = "bp_auth"
BUSINESS_TYPES = {"barbershop", "printing", "general"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
MAX_FAILED_LOGINS = 5
LOCK_SECONDS = 600

DEFAULT_SETTINGS = {
    "company_name": "BizPilot",
    "support_contact": "",
    "price_text": "Start free for 14 days. After that, a simple monthly subscription keeps your records "
                  "backed up and your app working.",
    "pay_info": "To subscribe, contact BizPilot and pay by EcoCash, bank transfer or cash. "
                "You will receive a licence key to enter in Settings > Subscription.",
}


def load_session_secret():
    configured = os.environ.get("BIZPILOT_SECRET")
    if configured:
        return configured
    path = store.DATA_DIR / "session-secret"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        for _ in range(60):
            text = path.read_text(encoding="utf-8").strip()
            if text:
                return text
            time.sleep(0.05)
        raise RuntimeError(f"{path} is empty. Delete it and start again.")
    value = secrets.token_urlsafe(48)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(value)
    return value


app = Flask(__name__)
app.config.update(
    SECRET_KEY=load_session_secret(),
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=PRODUCTION,
    PERMANENT_SESSION_LIFETIME=8 * 3600,
)
if os.environ.get("BIZPILOT_PROXY") == "1":       # behind nginx or a hosting platform's proxy
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

tokens = URLSafeTimedSerializer(app.config["SECRET_KEY"], salt="bizpilot-auth")
DUMMY_HASH = generate_password_hash("not-a-real-password")


# ---------- database ----------
def db():
    if "db" not in g:
        g.db = store.connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def get_setting(key):
    row = db().execute("SELECT value FROM server_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else DEFAULT_SETTINGS.get(key, "")


def set_setting(key, value):
    db().execute("INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)", (key, value))


def bootstrap_admin_password():
    """Create the owner admin password on first run.

    Prefer setting BIZPILOT_ADMIN_PASSWORD in the environment (recommended for
    production hosts). If that is not set, a random password is generated and
    printed once to the logs — copy it immediately.
    """
    conn = store.connect()
    existing = conn.execute("SELECT 1 FROM server_settings WHERE key = 'admin_pw_hash'").fetchone()
    if existing:
        conn.close()
        return

    password = (os.environ.get("BIZPILOT_ADMIN_PASSWORD") or "").strip()
    from_env = bool(password)
    if not password:
        password = secrets.token_urlsafe(12)

    conn.execute(
        "INSERT INTO server_settings (key, value) VALUES ('admin_pw_hash', ?)",
        (generate_password_hash(password),),
    )
    conn.close()

    if from_env:
        print("\n  Owner admin panel ready at /admin (password taken from BIZPILOT_ADMIN_PASSWORD)\n", flush=True)
    else:
        print(f"\n  Owner admin panel:  /admin\n  Admin password:     {password}\n"
              "  (shown once. On a real server set BIZPILOT_ADMIN_PASSWORD instead,\n"
              "   or run: python manage.py set-admin-password)\n", flush=True)


# ---------- helpers ----------
_hits = {}


def too_many(bucket, limit=10, window=300):
    """A small in-memory limiter for login-type actions, per IP address."""
    now = time.time()
    key = (bucket, request.remote_addr)
    recent = [t for t in _hits.get(key, []) if now - t < window]
    blocked = len(recent) >= limit
    if not blocked:
        recent.append(now)
    _hits[key] = recent
    if len(_hits) > 5000:
        for k in [k for k, v in _hits.items() if not v or now - v[-1] > window]:
            _hits.pop(k, None)
    return blocked


def license_info(a, now=None):
    now = now or int(time.time())
    if a["suspended"]:
        status = "suspended"
    elif a["paid_until"] > now:
        status = "active"
    elif a["trial_ends"] > now:
        status = "trial"
    else:
        status = "expired"
    return {"status": status, "valid_until": max(a["trial_ends"], a["paid_until"]) * 1000,
            "trial_ends": a["trial_ends"] * 1000, "paid_until": a["paid_until"] * 1000}


def me_payload(a):
    return {"id": a["id"], "email": a["email"], "business_name": a["business_name"],
            "business_type": a["business_type"], "license": license_info(a),
            "server_time": int(time.time() * 1000), "grace_days": GRACE_DAYS,
            "pay_info": get_setting("pay_info"), "price_text": get_setting("price_text")}


def json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def with_login(resp, account_id):
    token = tokens.dumps({"a": account_id, "t": int(time.time())})
    resp.set_cookie(COOKIE, token, max_age=TOKEN_MAX_AGE, httponly=True, secure=PRODUCTION,
                    samesite="Lax", path="/")
    return resp


def current_account():
    token = request.cookies.get(COOKIE, "")
    if not token:
        return None
    try:
        data = tokens.loads(token, max_age=TOKEN_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    a = store.account_by_id(db(), data.get("a"))
    if not a or data.get("t", 0) < a["tokens_valid_after"]:
        return None
    return a


def api_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        a = current_account()
        if a is None:
            return jsonify(error="auth", message="Please log in again."), 401
        return fn(a, *args, **kwargs)
    return wrapper


def fail(status, error, message, **extra):
    return jsonify(error=error, message=message, **extra), status


@app.before_request
def api_guard():
    # Browsers will not add a custom header to a cross-site request, so requiring one blocks forged posts.
    if request.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("X-BizPilot") != "1":
            return fail(400, "csrf", "Request blocked. Reload the page and try again.")


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
        "connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; "
        "base-uri 'self'; form-action 'self'")
    if request.is_secure:
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.template_filter("dt")
def fmt_date(epoch):
    return datetime.fromtimestamp(epoch).strftime("%d %b %Y") if epoch else "-"


@app.template_filter("ago")
def fmt_ago(epoch):
    if not epoch:
        return "never"
    secs = int(time.time()) - epoch
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{secs // 60} min ago"
    if secs < 86400:
        return f"{secs // 3600} h ago"
    return f"{secs // 86400} d ago"


@app.errorhandler(404)
def not_found(_e):
    if request.path.startswith("/api/"):
        return fail(404, "not_found", "Not found.")
    return render_template("legal.html", page="notfound", company=get_setting("company_name"),
                           contact=get_setting("support_contact")), 404


@app.errorhandler(405)
def bad_method(_e):
    return fail(405, "method", "Not allowed.")


@app.errorhandler(413)
def too_big(_e):
    return fail(413, "too_big", "That upload is too large.")


@app.errorhandler(DecryptError)
def storage_error(_e):
    app.logger.error("Could not decrypt stored data. Is BIZPILOT_MASTER_KEY / instance/master.key the original one?")
    return fail(500, "storage", "Your saved records could not be read on the server. Please contact support.")


# ---------- pages ----------
@app.route("/")
def home():
    return redirect(url_for("app_shell"))


@app.route("/app")
def app_shell():
    resp = app.make_response(render_template("app.html", trial_days=TRIAL_DAYS))
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def legal_page(page):
    return render_template("legal.html", page=page, company=get_setting("company_name"),
                           contact=get_setting("support_contact"), trial_days=TRIAL_DAYS)


@app.route("/terms")
def terms():
    return legal_page("terms")


@app.route("/privacy")
def privacy():
    return legal_page("privacy")


@app.route("/manifest.webmanifest")
def manifest():
    data = {
        "name": "BizPilot", "short_name": "BizPilot",
        "description": "Record sales and expenses, even with no internet, and see how your business is doing.",
        "id": "/app", "start_url": "/app", "scope": "/", "display": "standalone",
        "background_color": "#f4f7f6", "theme_color": "#0f3d33",
        "icons": [
            {"src": "/static/img/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/static/img/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/static/img/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": [{"name": "Record sale", "url": "/app#/sale"}, {"name": "Record expense", "url": "/app#/expense"}],
    }
    return app.response_class(json.dumps(data), mimetype="application/manifest+json")


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory(app.static_folder, "js/sw.js", mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/healthz")
def healthz():
    """Simple liveness + database check used by hosting platforms."""
    db().execute("SELECT 1").fetchone()
    return {"status": "ok", "service": "bizpilot"}, 200


# ---------- API: accounts ----------
@app.route("/api/register", methods=["POST"])
def api_register():
    if too_many("register", 8, 3600):
        return fail(429, "rate", "Too many attempts. Please try again later.")
    body = json_body()
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    name = str(body.get("business_name", "")).strip()[:60]
    btype = body.get("business_type") if body.get("business_type") in BUSINESS_TYPES else "general"
    if not EMAIL_RE.match(email) or len(email) > 120:
        return fail(400, "email", "Enter a valid email address.")
    if len(password) < 8 or len(password) > 200:
        return fail(400, "password", "Use a password with at least 8 characters.")
    if password.lower() == email:
        return fail(400, "password", "Choose a password that is different from your email.")
    if not name:
        return fail(400, "name", "Enter your business name.")
    now = int(time.time())
    conn = db()
    conn.execute("BEGIN IMMEDIATE")
    try:
        cur = conn.execute(
            "INSERT INTO accounts (email, pw_hash, business_name, business_type, created_at, trial_ends) VALUES (?,?,?,?,?,?)",
            (email, generate_password_hash(password), name, btype, now, now + TRIAL_DAYS * DAY))
        aid = cur.lastrowid
        conn.execute("UPDATE accounts SET dek = ? WHERE id = ?", (store.vault.wrap(store.vault.new_dek(), aid), aid))
        store.log_event(conn, aid, "register", request.remote_addr)
        conn.execute("COMMIT")
    except sqlite3.IntegrityError:
        conn.execute("ROLLBACK")
        return fail(409, "exists", "An account with that email already exists. Log in instead.")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    resp = jsonify(me=me_payload(store.account_by_id(conn, aid)))
    resp.status_code = 201
    return with_login(resp, aid)


@app.route("/api/login", methods=["POST"])
def api_login():
    if too_many("login", 15, 300):
        return fail(429, "rate", "Too many attempts. Wait a few minutes and try again.")
    body = json_body()
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    conn, now = db(), int(time.time())
    a = store.account_by_email(conn, email)
    locked = bool(a and a["locked_until"] > now)
    right = check_password_hash(a["pw_hash"] if a else DUMMY_HASH, password)
    if not (a and right and not locked):
        if a and not locked:
            fails = a["failed_logins"] + 1
            if fails >= MAX_FAILED_LOGINS:
                conn.execute("UPDATE accounts SET failed_logins = 0, locked_until = ? WHERE id = ?", (now + LOCK_SECONDS, a["id"]))
                store.log_event(conn, a["id"], "locked", request.remote_addr)
            else:
                conn.execute("UPDATE accounts SET failed_logins = ? WHERE id = ?", (fails, a["id"]))
        store.log_event(conn, a["id"] if a else None, "login_failed", request.remote_addr)
        return fail(401, "credentials", "That email and password don't match. After several wrong tries, "
                                        "logins pause for 10 minutes.")
    conn.execute("UPDATE accounts SET failed_logins = 0, locked_until = 0 WHERE id = ?", (a["id"],))
    store.log_event(conn, a["id"], "login", request.remote_addr)
    return with_login(jsonify(me=me_payload(a)), a["id"])


@app.route("/api/logout", methods=["POST"])
def api_logout():
    resp = jsonify(ok=True)
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.route("/api/me")
@api_auth
def api_me(a):
    return jsonify(me=me_payload(a))


@app.route("/api/password", methods=["POST"])
@api_auth
def api_password(a):
    if too_many("password", 8, 600):
        return fail(429, "rate", "Too many attempts. Try again later.")
    body = json_body()
    if not check_password_hash(a["pw_hash"], str(body.get("old", ""))):
        return fail(400, "credentials", "Your current password is wrong.")
    new = str(body.get("new", ""))
    if len(new) < 8 or len(new) > 200:
        return fail(400, "password", "Use a password with at least 8 characters.")
    conn = db()
    conn.execute("UPDATE accounts SET pw_hash = ?, tokens_valid_after = ? WHERE id = ?",
                 (generate_password_hash(new), int(time.time()), a["id"]))
    store.log_event(conn, a["id"], "password_changed", request.remote_addr)
    return with_login(jsonify(ok=True), a["id"])


@app.route("/api/account/delete", methods=["POST"])
@api_auth
def api_delete_account(a):
    if too_many("delete", 5, 600):
        return fail(429, "rate", "Too many attempts. Try again later.")
    if not check_password_hash(a["pw_hash"], str(json_body().get("password", ""))):
        return fail(400, "credentials", "That password is wrong.")
    conn = db()
    conn.execute("DELETE FROM events WHERE account_id = ?", (a["id"],))
    conn.execute("UPDATE redeemed_keys SET account_id = NULL WHERE account_id = ?", (a["id"],))
    conn.execute("DELETE FROM accounts WHERE id = ?", (a["id"],))      # records are removed with it
    store.log_event(conn, None, "account_deleted", request.remote_addr)
    resp = jsonify(ok=True)
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.route("/api/license/redeem", methods=["POST"])
@api_auth
def api_redeem(a):
    if too_many("redeem", 10, 600):
        return fail(429, "rate", "Too many attempts. Try again in a few minutes.")
    if a["suspended"]:
        return fail(403, "suspended", "This account is suspended. Please contact support.")
    try:
        payload = verify_token(json_body().get("code", ""))
    except LicenseError as exc:
        return fail(400, "key", str(exc))
    now = int(time.time())
    conn = db()
    conn.execute("BEGIN IMMEDIATE")
    try:
        if conn.execute("SELECT 1 FROM redeemed_keys WHERE jti = ?", (payload["jti"],)).fetchone():
            conn.execute("ROLLBACK")
            return fail(400, "key", "That licence key has already been used.")
        fresh = store.account_by_id(conn, a["id"])
        new_paid = apply_license(fresh["paid_until"], payload, now)
        conn.execute("INSERT INTO redeemed_keys (jti, account_id, redeemed_at) VALUES (?,?,?)", (payload["jti"], a["id"], now))
        conn.execute("UPDATE accounts SET paid_until = ? WHERE id = ?", (new_paid, a["id"]))
        store.log_event(conn, a["id"], "key_redeemed", request.remote_addr)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return jsonify(me=me_payload(store.account_by_id(conn, a["id"])), days=payload.get("days"))


# ---------- API: sync ----------
@app.route("/api/push", methods=["POST"])
@api_auth
def api_push(a):
    if license_info(a)["status"] not in ("trial", "active"):
        return fail(402, "expired", "Your subscription has ended.", me=me_payload(a))
    incoming = json_body().get("records")
    if not isinstance(incoming, list) or len(incoming) > 500:
        return fail(400, "bad_request", "Send up to 500 records at a time.")
    accepted, rejected = store.put_records(db(), a, incoming, int(time.time() * 1000))
    return jsonify(accepted=accepted, rejected=rejected, me=me_payload(store.account_by_id(db(), a["id"])))


@app.route("/api/pull")
@api_auth
def api_pull(a):
    try:
        since = max(0, int(request.args.get("since", 0)))
        limit = min(1000, max(1, int(request.args.get("limit", 500))))
    except ValueError:
        return fail(400, "bad_request", "Bad request.")
    records, nxt, more = store.read_records(db(), a, since, limit)
    db().execute("UPDATE accounts SET last_sync = ? WHERE id = ?", (int(time.time()), a["id"]))
    return jsonify(records=records, next=nxt, more=more)


# ---------- owner admin panel ----------
def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("admin"):
            return redirect(url_for("admin_login"))
        if request.method == "POST":
            sent = request.form.get("csrf", "")
            if not sent or not secrets.compare_digest(sent, session.get("csrf", "")):
                abort(400)
        return fn(*args, **kwargs)
    return wrapper


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    error = None
    if request.method == "POST":
        row = db().execute("SELECT value FROM server_settings WHERE key = 'admin_pw_hash'").fetchone()
        if too_many("admin", 8, 600):
            error = "Too many attempts. Wait a few minutes."
        elif row and check_password_hash(row["value"], request.form.get("password", "")):
            session.clear()
            session.permanent = True
            session["admin"] = True
            session["csrf"] = secrets.token_hex(16)
            return redirect(url_for("admin"))
        else:
            error = "Wrong password."
    return render_template("admin_login.html", error=error)


@app.route("/admin/logout", methods=["POST"])
@admin_required
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))


@app.route("/admin")
@admin_required
def admin():
    now = int(time.time())
    rows = db().execute(
        "SELECT a.*, (SELECT COUNT(*) FROM records r WHERE r.account_id = a.id AND r.rt = 'tx' AND r.deleted = 0) AS tx_count "
        "FROM accounts a ORDER BY a.created_at DESC").fetchall()
    customers, stats = [], {"total": len(rows), "active": 0, "trial": 0, "expired": 0, "suspended": 0}
    for r in rows:
        info = license_info(r, now)
        stats[info["status"]] += 1
        customers.append({"a": r, "info": info})
    events = db().execute(
        "SELECT e.*, a.email FROM events e LEFT JOIN accounts a ON a.id = e.account_id ORDER BY e.id DESC LIMIT 25").fetchall()
    return render_template("admin.html", customers=customers, stats=stats, events=events,
                           settings={k: get_setting(k) for k in DEFAULT_SETTINGS})


def admin_account(aid):
    return store.account_by_id(db(), aid) or abort(404)


@app.route("/admin/customer/<int:aid>/grant", methods=["POST"])
@admin_required
def admin_grant(aid):
    a = admin_account(aid)
    try:
        days = int(request.form.get("days", "30"))
    except ValueError:
        days = 0
    if not 1 <= days <= 3660:
        flash("Enter a number of days between 1 and 3660.", "error")
        return redirect(url_for("admin"))
    db().execute("UPDATE accounts SET paid_until = ? WHERE id = ?", (max(int(time.time()), a["paid_until"]) + days * DAY, aid))
    store.log_event(db(), aid, "admin_grant", request.remote_addr)
    flash(f"Added {days} days to {a['email']}.", "ok")
    return redirect(url_for("admin"))


@app.route("/admin/customer/<int:aid>/suspend", methods=["POST"])
@admin_required
def admin_suspend(aid):
    a = admin_account(aid)
    state = 0 if a["suspended"] else 1
    db().execute("UPDATE accounts SET suspended = ? WHERE id = ?", (state, aid))
    flash(f"{a['email']} is now {'suspended' if state else 'active again'}.", "ok")
    return redirect(url_for("admin"))


@app.route("/admin/customer/<int:aid>/reset", methods=["POST"])
@admin_required
def admin_reset(aid):
    a = admin_account(aid)
    temp = secrets.token_urlsafe(9)
    db().execute("UPDATE accounts SET pw_hash = ?, tokens_valid_after = ?, failed_logins = 0, locked_until = 0 WHERE id = ?",
                 (generate_password_hash(temp), int(time.time()), aid))
    store.log_event(db(), aid, "admin_reset", request.remote_addr)
    flash(f"New temporary password for {a['email']}: {temp}\nSend it to them. They can change it in Settings.", "keys")
    return redirect(url_for("admin"))


@app.route("/admin/settings", methods=["POST"])
@admin_required
def admin_settings():
    for key in DEFAULT_SETTINGS:
        value = request.form.get(key, "").strip()[:1200]
        if value or key == "support_contact":
            set_setting(key, value)
    flash("Saved.", "ok")
    return redirect(url_for("admin"))


store.init_db()
bootstrap_admin_password()

# Clear startup info (shows in Render / Railway logs)
print(f"BizPilot starting  |  production={PRODUCTION}  data={store.DATA_DIR}", flush=True)
if not os.environ.get("BIZPILOT_MASTER_KEY") and not (store.DATA_DIR / "master.key").exists():
    print("  WARNING: no master key yet — one will be created on first use. "
          "On a real server set BIZPILOT_MASTER_KEY.", flush=True)

if __name__ == "__main__":
    lan = os.environ.get("BIZPILOT_LAN") == "1"        # let phones on the same Wi-Fi open it
    app.run(host="0.0.0.0" if lan else "127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
