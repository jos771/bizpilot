/* BizPilot core: local database, sync and licence checks.
   Everything is saved on the device first (IndexedDB), so the app keeps working with no internet.
   The server is only used to log in, check the subscription, and back up and sync the records. */
(function () {
  "use strict";
  var BP = (window.BP = {});
  var S = (BP.S = { session: null, me: null, db: null, rec: new Map(), meta: {}, locked: false, sync: { state: "idle", last: 0 } });

  // ---------- tiny event bus ----------
  var handlers = {};
  BP.on = function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); };
  function emit(name) { (handlers[name] || []).forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }
  BP.emit = emit;

  // ---------- helpers ----------
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  BP.esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); };
  BP.uid = function () {
    var a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  };
  function pad(n) { return String(n).padStart(2, "0"); }
  BP.isoDate = function (d) { d = d || new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  BP.parseISO = function (s) { var p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2], 12); };
  BP.addDays = function (iso, n) { var d = BP.parseISO(iso); d.setDate(d.getDate() + n); return BP.isoDate(d); };
  BP.daysBetween = function (a, b) { return Math.round((BP.parseISO(b) - BP.parseISO(a)) / 864e5); };

  BP.currency = function () { var s = BP.settings(); return (s && s.currency) || "$"; };
  BP.money = function (cents) {
    var sym = BP.currency();
    var sep = /^[A-Za-z]{2,}$/.test(sym) ? " " : "";
    var n = (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (cents < 0 ? "-" : "") + sym + sep + n;
  };
  BP.plainAmount = function (cents) { return (cents / 100).toFixed(2); };
  BP.parseMoney = function (text) {
    var t = String(text == null ? "" : text).replace(/[,\s]/g, "");
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    var cents = Math.round(parseFloat(t) * 100);
    return cents > 0 && cents <= 1e11 ? cents : null;
  };

  // ---------- what each type of business starts with (prices are examples, in cents) ----------
  BP.PRESETS = {
    barbershop: {
      label: "Barbershop or salon",
      blurb: "Haircuts, shaves, braids, colour and styling.",
      sales: [["Haircut", 500], ["Kids cut", 300], ["Shave", 300], ["Beard trim", 300], ["Braids", 2500], ["Wash & style", 800], ["Colour", 1500]],
      expenses: ["Supplies", "Rent", "Electricity", "Water", "Wages", "Transport", "Airtime/Data"]
    },
    printing: {
      label: "Print and copy shop",
      blurb: "Printing, copying, lamination, binding, banners and design.",
      sales: [["A4 black & white print", 10], ["A4 colour print", 50], ["Photocopy", 5], ["Scanning", 50], ["Lamination (A4)", 100],
        ["Spiral binding", 200], ["Passport photos", 300], ["Business cards (100)", 1500], ["Banner printing", 1500], ["T-shirt printing", 800], ["Design work", 500]],
      expenses: ["Paper", "Ink / toner", "Machine repair & service", "Rent", "Electricity", "Wages", "Transport", "Airtime/Data"]
    },
    general: {
      label: "Any other shop",
      blurb: "A blank start. Add your own products and services.",
      sales: [["Product sale", null], ["Service fee", null]],
      expenses: ["Stock purchase", "Rent", "Electricity", "Wages", "Transport", "Airtime/Data"]
    }
  };
  BP.METHODS = ["Cash", "Mobile money", "Card", "Bank transfer"];
  BP.OTHER = "__other__";

  // ---------- IndexedDB ----------
  function idbOpen(name) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(name, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore("records", { keyPath: "id" });
        req.result.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error("blocked")); };
    });
  }
  function idbAll(db, store) {
    return new Promise(function (resolve, reject) {
      var q = db.transaction(store).objectStore(store).getAll();
      q.onsuccess = function () { resolve(q.result); };
      q.onerror = function () { reject(q.error); };
    });
  }
  function idbPut(db, store, items) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(store, "readwrite");
      var os = tx.objectStore(store);
      items.forEach(function (i) { os.put(i); });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = tx.onabort = function () { reject(tx.error); };
    });
  }
  BP.openAccount = async function (accountId) {
    if (S.db) { S.db.close(); S.db = null; }
    S.db = await idbOpen("bizpilot-" + accountId);
    var recs = await idbAll(S.db, "records");
    S.rec = new Map(recs.map(function (r) { return [r.id, r]; }));
    var metas = await idbAll(S.db, "meta");
    S.meta = {};
    metas.forEach(function (m) { S.meta[m.key] = m.value; });
    S.me = S.meta.me || null;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort */ }
  };
  async function setMeta(key, value) {
    S.meta[key] = value;
    await idbPut(S.db, "meta", [{ key: key, value: value }]);
  }
  BP.deleteLocalData = function (accountId) {
    return new Promise(function (resolve) {
      if (S.db) { S.db.close(); S.db = null; }
      var req = indexedDB.deleteDatabase("bizpilot-" + accountId);
      req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
    });
  };

  // ---------- records ----------
  BP.put = async function (rec) {
    var prev = S.rec.get(rec.id);
    var now = Date.now();
    rec.updated_at = prev && prev.updated_at >= now ? prev.updated_at + 1 : now;
    rec.dirty = 1;
    rec.deleted = !!rec.deleted;
    S.rec.set(rec.id, rec);
    await idbPut(S.db, "records", [rec]);
    emit("status");
    BP.scheduleSync();
    return rec;
  };
  BP.list = function (rt) {
    var out = [];
    S.rec.forEach(function (r) { if (r.rt === rt && !r.deleted) out.push(r); });
    return out;
  };
  BP.txs = function () { return BP.list("tx"); };
  BP.items = function (kind) {
    return BP.list("item").filter(function (i) { return i.kind === kind; }).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  };
  BP.settings = function () { var s = S.rec.get("setting:business"); return s && !s.deleted ? s : null; };
  BP.saveSettings = function (patch) {
    var cur = BP.settings() || { id: "setting:business", rt: "setting", name: "My business", btype: "general", currency: "$" };
    return BP.put(Object.assign({}, cur, patch));
  };
  BP.addTx = function (t) {
    return BP.put({ id: BP.uid(), rt: "tx", type: t.type, label: t.label, qty: t.qty, amount_cents: t.amount_cents,
      method: t.method, note: t.note, date: t.date, created: Date.now() });
  };
  BP.removeRecord = function (id) {
    var cur = S.rec.get(id);
    return cur ? BP.put(Object.assign({}, cur, { deleted: true })) : Promise.resolve();
  };
  BP.restoreRecord = function (id) {
    var cur = S.rec.get(id);
    return cur ? BP.put(Object.assign({}, cur, { deleted: false })) : Promise.resolve();
  };
  BP.addItem = function (kind, name, priceCents) {
    var existing = BP.items(kind);
    var dup = existing.some(function (i) { return i.name.toLowerCase() === name.toLowerCase(); });
    if (dup) return Promise.resolve(false);
    var order = existing.reduce(function (m, i) { return Math.max(m, i.order || 0); }, 0) + 1;
    return BP.put({ id: BP.uid(), rt: "item", kind: kind, name: name, price_cents: priceCents, order: order }).then(function () { return true; });
  };
  BP.setItemPrice = function (id, priceCents) {
    return BP.put(Object.assign({}, S.rec.get(id), { price_cents: priceCents }));
  };
  BP.seedPreset = async function (type) {
    var p = BP.PRESETS[type];
    if (!p) return 0;
    var added = 0;
    for (var i = 0; i < p.sales.length; i++) if (await BP.addItem("sale", p.sales[i][0], p.sales[i][1])) added++;
    for (var j = 0; j < p.expenses.length; j++) if (await BP.addItem("expense", p.expenses[j], null)) added++;
    return added;
  };
  BP.pendingCount = function () {
    var n = 0;
    S.rec.forEach(function (r) { if (r.dirty) n++; });
    return n;
  };

  // ---------- reports ----------
  BP.aggregate = function (start, end) {
    var a = { sales: 0, expenses: 0, saleCount: 0, items: {}, costs: {}, methods: {}, daily: {} };
    BP.txs().forEach(function (t) {
      if (t.date < start || t.date > end) return;
      var d = a.daily[t.date] || (a.daily[t.date] = { s: 0, e: 0 });
      if (t.type === "sale") {
        a.sales += t.amount_cents; a.saleCount++; d.s += t.amount_cents;
        var it = a.items[t.label] || (a.items[t.label] = { qty: 0, total: 0 });
        it.qty += t.qty || 1; it.total += t.amount_cents;
        var m = t.method || "Other";
        a.methods[m] = a.methods[m] || { qty: 0, total: 0 };
        a.methods[m].total += t.amount_cents;
      } else {
        a.expenses += t.amount_cents; d.e += t.amount_cents;
        var c = a.costs[t.label] || (a.costs[t.label] = { qty: 0, total: 0 });
        c.total += t.amount_cents; c.qty++;
      }
    });
    a.net = a.sales - a.expenses;
    return a;
  };

  // ---------- CSV export (your records are never held hostage) ----------
  BP.csv = function (rows) {
    function cell(v) {
      v = String(v == null ? "" : v);
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return '"' + v.replace(/"/g, '""') + '"';
    }
    var lines = [["Date", "Type", "Item", "Quantity", "Amount", "Payment method", "Note"].map(cell).join(",")];
    rows.forEach(function (t) {
      lines.push([t.date, t.type, t.label, t.qty || 1, BP.plainAmount(t.amount_cents), t.method || "", t.note || ""].map(cell).join(","));
    });
    return "﻿" + lines.join("\r\n");
  };
  BP.download = function (filename, text) {
    var url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  };

  // ---------- session + API ----------
  // The login itself is an HttpOnly cookie that scripts cannot read. This only remembers WHO is logged in,
  // so the app can open their local records even with no internet.
  BP.loadSession = function () { try { return JSON.parse(localStorage.getItem("bp_session")); } catch (e) { return null; } };
  function saveSession(s) { S.session = s; try { localStorage.setItem("bp_session", JSON.stringify(s)); } catch (e) { /* ignore */ } }
  BP.clearSession = function () { S.session = null; try { localStorage.removeItem("bp_session"); } catch (e) { /* ignore */ } };

  BP.api = async function (path, opts) {
    opts = opts || {};
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 20000);
    var res;
    try {
      res = await fetch(path, { method: opts.method || "GET", cache: "no-store", signal: ctl.signal, credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-BizPilot": "1" },
        body: opts.body ? JSON.stringify(opts.body) : undefined });
    } catch (e) {
      var off = new Error("You're offline. Connect to the internet and try again.");
      off.offline = true;
      throw off;
    } finally { clearTimeout(timer); }
    var data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) {
      var err = new Error((data && data.message) || "Something went wrong. Please try again.");
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };

  // ---------- licence ----------
  BP.applyMe = async function (me) {
    S.me = me;
    await setMeta("me", { id: me.id, email: me.email, business_name: me.business_name, business_type: me.business_type });
    await setMeta("license", Object.assign({}, me.license, { grace_days: me.grace_days, pay_info: me.pay_info, price_text: me.price_text }));
    await setMeta("last_seen", me.server_time);
    BP.checkLock();
  };
  BP.licState = function () {
    var L = S.meta.license;
    if (!L) return { ok: false, status: "none", daysLeft: 0 };
    var now = Date.now(), seen = S.meta.last_seen || 0;
    if (L.status === "suspended") return { ok: false, status: "suspended", daysLeft: 0 };
    if (now < seen - 36 * 36e5) return { ok: false, status: "clock", daysLeft: 0 };      // device clock was wound back
    var grace = (L.grace_days == null ? 3 : L.grace_days) * 864e5;
    var daysLeft = Math.ceil((L.valid_until - now) / 864e5);
    if (now > L.valid_until + grace) return { ok: false, status: L.paid_until > 0 ? "expired" : "trial-ended", daysLeft: daysLeft };
    if (now > L.valid_until) return { ok: true, status: "grace", daysLeft: daysLeft };
    return { ok: true, status: L.paid_until > now ? "active" : "trial", daysLeft: daysLeft };
  };
  BP.checkLock = function () {
    var locked = !BP.licState().ok;
    if (locked !== S.locked) { S.locked = locked; emit("lock"); }
    emit("status");
  };
  BP.touchSeen = function () {
    var now = Date.now();
    if (S.db && (S.meta.last_seen || 0) < now && BP.licState().status !== "clock") setMeta("last_seen", now);
  };
  BP.redeem = async function (code) {
    var res = await BP.api("/api/license/redeem", { method: "POST", body: { code: code } });
    await BP.applyMe(res.me);
    BP.scheduleSync(300);
    return res;
  };
  BP.refreshMe = async function () {
    var res = await BP.api("/api/me");
    await BP.applyMe(res.me);
    return res.me;
  };

  // ---------- accounts ----------
  BP.register = async function (body) {
    var res = await BP.api("/api/register", { method: "POST", body: body });
    saveSession({ accountId: res.me.id, email: res.me.email });
    await BP.openAccount(res.me.id);
    await BP.applyMe(res.me);
    await BP.put({ id: "setting:business", rt: "setting", name: body.business_name, btype: body.business_type, currency: body.currency || "$" });
    await BP.seedPreset(body.business_type);
    return res.me;
  };
  BP.login = async function (email, password) {
    var res = await BP.api("/api/login", { method: "POST", body: { email: email, password: password } });
    saveSession({ accountId: res.me.id, email: res.me.email });
    await BP.openAccount(res.me.id);
    await BP.applyMe(res.me);
    return res.me;
  };
  BP.relogin = async function (password) {
    var res = await BP.api("/api/login", { method: "POST", body: { email: S.session.email, password: password } });
    if (res.me.id !== S.session.accountId) throw new Error("That is a different account.");
    S.sync.state = "idle";
    await BP.applyMe(res.me);
    BP.scheduleSync(200);
  };
  BP.changePassword = function (oldPw, newPw) {
    return BP.api("/api/password", { method: "POST", body: { old: oldPw, new: newPw } });
  };
  async function wipe() {
    var id = S.session && S.session.accountId;
    BP.clearSession();
    if (id != null) await BP.deleteLocalData(id);
    S.rec = new Map(); S.meta = {}; S.me = null; S.locked = false; S.sync = { state: "idle", last: 0 };
  }
  BP.logout = async function () {
    try { await BP.api("/api/logout", { method: "POST" }); } catch (e) { /* offline: the cookie stays until it expires */ }
    await wipe();
  };
  BP.deleteAccount = async function (password) {
    await BP.api("/api/account/delete", { method: "POST", body: { password: password } });
    await wipe();
  };

  // ---------- sync ----------
  var syncing = false, timer = null;
  function setSync(state) {
    S.sync.state = state;
    if (state === "ok") S.sync.last = Date.now();
    emit("status");
  }
  BP.scheduleSync = function (delay) {
    clearTimeout(timer);
    timer = setTimeout(BP.syncNow, delay == null ? 1200 : delay);
  };
  async function pullAll() {
    var changed = 0, since = S.meta.last_seq || 0, more = true;
    while (more) {
      var res = await BP.api("/api/pull?since=" + since + "&limit=500");
      var upd = [];
      res.records.forEach(function (r) {
        var local = S.rec.get(r.id);
        if (local && local.updated_at >= r.updated_at) return;
        r.dirty = 0;
        S.rec.set(r.id, r);
        upd.push(r);
      });
      if (upd.length) await idbPut(S.db, "records", upd);
      changed += upd.length;
      since = res.next; more = res.more;
      await setMeta("last_seq", since);
    }
    return changed;
  }
  BP.pullAll = pullAll;
  BP.syncNow = async function () {
    if (syncing || !S.session || !S.db) return;
    if (!navigator.onLine) { setSync("offline"); return; }
    syncing = true;
    setSync("syncing");
    var ok = false;
    try {
      var dirty = [];
      S.rec.forEach(function (r) { if (r.dirty) dirty.push(r); });
      while (dirty.length) {
        var batch = dirty.splice(0, 200);
        var payload = batch.map(function (r) { var w = Object.assign({}, r); delete w.dirty; return w; });
        var res = await BP.api("/api/push", { method: "POST", body: { records: payload } });
        var done = new Set(res.accepted.concat((res.rejected || []).filter(Boolean)));
        var cleaned = [];
        batch.forEach(function (r) {
          var cur = S.rec.get(r.id);
          if (done.has(r.id) && cur && cur.updated_at === r.updated_at) { cur.dirty = 0; cleaned.push(cur); }
        });
        if (cleaned.length) await idbPut(S.db, "records", cleaned);
        await BP.applyMe(res.me);
        emit("status");
      }
      var changed = await pullAll();
      ok = true;
      setSync("ok");
      if (changed) emit("data");
    } catch (e) {
      if (e.offline) setSync("offline");
      else if (e.status === 401) setSync("auth");
      else if (e.status === 402) {
        if (e.data && e.data.me) await BP.applyMe(e.data.me);
        setSync("blocked");
      } else { console.error(e); setSync("error"); }
    } finally {
      syncing = false;
      if (ok && BP.pendingCount() > 0) BP.scheduleSync(800);
    }
  };

  window.addEventListener("online", function () { emit("status"); BP.scheduleSync(400); });
  window.addEventListener("offline", function () { emit("status"); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { BP.touchSeen(); BP.checkLock(); BP.scheduleSync(500); } });
  setInterval(function () { if (!document.hidden && S.session) { BP.touchSeen(); BP.checkLock(); BP.syncNow(); } }, 60000);
})();
