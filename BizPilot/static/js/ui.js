/* BizPilot screens. Everything the person sees is built here from the local records in core.js. */
(function () {
  "use strict";
  var BP = window.BP, S = BP.S, esc = BP.esc, money = BP.money;
  var root = document.getElementById("root");
  var TRIAL = document.body.dataset.trial || "14";

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  var LOGO = '<svg class="logo-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#f5b335"/><rect x="14" y="36" width="9" height="14" rx="1.5" fill="#0f3d33"/><rect x="27.5" y="26" width="9" height="24" rx="1.5" fill="#0f3d33"/><rect x="41" y="14" width="9" height="36" rx="1.5" fill="#0f3d33"/></svg>';
  function icon(paths) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>"; }
  var NAV = [
    { id: "today", label: "Today", ico: icon('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>') },
    { id: "sale", label: "Sale", ico: icon('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>') },
    { id: "expense", label: "Expense", ico: icon('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>') },
    { id: "history", label: "History", ico: icon('<path d="M5 6h14M5 12h14M5 18h9"/>') },
    { id: "reports", label: "Reports", ico: icon('<path d="M5 20V10M12 20V4M19 20v-7"/>') },
    { id: "settings", label: "Settings", ico: icon('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>') }
  ];
  var TITLES = { today: "Today", sale: "Record a sale", expense: "Record an expense", history: "History", reports: "Reports", settings: "Settings", subscribe: "Subscription" };
  var BANNER = { barbershop: "barber", printing: "print", general: "general" };

  S.ui = { hist: { type: "all", from: "", to: "", q: "", limit: 100 }, period: "7" };

  // ---------- small pieces ----------
  function fmtTime(ms) { return ms ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""; }
  function longDate(iso) { return BP.parseISO(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }); }
  function shortDate(iso) { return BP.parseISO(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
  function fullDate(ms) { return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function biz() { return (BP.settings() && BP.settings().name) || "My business"; }
  function qtyText(t) { return t.qty > 1 ? ' <span class="x">×' + t.qty + "</span>" : ""; }

  var toastTimer, toastAction = null;
  function toast(msg, action, label) {
    var t = document.getElementById("toast");
    toastAction = action || null;
    t.innerHTML = "<span>" + esc(msg) + "</span>" + (action ? '<button type="button" data-action="toast-act">' + esc(label || "Undo") + "</button>" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, action ? 7000 : 3200);
  }
  function setBusy(form, busy, text) {
    var b = $('button[type="submit"]', form);
    if (!b) return;
    if (busy) { b.dataset.label = b.textContent; b.textContent = text || "Please wait…"; b.disabled = true; form.dataset.busy = "1"; }
    else { if (b.dataset.label) b.textContent = b.dataset.label; b.disabled = false; delete form.dataset.busy; }
  }
  function showError(id, msg) { var el = document.getElementById(id); if (!el) return; el.textContent = msg; el.hidden = !msg; }

  // ---------- sign in / sign up ----------
  function vAuth(mode) {
    var reg = mode === "register", relog = mode === "relogin";
    var typeCards = Object.keys(BP.PRESETS).map(function (k, i) {
      var p = BP.PRESETS[k];
      return '<label class="choice"><input type="radio" name="btype" value="' + k + '"' + (i === 0 ? " checked" : "") + '><span class="choice-body"><strong>' + esc(p.label) + "</strong><small>" + esc(p.blurb) + "</small></span></label>";
    }).join("");
    var heading = reg ? "Start your free trial" : relog ? "Log in again" : "Welcome back";
    var sub = reg ? "Set up your shop in a minute. No card needed."
      : relog ? "Your session ended. Your records are safe on this device. Log in to back them up again."
        : "Log in to open your shop's records.";
    return '<div class="auth"><section class="auth-art"><a class="logo" href="/app">' + LOGO + "BizPilot</a>" +
      '<div class="auth-pitch"><h1>' + (reg ? "Know what the shop made today." : "Good to see you again.") + "</h1>" +
      "<p>Record sales and expenses in a few taps, even with no internet.</p>" +
      '<ul class="ticks light"><li>Works offline, backs up when online</li><li>Your records are encrypted on our server</li><li>' + TRIAL + "-day free trial, no card</li></ul></div></section>" +
      '<section class="auth-form"><div class="auth-card"><h2>' + heading + '</h2><p class="muted">' + sub + "</p>" +
      (navigator.onLine ? "" : '<p class="notice">You are offline. You need the internet to ' + (reg ? "sign up" : "log in") + " the first time.</p>") +
      '<form data-form="' + mode + '" class="stack" novalidate>' +
      (reg ? '<label class="field">Business name<input name="business_name" maxlength="60" autocomplete="organization" required></label>' : "") +
      '<label class="field">Email<input name="email" type="email" inputmode="email" autocomplete="email" maxlength="120" required' + (relog ? ' value="' + esc(S.session.email) + '" readonly' : "") + "></label>" +
      '<label class="field">Password<input name="password" type="password" autocomplete="' + (reg ? "new-password" : "current-password") + '" required' + (reg ? ' minlength="8"' : "") + ">" + (reg ? "<small>At least 8 characters</small>" : "") + "</label>" +
      (reg ? '<fieldset class="choices"><legend>What kind of business is it?</legend>' + typeCards + "</fieldset>" +
        '<label class="field narrow">Currency symbol<input name="currency" value="$" maxlength="6" size="6"><small>For example $, R, £ or ZWG</small></label>' +
        '<label class="check"><input type="checkbox" name="terms" required><span>I agree to the <a href="/terms" target="_blank" rel="noopener">terms</a> and <a href="/privacy" target="_blank" rel="noopener">privacy policy</a>.</span></label>' : "") +
      '<p class="form-error" id="auth-error" role="alert" hidden></p>' +
      '<button class="btn btn-green btn-lg" type="submit">' + (reg ? "Start free trial" : relog ? "Log in again" : "Log in") + "</button></form>" +
      (relog ? "" : '<p class="switch">' + (reg ? 'Already have an account? <a href="#/login">Log in</a>' : 'New here? <a href="#/register">Start a free trial</a>') + "</p>") +
      "</div></section></div>";
  }

  // ---------- chrome ----------
  function navLinks() { return NAV.map(function (n) { return '<a href="#/' + n.id + '" data-nav="' + n.id + '">' + n.ico + "<span>" + n.label + "</span></a>"; }).join(""); }
  function renderShell() {
    root.innerHTML = '<div class="shell"><aside class="rail"><a class="rail-brand" href="#/today">' + LOGO + "<span>BizPilot</span></a>" +
      '<nav class="rail-nav" aria-label="Main">' + navLinks() + '</nav><div class="rail-foot"><button class="btn btn-gold btn-sm" data-action="install" type="button" hidden>Install app</button></div></aside>' +
      '<div class="main"><header class="topbar"><div class="tb-biz" id="tb-biz"></div><div class="tb-right">' +
      '<a id="chip-lic" class="chip" href="#/subscribe" hidden></a><button id="chip-sync" class="chip" type="button" data-action="sync-now"></button></div></header>' +
      '<main id="view" tabindex="-1"></main></div><nav class="tabbar" aria-label="Main">' + navLinks() + "</nav></div>";
    if (S.installEvt) $$("[data-action=install]").forEach(function (b) { b.hidden = false; });
  }
  function updateStatus() {
    var sync = document.getElementById("chip-sync");
    if (!sync) return;
    var pending = BP.pendingCount(), st = S.sync.state, cls = "ok", text;
    if (!navigator.onLine || st === "offline") { cls = "warn"; text = "Offline" + (pending ? " · " + pending + " waiting" : " · saved on this device"); }
    else if (st === "syncing") { cls = "busy"; text = "Syncing…"; }
    else if (st === "auth") { cls = "warn"; text = "Log in to back up"; }
    else if (st === "blocked") { cls = "warn"; text = "Backup paused"; }
    else if (st === "error") { cls = "warn"; text = "Backup failed · tap to retry"; }
    else if (pending) { cls = "busy"; text = pending + " waiting to back up"; }
    else { text = S.sync.last ? "Backed up" : "Saved on this device"; }
    sync.className = "chip " + cls;
    sync.textContent = text;
    var name = document.getElementById("tb-biz");
    if (name) name.textContent = biz();
    var lic = document.getElementById("chip-lic"), L = BP.licState(), t = "";
    if (L.status === "trial") t = "Trial: " + plural(Math.max(L.daysLeft, 0), "day") + " left";
    else if (L.status === "active" && L.daysLeft <= 7) t = "Renew in " + plural(Math.max(L.daysLeft, 0), "day");
    else if (L.status === "grace") t = "Subscription ended";
    lic.hidden = !t;
    lic.className = "chip " + (L.status === "grace" ? "warn" : "gold");
    lic.textContent = t;
  }

  // ---------- today ----------
  function lines(map, max, o) {
    o = o || {};
    var rows = Object.keys(map).map(function (k) { return { k: k, v: map[k] }; }).sort(function (a, b) { return b.v.total - a.v.total; });
    var html = rows.slice(0, max).map(function (r) {
      var q = o.qty && r.v.qty > 1 ? " ×" + r.v.qty : "";
      return '<div class="rline"><span>' + esc(r.k) + q + '</span><span class="dots"></span><span class="amt ' + (o.cls || "") + '">' + (o.sign || "") + esc(money(r.v.total)) + "</span></div>";
    }).join("");
    if (rows.length > max) html += '<div class="rline small"><span>+ ' + (rows.length - max) + " more</span></div>";
    return html;
  }
  function vToday() {
    var today = BP.isoDate(), a = BP.aggregate(today, today), yd = BP.addDays(today, -1), y = BP.aggregate(yd, yd);
    var rows = BP.txs().filter(function (t) { return t.date === today; }).sort(function (p, q) { return (q.created || 0) - (p.created || 0); }).slice(0, 12);
    var methods = Object.keys(a.methods).map(function (m) { return esc(m) + " " + esc(money(a.methods[m].total)); }).join(" · ");
    var s = BP.settings() || {};
    var receipt = '<div class="receipt-wrap"><div class="receipt"><h3>' + esc(biz()) + '</h3><div class="rsub">' + esc(longDate(today)) + "</div>" +
      (a.saleCount ? lines(a.items, 6, { qty: true }) : '<div class="rline small"><span>No sales yet</span></div>') +
      (methods ? '<div class="rline small"><span>' + methods + "</span></div>" : "") +
      '<div class="rgap"></div><div class="rline"><span>Sales (' + a.saleCount + ')</span><span class="dots"></span><span class="amt pos">' + esc(money(a.sales)) + "</span></div>" +
      lines(a.costs, 4, { sign: "-", cls: "neg" }) +
      '<div class="rline net"><span>Net today</span><span class="dots"></span><span class="amt ' + (a.net >= 0 ? "pos" : "neg") + '">' + esc(money(a.net)) + "</span></div></div></div>" +
      '<p class="yesterday">Yesterday: ' + esc(money(y.net)) + " net from " + plural(y.saleCount, "sale") + "</p>";
    var ledger = rows.length ? '<ul class="ledger">' + rows.map(function (t) {
      return '<li><span class="l-time">' + fmtTime(t.created) + '</span><span class="l-main"><span class="l-what">' + esc(t.label) + qtyText(t) + "</span>" +
        (t.note ? "<small>" + esc(t.note) + "</small>" : "") + '</span><span class="l-method">' + esc(t.method || "") + '</span><span class="l-amt ' + (t.type === "sale" ? "pos" : "neg") + '">' +
        (t.type === "sale" ? "+" : "-") + esc(money(t.amount_cents)) + "</span></li>";
    }).join("") + "</ul>" : '<div class="empty"><p><strong>Nothing recorded yet today.</strong><br>Your first sale takes a few seconds.</p><a class="btn btn-green" href="#/sale">Record a sale</a></div>';
    return '<section class="banner ' + (BANNER[s.btype] || "general") + '"><div><h1>' + esc(biz()) + "</h1><p>" + esc(longDate(today)) + "</p></div>" +
      '<div class="banner-actions"><a class="btn btn-gold" href="#/sale">Record sale</a><a class="btn btn-ghost" href="#/expense">Record expense</a></div></section>' +
      '<div class="today-grid"><div class="today-receipt">' + receipt + '</div><section class="today-ledger"><h2>Today\'s entries</h2>' + ledger +
      (rows.length ? '<p class="more"><a href="#/history">See all history</a></p>' : "") + "</section></div>";
  }

  // ---------- record a sale / expense ----------
  function stripText(kind) {
    var t = BP.isoDate(), a = BP.aggregate(t, t);
    return kind === "sale" ? "Today so far: <b>" + esc(money(a.sales)) + "</b> from " + plural(a.saleCount, "sale") : "Spent today: <b>" + esc(money(a.expenses)) + "</b>";
  }
  function vEntry(kind) {
    var sale = kind === "sale", items = BP.items(kind), today = BP.isoDate();
    var tiles = items.map(function (i, n) {
      return '<label class="tile"><input type="radio" name="item" value="' + esc(i.name) + '" data-price="' + (i.price_cents == null ? "" : i.price_cents) + '"' + (n === 0 ? " checked" : "") + '><span class="tile-body"><span class="t-name">' + esc(i.name) + "</span>" +
        (sale && i.price_cents ? '<span class="t-price">' + esc(money(i.price_cents)) + "</span>" : "") + "</span></label>";
    }).join("") + '<label class="tile"><input type="radio" name="item" value="' + BP.OTHER + '" data-price=""' + (items.length ? "" : " checked") + '><span class="tile-body"><span class="t-name">Other</span><span class="t-price">type your own</span></span></label>';
    var methods = BP.METHODS.map(function (m, n) { return '<label class="seg-opt"><input type="radio" name="method" value="' + esc(m) + '"' + (n === 0 ? " checked" : "") + "><span>" + esc(m) + "</span></label>"; }).join("");
    return '<section class="page"><div class="page-head"><h1>' + (sale ? "Record a sale" : "Record an expense") + '</h1><p class="strip" id="strip">' + stripText(kind) + "</p></div>" +
      '<form class="entry" data-form="entry" data-kind="' + kind + '" novalidate>' +
      '<fieldset class="tiles"><legend>' + (sale ? "What was sold?" : "What was it for?") + "</legend>" + tiles + "</fieldset>" +
      '<label class="field" id="custom-wrap" hidden>What was it?<input name="custom" maxlength="80"></label>' +
      '<div class="amount-row' + (sale ? "" : " single") + '">' +
      (sale ? '<div class="field"><span class="lbl">Quantity</span><div class="stepper"><button type="button" data-action="qty-dec" aria-label="One less">−</button><input name="qty" inputmode="numeric" value="1" aria-label="Quantity"><button type="button" data-action="qty-inc" aria-label="One more">+</button></div></div>' +
        '<label class="field">Price each<input name="unit" inputmode="decimal" placeholder="optional" autocomplete="off"></label>' : "") +
      '<label class="field total">' + (sale ? "Total" : "Amount") + '<input name="amount" inputmode="decimal" placeholder="0.00" autocomplete="off" required></label></div>' +
      '<fieldset class="seg"><legend>' + (sale ? "Paid by" : "Paid with") + "</legend>" + methods + "</fieldset>" +
      '<div class="two"><label class="field">Date<input type="date" name="date" value="' + today + '" max="' + today + '"></label><label class="field">Note (optional)<input name="note" maxlength="120" placeholder="' + (sale ? "e.g. customer name" : "e.g. supplier") + '"></label></div>' +
      '<p class="form-error" id="entry-error" role="alert" hidden></p>' +
      '<button class="btn btn-green btn-lg" type="submit">Save ' + (sale ? "sale" : "expense") + "</button></form></section>";
  }
  function entryQty(f) { var q = parseInt(f.elements.qty && f.elements.qty.value, 10); return q > 0 ? q : 1; }
  function entryRecalc(f) {
    var u = BP.parseMoney(f.elements.unit && f.elements.unit.value);
    if (u) f.elements.amount.value = BP.plainAmount(u * entryQty(f));
  }
  function entryPick(f, focus) {
    var r = $('input[name="item"]:checked', f);
    if (!r) return;
    var other = r.value === BP.OTHER;
    $("#custom-wrap", f).hidden = !other;
    var price = r.dataset.price;
    if (f.elements.unit) f.elements.unit.value = price ? BP.plainAmount(Number(price)) : "";
    if (f.dataset.kind === "sale") f.elements.amount.value = price ? BP.plainAmount(Number(price) * entryQty(f)) : "";
    else f.elements.amount.value = "";
    if (other && focus) $('input[name="custom"]', f).focus();
  }

  // ---------- history ----------
  function histRows() {
    var h = S.ui.hist, q = h.q.trim().toLowerCase();
    return BP.txs().filter(function (t) {
      return (h.type === "all" || t.type === h.type) && (!h.from || t.date >= h.from) && (!h.to || t.date <= h.to) &&
        (!q || (t.label + " " + (t.note || "") + " " + (t.method || "")).toLowerCase().indexOf(q) >= 0);
    }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (b.created || 0) - (a.created || 0); });
  }
  function histList() {
    var rows = histRows(), h = S.ui.hist, shown = rows.slice(0, h.limit), out = "", cur = "", open = false, totals = {};
    if (!rows.length) return '<div class="empty"><p><strong>No entries match.</strong><br>Try a wider date range or clear the search.</p></div>';
    rows.forEach(function (t) { totals[t.date] = (totals[t.date] || 0) + (t.type === "sale" ? t.amount_cents : -t.amount_cents); });
    shown.forEach(function (t) {
      if (t.date !== cur) {
        if (open) out += "</ul>";
        cur = t.date; open = true;
        out += '<h3 class="day">' + esc(shortDate(cur)) + '<span class="' + (totals[cur] >= 0 ? "pos" : "neg") + '">' + esc(money(totals[cur])) + '</span></h3><ul class="ledger tall">';
      }
      out += '<li><span class="l-dot ' + t.type + '" title="' + t.type + '"></span><span class="l-main"><span class="l-what">' + esc(t.label) + qtyText(t) + "</span><small>" + esc([t.method, t.note].filter(Boolean).join(" · ")) + '</small></span><span class="l-amt ' + (t.type === "sale" ? "pos" : "neg") + '">' + (t.type === "sale" ? "+" : "-") + esc(money(t.amount_cents)) +
        '</span><button class="icon-btn" type="button" data-action="del-tx" data-id="' + esc(t.id) + '" aria-label="Delete ' + esc(t.label) + '">' + icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>') + "</button></li>";
    });
    if (open) out += "</ul>";
    if (rows.length > shown.length) out += '<p class="more"><button class="btn btn-ghost on-light" type="button" data-action="hist-more">Show more (' + (rows.length - shown.length) + " left)</button></p>";
    return out;
  }
  function vHistory() {
    var h = S.ui.hist;
    function opt(v, l) { return '<option value="' + v + '"' + (h.type === v ? " selected" : "") + ">" + l + "</option>"; }
    return '<section class="page"><div class="page-head"><h1>History</h1><button class="btn btn-ghost on-light btn-sm" type="button" data-action="export-filtered">Download spreadsheet</button></div>' +
      '<form class="filters" data-live="hist"><label class="field">Show<select name="type">' + opt("all", "Everything") + opt("sale", "Sales") + opt("expense", "Expenses") + "</select></label>" +
      '<label class="field">From<input type="date" name="from" value="' + esc(h.from) + '"></label><label class="field">To<input type="date" name="to" value="' + esc(h.to) + '"></label>' +
      '<label class="field grow">Search<input type="search" name="q" value="' + esc(h.q) + '" placeholder="Item, note or payment method"></label></form>' +
      '<div id="hist-list">' + histList() + "</div></section>";
  }

  // ---------- reports ----------
  function period() {
    var today = BP.isoDate(), p = S.ui.period, start;
    if (p === "today") start = today;
    else if (p === "30") start = BP.addDays(today, -29);
    else if (p === "month") start = today.slice(0, 8) + "01";
    else start = BP.addDays(today, -6);
    var days = BP.daysBetween(start, today) + 1;
    return { start: start, end: today, days: days, prevStart: BP.addDays(start, -days), prevEnd: BP.addDays(start, -1) };
  }
  function rankList(map, empty, showQty) {
    var rows = Object.keys(map).map(function (k) { return { k: k, v: map[k] }; }).sort(function (a, b) { return b.v.total - a.v.total; }).slice(0, 6);
    if (!rows.length) return '<p class="muted">' + empty + "</p>";
    return '<ul class="rank">' + rows.map(function (r) {
      return "<li><span>" + esc(r.k) + (showQty && r.v.qty > 1 ? " <small class=\"x\">×" + r.v.qty + "</small>" : "") + "</span><b>" + esc(money(r.v.total)) + "</b></li>";
    }).join("") + "</ul>";
  }
  function vReports() {
    var p = period(), a = BP.aggregate(p.start, p.end), b = BP.aggregate(p.prevStart, p.prevEnd);
    var labels = { today: "Today", "7": "7 days", "30": "30 days", month: "This month" };
    var seg = Object.keys(labels).map(function (k) { return '<label class="seg-opt"><input type="radio" name="period" value="' + k + '"' + (S.ui.period === k ? " checked" : "") + "><span>" + labels[k] + "</span></label>"; }).join("");
    var max = 1, days = [];
    for (var i = 0; i < p.days; i++) {
      var d = BP.addDays(p.start, i), v = a.daily[d] || { s: 0, e: 0 };
      days.push({ d: d, s: v.s, e: v.e });
      max = Math.max(max, v.s, v.e);
    }
    var step = p.days > 20 ? 5 : 1;
    var chart = '<div class="chart" aria-hidden="true">' + days.map(function (x, n) {
      var lab = p.days <= 7 ? BP.parseISO(x.d).toLocaleDateString("en-GB", { weekday: "short" }) : BP.parseISO(x.d).getDate();
      return '<div class="col" title="' + esc(shortDate(x.d) + ": sales " + money(x.s) + ", expenses " + money(x.e)) + '"><div class="bars"><i class="bar s" style="height:' + (x.s / max * 100).toFixed(1) + '%"></i><i class="bar e" style="height:' + (x.e / max * 100).toFixed(1) + '%"></i></div><span class="lab">' + (n % step === 0 ? lab : "") + "</span></div>";
    }).join("") + "</div>";
    var table = '<table class="tbl"><thead><tr><th>Day</th><th class="num">Sales</th><th class="num">Expenses</th><th class="num">Net</th></tr></thead><tbody>' + days.slice().reverse().map(function (x) {
      return "<tr><td>" + esc(shortDate(x.d)) + '</td><td class="num">' + esc(money(x.s)) + '</td><td class="num">' + esc(money(x.e)) + '</td><td class="num ' + (x.s - x.e >= 0 ? "pos" : "neg") + '">' + esc(money(x.s - x.e)) + "</td></tr>";
    }).join("") + "</tbody></table>";
    function card(label, cur, prev, cls) { return '<div class="stat"><span>' + label + '</span><b class="' + cls + '">' + esc(money(cur)) + "</b><span>Before: " + esc(money(prev)) + "</span></div>"; }
    return '<section class="page"><div class="page-head"><h1>Reports</h1><button class="btn btn-ghost on-light btn-sm" type="button" data-action="print">Print</button></div>' +
      '<form data-live="period"><fieldset class="seg wide"><legend class="sr">Period</legend>' + seg + "</fieldset></form>" +
      '<p class="muted range">' + esc(shortDate(p.start)) + (p.days > 1 ? " to " + esc(shortDate(p.end)) : "") + " · compared with the " + plural(p.days, "day") + " before</p>" +
      '<div class="stats">' + card("Sales", a.sales, b.sales, "pos") + card("Expenses", a.expenses, b.expenses, "neg") + card("Net", a.net, b.net, a.net >= 0 ? "pos" : "neg") + "</div>" +
      '<div class="chart-card"><div class="legend"><span><i class="bar s"></i>Sales</span><span><i class="bar e"></i>Expenses</span></div>' + chart + "</div>" +
      '<details class="numbers"><summary>See the numbers day by day</summary><div class="table-scroll">' + table + "</div></details>" +
      '<div class="rank-grid"><section><h2>Best sellers</h2>' + rankList(a.items, "No sales in this period.", true) + "</section><section><h2>Biggest costs</h2>" + rankList(a.costs, "No expenses in this period.") + "</section><section><h2>Paid by</h2>" + rankList(a.methods, "No sales in this period.") + "</section></div></section>";
  }

  // ---------- settings ----------
  function vSettings() {
    var s = BP.settings() || {}, sale = BP.items("sale"), exp = BP.items("expense"), L = BP.licState();
    var presets = Object.keys(BP.PRESETS).map(function (k) { return '<option value="' + k + '"' + (k === s.btype ? " selected" : "") + ">" + esc(BP.PRESETS[k].label) + "</option>"; }).join("");
    var x = icon('<path d="M6 6l12 12M18 6L6 18"/>');
    var saleRows = sale.map(function (i) {
      return '<li class="item-row"><span>' + esc(i.name) + '</span><span class="i-edit"><input class="price-in" inputmode="decimal" value="' + (i.price_cents ? BP.plainAmount(i.price_cents) : "") + '" placeholder="no price" aria-label="Price for ' + esc(i.name) + '"><button class="btn btn-ghost on-light btn-sm" type="button" data-action="save-price" data-id="' + esc(i.id) + '">Save</button></span><button class="icon-btn" type="button" data-action="del-item" data-id="' + esc(i.id) + '" aria-label="Remove ' + esc(i.name) + '">' + x + "</button></li>";
    }).join("") || '<li class="muted">No services yet. Add your first one below.</li>';
    var expRows = exp.map(function (i) {
      return '<li class="item-row"><span>' + esc(i.name) + '</span><span></span><button class="icon-btn" type="button" data-action="del-item" data-id="' + esc(i.id) + '" aria-label="Remove ' + esc(i.name) + '">' + x + "</button></li>";
    }).join("") || '<li class="muted">No categories yet.</li>';
    var subText = L.status === "trial" ? "Free trial: " + plural(Math.max(L.daysLeft, 0), "day") + " left"
      : L.status === "active" ? "Subscribed. " + plural(Math.max(L.daysLeft, 0), "day") + " left" : "Subscription ended";
    return '<section class="page narrow-page"><div class="page-head"><h1>Settings</h1></div>' +
      '<section class="panel"><h2>Your business</h2><form data-form="profile" class="stack"><div class="two"><label class="field">Business name<input name="name" value="' + esc(s.name || "") + '" maxlength="60" required></label><label class="field">Currency symbol<input name="currency" value="' + esc(s.currency || "$") + '" maxlength="6"></label></div><button class="btn btn-green btn-sm" type="submit">Save</button></form></section>' +
      '<section class="panel"><h2>Services and prices</h2><p class="muted">These are the tiles on the sale screen. A price fills in the total for you. The starting prices are only examples, so change them to yours.</p><ul class="items">' + saleRows + "</ul>" +
      '<form data-form="add-item" data-kind="sale" class="add-row"><label class="field grow">New service or item<input name="name" maxlength="80" placeholder="e.g. A3 colour print" required></label><label class="field">Price each<input name="price" inputmode="decimal" placeholder="optional" size="8"></label><button class="btn btn-green btn-sm" type="submit">Add</button></form></section>' +
      '<section class="panel"><h2>Expense categories</h2><ul class="items">' + expRows + '</ul><form data-form="add-item" data-kind="expense" class="add-row"><label class="field grow">New category<input name="name" maxlength="80" placeholder="e.g. Lamination pouches" required></label><button class="btn btn-green btn-sm" type="submit">Add</button></form></section>' +
      '<section class="panel"><h2>Add a business template</h2><p class="muted">Adds the services and categories you do not have yet. Nothing you already set up is changed or removed.</p><form data-form="preset" class="add-row"><label class="field grow">Template<select name="btype">' + presets + '</select></label><button class="btn btn-ghost on-light btn-sm" type="submit">Add items</button></form></section>' +
      '<section class="panel"><h2>Subscription</h2><p>' + esc(subText) + '</p><a class="btn btn-ghost on-light btn-sm" href="#/subscribe">Manage subscription</a></section>' +
      '<section class="panel"><h2>Your data and account</h2><p class="muted">Signed in as ' + esc(S.session.email) + ". Your records are kept on this device and backed up, encrypted, when you are online.</p>" +
      '<div class="btn-row"><button class="btn btn-ghost on-light btn-sm" type="button" data-action="export-all">Download all records</button><button class="btn btn-ghost on-light btn-sm" type="button" data-action="sync-now">Back up now</button><button class="btn btn-ghost on-light btn-sm" type="button" data-action="logout">Log out</button></div>' +
      '<form data-form="password" class="stack pw"><h3>Change password</h3><div class="two"><label class="field">Current password<input name="old" type="password" autocomplete="current-password" required></label><label class="field">New password<input name="new" type="password" autocomplete="new-password" minlength="8" required></label></div><p class="form-error" id="pw-error" role="alert" hidden></p><button class="btn btn-green btn-sm" type="submit">Change password</button></form>' +
      '<form data-form="delete-account" class="stack danger"><h3>Delete my account</h3><p class="muted">Permanently deletes your account and every record from this device and from our server. Download your records first.</p><label class="field">Your password<input name="password" type="password" autocomplete="current-password" required></label><p class="form-error" id="del-error" role="alert" hidden></p><button class="btn btn-ghost on-light btn-sm" type="submit">Delete my account and records</button></form></section>' +
      '<section class="panel"><h2>Use it as an app</h2><p class="muted"><strong>Computer (Chrome or Edge):</strong> click Install app, or use the install icon in the address bar.<br><strong>Android (Chrome):</strong> menu, then Install app.<br><strong>iPhone (Safari):</strong> Share, then Add to Home Screen.</p><button class="btn btn-gold btn-sm" data-action="install" type="button" hidden>Install app</button></section>' +
      '<p class="legal-links"><a href="/terms" target="_blank" rel="noopener">Terms</a> · <a href="/privacy" target="_blank" rel="noopener">Privacy</a></p></section>';
  }

  // ---------- subscription + lock ----------
  function redeemForm() {
    return '<form data-form="redeem" class="stack"><label class="field">Licence key<input name="code" placeholder="BP1.…" autocomplete="off" autocapitalize="off" spellcheck="false" required></label><p class="form-error" id="redeem-error" role="alert" hidden></p><button class="btn btn-green" type="submit">Add to my subscription</button></form>';
  }
  function payInfo() { var L = S.meta.license || {}; return L.pay_info ? '<div class="payinfo"><h3>How to pay</h3><p>' + esc(L.pay_info) + "</p></div>" : ""; }
  function vSubscribe() {
    var L = BP.licState(), lic = S.meta.license || {}, state, body;
    if (L.status === "active") { state = "Subscribed"; body = "Your subscription runs until <strong>" + esc(fullDate(lic.paid_until)) + "</strong> (" + plural(Math.max(L.daysLeft, 0), "day") + " left). Adding a key extends it."; }
    else if (L.status === "trial") { state = "Free trial"; body = "Your free trial ends on <strong>" + esc(fullDate(lic.trial_ends)) + "</strong> (" + plural(Math.max(L.daysLeft, 0), "day") + " left). Add a key any time and your paid time starts when the trial ends."; }
    else { state = "Subscription ended"; body = "Add a licence key to keep recording."; }
    return '<section class="page narrow-page"><div class="page-head"><h1>Subscription</h1></div><section class="panel"><h2>' + state + "</h2><p>" + body + "</p></section>" +
      '<section class="panel"><h2>Enter a licence key</h2>' + redeemForm() + "</section>" + (payInfo() ? '<section class="panel">' + payInfo() + "</section>" : "") + "</section>";
  }
  function vLock() {
    var L = BP.licState(), msg = {
      "trial-ended": ["Your free trial has ended", "To keep recording sales and expenses, enter a licence key. Your records are safe, and you can download them below."],
      expired: ["Your subscription has ended", "To keep recording, enter a new licence key. Your records are safe, and you can download them below."],
      suspended: ["This account is suspended", "Please contact support to sort this out. You can still download your records."],
      clock: ["Check your device's date and time", "The date on this device looks wrong. Set the correct date and time, or connect to the internet, then check again."],
      none: ["Connect to the internet", "BizPilot needs to check your subscription once. Connect to the internet, then check again."]
    }[L.status] || ["Subscription needed", "Enter a licence key to continue."];
    var canRedeem = L.status === "trial-ended" || L.status === "expired";
    return '<div class="lock"><div class="lock-card"><a class="logo dark" href="/app">' + LOGO + "BizPilot</a><h1>" + msg[0] + "</h1><p>" + msg[1] + "</p>" +
      (canRedeem ? redeemForm() + payInfo() : "") +
      '<p class="form-error" id="lock-error" role="alert" hidden></p><div class="btn-row"><button class="btn btn-ghost on-light" type="button" data-action="check-again">Check again</button><button class="btn btn-ghost on-light" type="button" data-action="export-all">Download my records</button><button class="btn btn-ghost on-light" type="button" data-action="logout">Log out</button></div></div></div>';
  }

  // ---------- router ----------
  var ROUTES = { today: vToday, sale: function () { return vEntry("sale"); }, expense: function () { return vEntry("expense"); }, history: vHistory, reports: vReports, settings: vSettings, subscribe: vSubscribe };
  function currentRoute() { return location.hash.replace(/^#\/?/, "").split("?")[0] || "today"; }

  function render(opts) {
    opts = opts || {};
    var route = currentRoute();
    if (!S.session) {
      if (route !== "register") route = "login";
      root.innerHTML = vAuth(route);
      document.title = (route === "register" ? "Start free trial" : "Log in") + " · BizPilot";
      return;
    }
    if (route === "login" || route === "register") {
      if (S.sync.state === "auth") { root.innerHTML = vAuth("relogin"); document.title = "Log in again · BizPilot"; return; }
      location.replace("#/today"); return;
    }
    if (S.locked) { root.innerHTML = vLock(); document.title = "Subscription needed · BizPilot"; return; }
    if (!ROUTES[route]) route = "today";
    if (!$(".shell")) renderShell();
    var view = document.getElementById("view");
    view.innerHTML = ROUTES[route]();
    if (route === "sale" || route === "expense") entryPick($("form[data-form=entry]"));
    $$("[data-nav]").forEach(function (a) { if (a.dataset.nav === route) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    document.title = TITLES[route] + " · " + biz();
    updateStatus();
    if (!opts.passive) { window.scrollTo(0, 0); view.focus({ preventScroll: true }); }
  }
  function passiveRefresh() {
    var route = currentRoute(), view = document.getElementById("view");
    if (!view || ["today", "history", "reports"].indexOf(route) < 0) { updateStatus(); return; }
    var ae = document.activeElement;
    if (ae && view.contains(ae) && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) { updateStatus(); return; }
    var y = window.scrollY;
    render({ passive: true });
    window.scrollTo(0, y);
  }

  // ---------- actions ----------
  function exportRows(rows) {
    rows = rows.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.created || 0) - (b.created || 0); });
    BP.download("bizpilot-records-" + BP.isoDate() + ".csv", BP.csv(rows));
  }
  var actions = {
    "toast-act": function () { var fn = toastAction; toastAction = null; document.getElementById("toast").hidden = true; if (fn) fn(); },
    "sync-now": function () {
      if (S.sync.state === "auth") { location.hash = "#/login"; render(); return; }
      if (!navigator.onLine) { toast("You're offline. Your entries are saved on this device and will back up later."); return; }
      BP.syncNow();
    },
    "install": function () { var e = S.installEvt; if (!e) return; e.prompt(); e.userChoice.then(function () { S.installEvt = null; $$("[data-action=install]").forEach(function (b) { b.hidden = true; }); }); },
    "qty-inc": function (el) { var f = el.closest("form"); f.elements.qty.value = Math.min(entryQty(f) + 1, 100000); entryRecalc(f); },
    "qty-dec": function (el) { var f = el.closest("form"); f.elements.qty.value = Math.max(entryQty(f) - 1, 1); entryRecalc(f); },
    "del-tx": function (el) {
      var id = el.dataset.id, t = S.rec.get(id);
      if (!t || !window.confirm("Delete this entry?\n" + t.label + " " + money(t.amount_cents))) return;
      BP.removeRecord(id).then(function () {
        render({ passive: true });
        toast("Entry deleted.", function () { BP.restoreRecord(id).then(function () { render({ passive: true }); toast("Entry restored."); }); });
      });
    },
    "hist-more": function () { S.ui.hist.limit += 100; document.getElementById("hist-list").innerHTML = histList(); },
    "export-filtered": function () { exportRows(histRows()); },
    "export-all": function () { exportRows(BP.txs()); },
    "print": function () { window.print(); },
    "save-price": function (el) {
      var v = $(".price-in", el.closest(".item-row")).value.trim(), cents = null;
      if (v) { cents = BP.parseMoney(v); if (cents == null) { toast("Enter the price as a number, like 2 or 12.50."); return; } }
      BP.setItemPrice(el.dataset.id, cents).then(function () { toast("Price saved."); });
    },
    "del-item": function (el) {
      var id = el.dataset.id, it = S.rec.get(id);
      if (!it || !window.confirm("Remove " + it.name + " from the list? Past entries are kept.")) return;
      BP.removeRecord(id).then(function () {
        render({ passive: true });
        toast("Removed.", function () { BP.restoreRecord(id).then(function () { render({ passive: true }); }); });
      });
    },
    "check-again": function () {
      if (!navigator.onLine) { showError("lock-error", "Still offline. Connect to the internet and try again."); return; }
      BP.refreshMe().then(function () { BP.touchSeen(); render(); }).catch(function (e) {
        if (e.status === 401) { S.sync.state = "auth"; location.hash = "#/login"; render(); } else showError("lock-error", e.message);
      });
    },
    "logout": async function () {
      var pending = BP.pendingCount();
      if (pending && navigator.onLine && !S.locked) { toast("Backing up before you log out…"); await BP.syncNow(); pending = BP.pendingCount(); }
      var msg = pending ? plural(pending, "entry", "entries") + " have not been backed up and will be lost from this device. Log out anyway?" : "Log out of BizPilot on this device?";
      if (!window.confirm(msg)) return;
      await BP.logout();
      location.hash = "#/login"; render();
    }
  };

  async function enterApp() {
    S.sync.state = "idle";
    if (S.rec.size === 0 && navigator.onLine) {
      root.innerHTML = '<div class="boot">Loading your records…</div>';
      try { await BP.pullAll(); } catch (e) { /* will retry in the background */ }
    }
    if (!BP.settings() && S.me) {
      await BP.saveSettings({ name: S.me.business_name, btype: S.me.business_type });
      if (!BP.items("sale").length) await BP.seedPreset(S.me.business_type);
    }
    location.hash = "#/today";
    render();
    BP.syncNow();
  }

  var forms = {
    register: async function (f) {
      var v = f.elements, err = "auth-error";
      showError(err, "");
      if (!v.business_name.value.trim()) return showError(err, "Enter your business name.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v.email.value.trim())) return showError(err, "Enter a valid email address.");
      if (v.password.value.length < 8) return showError(err, "Use a password with at least 8 characters.");
      if (!v.terms.checked) return showError(err, "Please agree to the terms and privacy policy to continue.");
      setBusy(f, true, "Creating your account…");
      try {
        await BP.register({ business_name: v.business_name.value.trim(), email: v.email.value.trim(), password: v.password.value, business_type: v.btype.value, currency: (v.currency.value.trim() || "$").slice(0, 6) });
        await enterApp();
      } catch (e) { setBusy(f, false); showError(err, e.message); }
    },
    login: async function (f) {
      var v = f.elements, err = "auth-error";
      showError(err, "");
      if (!v.email.value.trim() || !v.password.value) return showError(err, "Enter your email and password.");
      setBusy(f, true, "Logging in…");
      try { await BP.login(v.email.value.trim(), v.password.value); await enterApp(); }
      catch (e) { setBusy(f, false); showError(err, e.message); }
    },
    relogin: async function (f) {
      var err = "auth-error";
      showError(err, "");
      setBusy(f, true, "Logging in…");
      try { await BP.relogin(f.elements.password.value); location.hash = "#/today"; render(); toast("Logged in. Backing up your records."); }
      catch (e) { setBusy(f, false); showError(err, e.message); }
    },
    entry: async function (f) {
      var kind = f.dataset.kind, v = f.elements, err = "entry-error";
      showError(err, "");
      var pick = $('input[name="item"]:checked', f), label = pick ? (pick.value === BP.OTHER ? v.custom.value.trim() : pick.value) : "";
      var amount = BP.parseMoney(v.amount.value), qty = kind === "sale" ? parseInt(v.qty.value, 10) : 1, date = v.date.value || BP.isoDate();
      if (!label) return showError(err, "Choose what it was, or pick Other and type it.");
      if (amount == null) return showError(err, "Enter the " + (kind === "sale" ? "total" : "amount") + " as a number above zero, like 5 or 12.50.");
      if (!(qty >= 1 && qty <= 100000)) return showError(err, "Quantity must be a whole number, 1 or more.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > BP.isoDate()) return showError(err, "Choose today's date or an earlier one.");
      await BP.addTx({ type: kind, label: label, qty: qty, amount_cents: amount, method: $('input[name="method"]:checked', f).value, note: v.note.value.trim(), date: date });
      toast((kind === "sale" ? "Sale saved: " : "Expense saved: ") + label + (qty > 1 ? " ×" + qty : "") + " · " + money(amount));
      v.note.value = ""; if (v.custom) v.custom.value = ""; if (v.qty) v.qty.value = 1;
      entryPick(f);
      document.getElementById("strip").innerHTML = stripText(kind);
      if (navigator.vibrate) navigator.vibrate(15);
    },
    profile: async function (f) {
      var name = f.elements.name.value.trim();
      if (!name) return;
      await BP.saveSettings({ name: name, currency: (f.elements.currency.value.trim() || "$").slice(0, 6) });
      updateStatus(); toast("Saved.");
    },
    "add-item": async function (f) {
      var name = f.elements.name.value.trim(), price = null;
      if (!name) return;
      if (f.elements.price && f.elements.price.value.trim()) { price = BP.parseMoney(f.elements.price.value); if (price == null) { toast("Enter the price as a number, like 2 or 12.50."); return; } }
      var added = await BP.addItem(f.dataset.kind, name, price);
      toast(added ? "Added " + name + "." : name + " is already in the list.");
      if (added) render({ passive: true });
    },
    preset: async function (f) {
      var n = await BP.seedPreset(f.elements.btype.value);
      await BP.saveSettings({ btype: f.elements.btype.value });
      toast(n ? "Added " + plural(n, "item") + "." : "You already have all of those.");
      render({ passive: true });
    },
    password: async function (f) {
      var err = "pw-error"; showError(err, "");
      if (!navigator.onLine) return showError(err, "You need to be online to change your password.");
      setBusy(f, true, "Changing…");
      try { await BP.changePassword(f.elements.old.value, f.elements.new.value); f.reset(); toast("Password changed."); }
      catch (e) { showError(err, e.message); }
      setBusy(f, false);
    },
    "delete-account": async function (f) {
      var err = "del-error"; showError(err, "");
      if (!navigator.onLine) return showError(err, "You need to be online to delete your account.");
      if (!window.confirm("Delete your account and ALL records permanently? This cannot be undone.")) return;
      setBusy(f, true, "Deleting…");
      try { await BP.deleteAccount(f.elements.password.value); location.hash = "#/register"; render(); toast("Your account and records were deleted."); }
      catch (e) { setBusy(f, false); showError(err, e.message); }
    },
    redeem: async function (f) {
      var err = $(".form-error", f).id; showError(err, "");
      if (!navigator.onLine) return showError(err, "You need to be online to add a key.");
      setBusy(f, true, "Checking key…");
      try { var res = await BP.redeem(f.elements.code.value); toast("Key accepted." + (res.days ? " Added " + plural(res.days, "day") + "." : "")); render(); }
      catch (e) { setBusy(f, false); showError(err, e.message); }
    }
  };

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
  });
  document.addEventListener("submit", function (e) {
    if (e.target.closest("form[data-live]")) { e.preventDefault(); return; }     // filters update as you type
    var f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    if (f.dataset.busy) return;
    if (forms[f.dataset.form]) forms[f.dataset.form](f);
  });
  document.addEventListener("input", function (e) {
    var t = e.target, f = t.closest("form");
    if (!f) return;
    if (f.dataset.form === "entry" && (t.name === "qty" || t.name === "unit")) entryRecalc(f);
    if (f.dataset.live === "hist") { S.ui.hist[t.name] = t.value; S.ui.hist.limit = 100; document.getElementById("hist-list").innerHTML = histList(); }
  });
  document.addEventListener("change", function (e) {
    var t = e.target, f = t.closest("form");
    if (!f) return;
    if (f.dataset.form === "entry" && t.name === "item") entryPick(f, true);
    if (f.dataset.live === "period") { S.ui.period = t.value; render({ passive: true }); }
    if (f.dataset.live === "hist") { S.ui.hist[t.name] = t.value; S.ui.hist.limit = 100; document.getElementById("hist-list").innerHTML = histList(); }
  });
  window.addEventListener("hashchange", function () { render(); });
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); S.installEvt = e;
    $$("[data-action=install]").forEach(function (b) { b.hidden = false; });
  });
  window.addEventListener("appinstalled", function () { S.installEvt = null; $$("[data-action=install]").forEach(function (b) { b.hidden = true; }); toast("BizPilot is installed."); });
  BP.on("status", updateStatus);
  BP.on("data", passiveRefresh);
  BP.on("lock", function () { render(); });

  // ---------- start ----------
  async function boot() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
    S.session = BP.loadSession();
    if (!S.session) { render(); return; }
    try { await BP.openAccount(S.session.accountId); }
    catch (e) { root.innerHTML = '<div class="boot">This browser is blocking local storage, so BizPilot cannot save your records. Turn off private browsing or try another browser.</div>'; return; }
    BP.touchSeen();
    S.locked = !BP.licState().ok;
    if (S.rec.size === 0 && !S.meta.license) {          // local data was cleared: fetch it again
      if (!navigator.onLine) { root.innerHTML = '<div class="boot">Connect to the internet to reload your records.</div>'; return; }
      try { await BP.refreshMe(); await enterApp(); return; }
      catch (e) { if (e.status === 401) { S.sync.state = "auth"; location.hash = "#/login"; render(); return; } }
    }
    if (!location.hash || location.hash === "#/login" || location.hash === "#/register") location.hash = "#/today";
    render();
    if (S.me) BP.syncNow();
  }
  boot();
})();
