// ============ Estimator page ============
// Plug in savings, income and expenses; see month-by-month cash flow and savings ahead.
// Everything you change is saved to the "Expense Estimator" tab of your sheet (a second after you stop typing).
// Uses helpers from the main script: $, esc, money, money2, sum, todayISO, STATE, api, REMOTE, toast, showTip, hideTip,
// countUp, updateThumb, niceStep, fmtK, smoothPath.
(function () {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const FREQS = ["Monthly", "Weekly", "Every 2 weeks", "Yearly", "One-time"];
  const PERS = ["Paycheck", "Weekly", "Monthly", "Yearly"];
  const PER_LABEL = { Paycheck: "Per paycheck", Weekly: "Per week", Monthly: "Per month", Yearly: "Per year" };
  const DAY = 864e5, utc = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const isoDay = t => new Date(t).toISOString().slice(0, 10);
  const ym = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;
  const ord = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const E = { st: null, dirty: false, saving: false, queued: false, timer: 0, built: false, planKey: "", firstDraw: true,
    chart: (() => { try { return localStorage.getItem("est.chart") || "savings"; } catch (e) { return "savings"; } })() };

  // ---------- data helpers ----------
  const now = () => { const t = todayISO(); return { y: +t.slice(0, 4), m: +t.slice(5, 7) - 1 }; };
  function incomeByMonth(T, year) {
    const a = Array(12).fill(0);
    (T.income || []).forEach(r => {
      const pay = r[8] || r[0], amt = r[5] != null ? r[5] : r[4];
      if (pay && +pay.slice(0, 4) === year) a[+pay.slice(5, 7) - 1] += amt || 0;
    });
    return a;
  }
  function incomeYears(T) {
    const ys = {};
    (T.income || []).forEach(r => { const y = +(r[8] || r[0]).slice(0, 4); ys[y] = (ys[y] || 0) + ((r[5] != null ? r[5] : r[4]) || 0); });
    return Object.keys(ys).map(Number).sort().map(y => ({ y, total: ys[y], months: incomeByMonth(T, y).filter(v => v > 0).length }));
  }
  function defaultBasis(T) {
    const ys = incomeYears(T), cur = now().y;
    const full = ys.filter(x => x.months >= 9);
    const c = full.find(x => x.y === cur);
    return c ? c.y : full.length ? full[full.length - 1].y : ys.length ? ys[ys.length - 1].y : cur;
  }
  function seed(T) {
    const items = (T.budget && T.budget.items) || [];
    const pick = (name, re, freq) => {
      const it = items.find(i => re.test(i.name));
      const f = it && FREQS.includes(it.freq) ? it.freq : freq;
      return { name, amount: it ? r2(it.amount) : 0, freq: f, dueDay: f === "Monthly" ? 1 : null, dueMonth: "" };
    };
    const basis = defaultBasis(T), tot = sum(incomeByMonth(T, basis), v => v);
    const st = (T.settings || {})[now().y] || {};
    return {
      settings: {
        monthsAhead: 12, currentSavings: r2((T.savings && (T.savings.afterTaxes || T.savings.total)) || 0),
        monthlyIncome: Math.round(tot / 12), taxRate: st.taxRate || 0.253, pattern: "Seasonal", basisYear: basis
      },
      expenses: [
        pick("Rent", /^rent/i, "Monthly"), pick("Utilities", /^utilit/i, "Monthly"), pick("Phone", /^phone/i, "Monthly"),
        pick("Car insurance", /insurance/i, "Monthly"), pick("Groceries", /^grocer/i, "Weekly"), pick("Gas", /^gas/i, "Weekly"),
        pick("Eating out", /^(dining|eating)/i, "Weekly"), pick("Personal spending", /^personal/i, "Weekly")
      ],
      incomes: []
    };
  }
  function adopt(T) {
    const d = seed(T), src = T.estimator;
    if (!src || !src.expenses) { E.st = d; E.fromSeed = true; return; }
    E.fromSeed = false;
    const s = Object.assign({}, d.settings);
    Object.keys(src.settings || {}).forEach(k => { const v = src.settings[k]; if (v !== null && v !== "" && v !== undefined) s[k] = v; });
    if (s.pattern !== "Even") s.pattern = "Seasonal";
    E.st = { settings: s, expenses: src.expenses.map(x => ({ name: x.name, amount: x.amount || 0, freq: FREQS.includes(x.freq) ? x.freq : "Monthly",
      dueDay: x.dueDay || null, dueMonth: x.dueMonth || "", notes: x.notes || "" })),
      incomes: (src.incomes || []).map(cleanIncome) };
    E.savedAt = src.savedAt || "";
  }

  function cleanIncome(x) {
    const mo = v => /^\d{4}-\d{2}$/.test(String(v || "")) ? String(v) : "";
    const every = Math.round(+x.every) || 14;
    return { name: x.name || "", amount: +x.amount || 0, per: x.per === "Every 2 weeks" ? "Paycheck" : PERS.includes(x.per) ? x.per : "Monthly",
      firstPay: /^\d{4}-\d{2}-\d{2}$/.test(String(x.firstPay || "")) ? String(x.firstPay) : todayISO(),
      every: x.per === "Every 2 weeks" ? 14 : Math.max(1, Math.min(31, every)),
      from: mo(x.from), to: mo(x.to),
      type: x.type === "1099" ? "1099" : "W2", taxRate: x.taxRate != null && x.taxRate !== "" ? +x.taxRate : null, notes: x.notes || "" };
  }

  // ---------- the math ----------
  function amountIn(x, y, m) {
    const a = +x.amount || 0, days = new Date(y, m + 1, 0).getDate();
    if (x.freq === "Weekly") return a * days / 7;
    if (x.freq === "Every 2 weeks") return a * days / 14;
    if (x.freq === "Yearly") return x.dueMonth ? (+x.dueMonth === m + 1 ? a : 0) : a / 12;
    if (x.freq === "One-time") return x.dueMonth === `${y}-${String(m + 1).padStart(2, "0")}` ? a : 0;
    return a;
  }
  const perMonth = x => { const a = +x.amount || 0;
    return x.freq === "Weekly" ? a * 52 / 12 : x.freq === "Every 2 weeks" ? a * 26 / 12 : x.freq === "Yearly" ? a / 12 : x.freq === "One-time" ? 0 : a; };
  // CJ's jobs: only in months between "from" and "to" (either can be open-ended)
  const active = (x, key) => (!x.from || key >= x.from) && (!x.to || key <= x.to);
  // Paydays in a month: start at the first payday and step every N days
  function paydays(x, y, m) {
    const first = utc(x.firstPay), n = Math.max(1, Math.min(31, +x.every || 14)) * DAY;
    const a = Date.UTC(y, m, 1), b = Date.UTC(y, m + 1, 1), out = [];
    for (let t = first + Math.max(0, Math.ceil((a - first) / n)) * n; t < b; t += n) if (t >= first) out.push(t);
    return out;
  }
  function incomeIn(x, y, m) {
    if (!active(x, ym(y, m))) return 0;
    const a = +x.amount || 0, days = new Date(y, m + 1, 0).getDate();
    return x.per === "Paycheck" ? a * paydays(x, y, m).length : x.per === "Weekly" ? a * days / 7 : x.per === "Yearly" ? a / 12 : a;
  }
  const incPerMonth = x => { const a = +x.amount || 0;
    return x.per === "Paycheck" ? a * 365.25 / 12 / Math.max(1, +x.every || 14) : x.per === "Weekly" ? a * 52 / 12 : x.per === "Yearly" ? a / 12 : a; };
  const incRate = x => x.type === "1099" ? (x.taxRate != null ? x.taxRate : (+S().taxRate || 0)) : 0;
  function shape(T, s) {
    const arr = incomeByMonth(T, +s.basisYear), tot = sum(arr, v => v), months = arr.filter(v => v > 0).length;
    if (s.pattern !== "Seasonal" || !tot || months < 9) return { f: Array(12).fill(1), ok: s.pattern !== "Seasonal", arr, tot, months };
    return { f: arr.map(v => v * 12 / tot), ok: true, arr, tot, months };
  }
  function compute() {
    const T = STATE.T, s = E.st.settings, N = Math.max(1, Math.min(60, Math.round(+s.monthsAhead || 12)));
    const sh = shape(T, s), n0 = now();
    const months = [];
    let bal = +s.currentSavings || 0;
    for (let i = 0; i < N; i++) {
      const y = n0.y + Math.floor((n0.m + 1 + i) / 12), m = (n0.m + 1 + i) % 12;
      const you = (+s.monthlyIncome || 0) * sh.f[m], youTax = you * (+s.taxRate || 0);
      const jobs = E.st.incomes.map(x => ({ x, amt: incomeIn(x, y, m) })).filter(o => o.amt > 0);
      jobs.forEach(o => o.tax = o.amt * incRate(o.x));
      const cj = sum(jobs, o => o.amt), cjTax = sum(jobs, o => o.tax);
      const inc = you + cj, tax = youTax + cjTax;
      const items = E.st.expenses.map(x => ({ x, amt: amountIn(x, y, m) })).filter(o => o.amt > 0);
      const exp = sum(items, o => o.amt), left = inc - tax - exp;
      const start = bal; bal += left;
      months.push({ y, m, key: ym(y, m), you, youTax, cj, cjTax, jobs, inc, tax, exp, left, start, end: bal, items });
    }
    let need = 0;
    for (let i = months.length - 1; i >= 0; i--) { need = Math.max(0, need - months[i].left); months[i].reserve = need; }
    return { months, sh, N, start: +s.currentSavings || 0, end: bal,
      avgExp: sum(months, d => d.exp) / N, avgLeft: sum(months, d => d.left) / N, avgInc: sum(months, d => d.inc) / N,
      avgYou: sum(months, d => d.you) / N, avgCj: sum(months, d => d.cj) / N, avgCjTax: sum(months, d => d.cjTax) / N,
      maxReserve: Math.max(0, ...months.map(d => d.reserve)) };
  }
  const mLabel = (d, long) => long ? `${MON[d.m]} ${d.y}` : MON[d.m] + (d.m === 0 ? ` ’${String(d.y).slice(2)}` : "");

  // ---------- saving ----------
  function setStatus(txt, cls) { const el = $("est-save"); el.textContent = txt; el.className = "save-state " + (cls || ""); }
  function payload() {
    return { settings: E.st.settings, expenses: E.st.expenses.filter(x => String(x.name || "").trim())
      .map(x => ({ name: x.name.trim(), amount: +x.amount || 0, freq: x.freq, dueDay: x.dueDay || "", dueMonth: x.dueMonth || "", notes: x.notes || "" })),
      incomes: E.st.incomes.filter(x => String(x.name || "").trim())
        .map(x => ({ name: x.name.trim(), amount: +x.amount || 0, per: x.per, firstPay: x.per === "Paycheck" ? x.firstPay : "", every: x.per === "Paycheck" ? x.every : "",
          from: x.from || "", to: x.to || "", type: x.type,
          taxRate: x.type === "1099" ? incRate(x) : "", notes: x.notes || "" })) };
  }
  function changed() {
    E.dirty = true; E.fromSeed = false;
    setStatus("Unsaved changes…");
    clearTimeout(E.timer); E.timer = setTimeout(save, 900);
    outputs();
  }
  function save() {
    clearTimeout(E.timer);
    if (!E.dirty) return;
    if (!REMOTE) { E.dirty = false; setStatus("Preview only · not saved"); return; }
    if (E.saving) { E.queued = true; return; }
    E.saving = true; E.dirty = false; setStatus("Saving…");
    const sent = payload();
    api("saveEstimator", { estimator: sent })
      .then(r => {
        E.savedAt = r && r.savedAt; if (STATE.T) STATE.T.estimator = r;
        if (E.dirty) return;
        if (sent.incomes.length && !(r && Array.isArray(r.incomes))) { E.dirty = true; setStatus("Expenses saved, but CJ's income isn't: paste the new Code.gs and deploy a new version", "bad"); }
        else setStatus("Saved to your sheet", "ok");
      })
      .catch(e => {
        E.dirty = true;
        const msg = String(e && e.message || e);
        setStatus(/Unknown action/.test(msg) ? "Not saved: paste the new Code.gs into Apps Script and deploy a new version" : "Not saved: " + msg + " · tap to retry", "bad");
      })
      .finally(() => { E.saving = false; if (E.queued) { E.queued = false; save(); } });
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden && E.dirty) save(); });
  $("est-save").onclick = () => { if (E.dirty) save(); };

  // ---------- inputs ----------
  const S = () => E.st.settings;
  function inputs() {
    const T = STATE.T, s = S();
    $("est-months").value = s.monthsAhead; $("est-months-range").value = Math.min(36, s.monthsAhead);
    $("est-savings").value = r2(s.currentSavings);
    $("est-income").value = Math.round(s.monthlyIncome); $("est-income-yr").value = Math.round(s.monthlyIncome * 12);
    $("est-tax").value = r2((+s.taxRate || 0) * 100);
    const sv = T.savings || {};
    $("est-sav-quick").innerHTML = [["Actually yours", sv.afterTaxes], ["Total", sv.total]].filter(([, v]) => v)
      .map(([l, v]) => `<button type="button" class="qchip" data-v="${v}">${l} <b>${money(v)}</b></button>`).join("");
    $("est-sav-quick").querySelectorAll("button").forEach(b => b.onclick = () => { s.currentSavings = +b.dataset.v; $("est-savings").value = r2(s.currentSavings); changed(); });
    quickIncome();
  }
  function quickIncome() {
    const s = S();
    $("est-inc-quick").innerHTML = incomeYears(STATE.T).filter(x => x.total > 0).slice(-3).map(x =>
      `<button type="button" class="qchip ${x.y === +s.basisYear ? "on" : ""}" data-y="${x.y}" title="${x.months} months with income">${x.y} ÷ 12 <b>${money(x.total / 12)}</b></button>`).join("");
    $("est-inc-quick").querySelectorAll("button").forEach(b => b.onclick = () => {
      const y = +b.dataset.y, tot = sum(incomeByMonth(STATE.T, y), v => v);
      s.basisYear = y; s.monthlyIncome = Math.round(tot / 12);
      $("est-income").value = s.monthlyIncome; $("est-income-yr").value = Math.round(s.monthlyIncome * 12);
      quickIncome(); changed();
    });
    const pat = $("est-pattern");
    pat.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.m === s.pattern));
    updateThumb(pat);
  }
  function bindInputs() {
    const num = el => { const v = parseFloat(String(el.value).replace(/[$,\s]/g, "")); return isNaN(v) ? 0 : v; };
    const setMonths = v => { v = Math.max(1, Math.min(60, Math.round(v) || 1)); S().monthsAhead = v; $("est-months").value = v; $("est-months-range").value = Math.min(36, v); changed(); };
    $("est-months").oninput = e => { if (e.target.value !== "") setMonths(num(e.target)); };
    $("est-months").onblur = e => { e.target.value = S().monthsAhead; };
    $("est-months-range").oninput = e => setMonths(+e.target.value);
    document.querySelectorAll("#page-estimator [data-step]").forEach(b => b.onclick = () => setMonths(S().monthsAhead + +b.dataset.step));
    $("est-savings").oninput = e => { S().currentSavings = num(e.target); changed(); };
    $("est-income").oninput = e => { S().monthlyIncome = num(e.target); $("est-income-yr").value = Math.round(S().monthlyIncome * 12); changed(); };
    $("est-income-yr").oninput = e => { S().monthlyIncome = num(e.target) / 12; $("est-income").value = Math.round(S().monthlyIncome); changed(); };
    $("est-tax").oninput = e => { S().taxRate = num(e.target) / 100; changed(); };
    $("est-pattern").querySelectorAll("button").forEach(b => b.onclick = () => { S().pattern = b.dataset.m; quickIncome(); changed(); });
    $("est-add").onclick = () => {
      E.st.expenses.push({ name: "", amount: 0, freq: "Monthly", dueDay: 1, dueMonth: "" });
      list(); const rows = $("est-list").querySelectorAll(".erow"); rows[rows.length - 1].querySelector(".e-name").focus();
      outputs();
    };
    $("inc-add").onclick = () => {
      E.st.incomes.push(cleanIncome({ name: "", per: "Paycheck", every: 14, type: "W2" }));
      incList(); const rows = $("inc-list").querySelectorAll(".irow"); rows[rows.length - 1].querySelector(".e-name").focus();
      outputs();
    };
    document.querySelectorAll("#est-chart-mode button").forEach(b => b.onclick = () => {
      E.chart = b.dataset.m; try { localStorage.setItem("est.chart", E.chart); } catch (e) {}
      E.firstDraw = true; chart();
    });
    $("est-plan-month").onchange = e => { E.planKey = e.target.value; plan(); };
    addEventListener("resize", () => { if (!$("page-estimator").hidden && E.st) { E.firstDraw = false; chart(); } });
  }

  // ---------- expense list ----------
  function dueOptions(x) {
    const N = Math.max(12, +S().monthsAhead || 12), n0 = now();
    if (x.freq === "Monthly") return [["", "Throughout the month"]].concat(Array.from({ length: 31 }, (_, i) => [String(i + 1), "Due the " + ord(i + 1)]));
    if (x.freq === "Weekly") return [["", "Every week"]];
    if (x.freq === "Every 2 weeks") return [["", "Every other week"]];
    if (x.freq === "Yearly") return MON.map((mn, i) => [String(i + 1), "Every " + mn]);
    return Array.from({ length: N }, (_, i) => {
      const y = n0.y + Math.floor((n0.m + 1 + i) / 12), m = (n0.m + 1 + i) % 12;
      return [`${y}-${String(m + 1).padStart(2, "0")}`, `In ${MON[m]} ${y}`];
    });
  }
  const dueValue = x => x.freq === "Monthly" ? (x.dueDay ? String(x.dueDay) : "") : (x.freq === "Yearly" || x.freq === "One-time") ? String(x.dueMonth || "") : "";
  function setDue(x, v) {
    if (x.freq === "Monthly") { x.dueDay = v ? +v : null; x.dueMonth = ""; }
    else if (x.freq === "Yearly" || x.freq === "One-time") { x.dueMonth = v; x.dueDay = null; }
    else { x.dueDay = null; x.dueMonth = ""; }
  }
  const moText = x => x.freq === "One-time" ? "once" : money(perMonth(x)) + "/mo";
  function list() {
    const L = $("est-list");
    L.innerHTML = E.st.expenses.length ? E.st.expenses.map((x, i) => {
      const opts = dueOptions(x), dv = dueValue(x);
      return `<div class="erow" data-i="${i}">
        <input class="e-name" value="${esc(x.name)}" placeholder="Expense name" aria-label="Expense name" maxlength="120">
        <label class="e-amt"><span>$</span><input type="number" inputmode="decimal" step="0.01" min="0" value="${x.amount ? r2(x.amount) : ""}" placeholder="0" aria-label="Amount"></label>
        <select class="e-freq" aria-label="How often">${FREQS.map(f => `<option ${f === x.freq ? "selected" : ""}>${f}</option>`).join("")}</select>
        <select class="e-due" aria-label="When it's due" ${opts.length < 2 ? "disabled" : ""}>${opts.map(([v, l]) => `<option value="${v}" ${v === dv ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="e-mo">${moText(x)}</span>
        <button type="button" class="e-del" aria-label="Delete ${esc(x.name || "expense")}" title="Delete">×</button>
      </div>`;
    }).join("") : `<p class="muted" style="margin:6px 2px">No expenses yet. Add one to see where your money goes.</p>`;
    L.querySelectorAll(".erow").forEach(row => {
      const x = E.st.expenses[+row.dataset.i];
      row.querySelector(".e-name").oninput = e => { x.name = e.target.value; changed(); };
      row.querySelector(".e-amt input").oninput = e => { x.amount = parseFloat(e.target.value) || 0; row.querySelector(".e-mo").textContent = moText(x); changed(); };
      row.querySelector(".e-freq").onchange = e => {
        x.freq = e.target.value;
        const n0 = now(), nxt = `${n0.m === 11 ? n0.y + 1 : n0.y}-${String((n0.m + 1) % 12 + 1).padStart(2, "0")}`;
        if (x.freq === "Monthly") setDue(x, "1");
        else if (x.freq === "Yearly") setDue(x, String((n0.m + 1) % 12 + 1));
        else if (x.freq === "One-time") setDue(x, nxt);
        else setDue(x, "");
        list(); changed();
      };
      row.querySelector(".e-due").onchange = e => { setDue(x, e.target.value); changed(); };
      row.querySelector(".e-del").onclick = () => {
        const i = +row.dataset.i, gone = E.st.expenses.splice(i, 1)[0];
        list(); changed();
        undoToast(`Removed ${gone.name || "expense"}`, () => { E.st.expenses.splice(i, 0, gone); list(); changed(); });
      };
    });
  }
  // ---------- CJ's income list ----------
  function monthOpts(cur) {
    const n0 = now(), N = Math.max(36, (+S().monthsAhead || 12) + 12), keys = [];
    for (let i = 0; i < N; i++) { const y = n0.y + Math.floor((n0.m + i) / 12), m = (n0.m + i) % 12; keys.push({ k: ym(y, m), l: `${MON[m]} ${y}` }); }
    if (cur && !keys.some(o => o.k === cur)) keys.unshift({ k: cur, l: `${MON[+cur.slice(5) - 1]} ${cur.slice(0, 4)}` });
    return keys;
  }
  const incMoText = x => {
    const pm = incPerMonth(x), r = incRate(x);
    return `${money(pm)}/mo avg<small>${money(pm * 12)}/yr${x.type === "1099" && pm ? ` · ${money(pm * r)}/mo taxes` : ""}</small>`;
  };
  function incWhen(x) {
    const f = monthOpts(x.from), t = monthOpts(x.to), bad = x.from && x.to && x.to < x.from;
    return `<span>From</span><select class="i-from" aria-label="Earned from">
        <option value="">Now</option>${f.map(o => `<option value="${o.k}" ${o.k === x.from ? "selected" : ""}>${o.l}</option>`).join("")}</select>
      <span>to</span><select class="i-to" aria-label="Earned until">
        <option value="">Ongoing</option>${t.map(o => `<option value="${o.k}" ${o.k === x.to ? "selected" : ""}>${o.l}</option>`).join("")}</select>
      ${bad ? `<span class="i-warn" title="The end is before the start">!</span>` : ""}`;
  }
  function incPay(x) {
    if (x.per !== "Paycheck") return "";
    return `<span>First payday</span><input class="i-first" type="date" value="${x.firstPay}" aria-label="First payday">
      <span>every</span><span class="money-in i-every"><input type="number" min="1" max="31" step="1" inputmode="numeric" value="${x.every}" aria-label="Days between paydays"><em>days</em></span>`;
  }
  function nextPays(x) {
    if (x.per !== "Paycheck") return "";
    const n0 = now(), list = [];
    for (let i = 0; i < 3 && list.length < 3; i++) {
      const y = n0.y + Math.floor((n0.m + i) / 12), m = (n0.m + i) % 12;
      paydays(x, y, m).forEach(t => { if (isoDay(t) >= todayISO() && active(x, isoDay(t).slice(0, 7)) && list.length < 3) list.push(t); });
    }
    return list.length ? `Next: ${list.map(t => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; }).join(", ")}` : "";
  }
  function incTax(x) {
    return x.type === "1099"
      ? `<span>Set aside</span><span class="money-in"><input class="i-rate" type="number" step="0.1" min="0" max="60" inputmode="decimal" value="${r2(incRate(x) * 100)}" aria-label="Tax set-aside percent"><em>%</em></span>`
      : `<span>Taxes withheld by employer</span>`;
  }
  function incNotes(x) {
    if (x.open) return `<textarea class="i-notes" placeholder="How did we get this number? e.g. 14 students × $45/lesson × 4 weeks" maxlength="300" aria-label="Notes">${esc(x.notes)}</textarea>`;
    return x.notes ? `<div class="peek" title="Show notes">${esc(x.notes.split("\n")[0])}</div>` : "";
  }
  function youRow() {
    const s = S();
    $("inc-you").innerHTML = `<div class="y-name"><b>You · gigs</b>Average and busy/slow pattern from Your numbers · <a data-go>edit</a></div>
      <div class="i-type"><button type="button" class="on">1099</button></div>
      <div class="i-mo">${money(+s.monthlyIncome || 0)}/mo<small>${money((+s.monthlyIncome || 0) * 12)}/yr · ${r2((+s.taxRate || 0) * 100)}% set aside</small></div>`;
    $("inc-you").querySelector("[data-go]").onclick = () => { $("est-income").focus(); $("est-income").scrollIntoView({ block: "center", behavior: "smooth" }); };
  }
  function incList() {
    youRow();
    const L = $("inc-list");
    L.innerHTML = E.st.incomes.length ? E.st.incomes.map((x, i) => `<div class="irow" data-i="${i}">
        <input class="e-name" value="${esc(x.name)}" placeholder="Job (e.g. Piano lessons)" aria-label="Job name" maxlength="120">
        <label class="e-amt"><span>$</span><input type="number" inputmode="decimal" step="0.01" min="0" value="${x.amount ? r2(x.amount) : ""}" placeholder="0" aria-label="Amount"></label>
        <select class="i-per" aria-label="Per">${PERS.map(f => `<option value="${f}" ${f === x.per ? "selected" : ""}>${PER_LABEL[f]}</option>`).join("")}</select>
        <div class="i-type" role="group" aria-label="Tax type"><button type="button" data-t="W2" class="${x.type === "W2" ? "on" : ""}">W2</button><button type="button" data-t="1099" class="${x.type === "1099" ? "on" : ""}">1099</button></div>
        <button type="button" class="i-note ${x.notes ? "has" : ""}" aria-expanded="${!!x.open}">Notes</button>
        <button type="button" class="e-del" aria-label="Delete ${esc(x.name || "income")}" title="Delete">×</button>
        <div class="i-line2">
          <div class="i-pay" ${x.per === "Paycheck" ? "" : "hidden"}>${incPay(x)}</div>
          <div class="i-when">${incWhen(x)}</div>
          <div class="i-tax">${incTax(x)}</div>
          <div class="i-mo">${incMoText(x)}</div>
        </div>
        <div class="i-next">${nextPays(x)}</div>
        <div class="i-txt">${incNotes(x)}</div>
      </div>`).join("")
      : `<p class="muted" style="margin:6px 2px">No jobs yet. Add one for each place CJ gets paid, with her first payday and how often she's paid.</p>`;
    L.querySelectorAll(".irow").forEach(row => {
      const x = E.st.incomes[+row.dataset.i], q = c => row.querySelector(c);
      const refresh = () => { q(".i-mo").innerHTML = incMoText(x); q(".i-next").textContent = nextPays(x); };
      const bindPay = () => {
        const f = q(".i-first"), ev = q(".i-every input");
        if (f) f.onchange = e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { x.firstPay = e.target.value; refresh(); changed(); } };
        if (ev) {
          ev.oninput = e => { const v = Math.round(+e.target.value); if (v >= 1 && v <= 31) { x.every = v; refresh(); changed(); } };
          ev.onblur = e => { e.target.value = x.every; };
        }
      };
      const bindWhen = () => {
        q(".i-from").onchange = e => { x.from = e.target.value; q(".i-when").innerHTML = incWhen(x); bindWhen(); changed(); };
        q(".i-to").onchange = e => { x.to = e.target.value; q(".i-when").innerHTML = incWhen(x); bindWhen(); changed(); };
      };
      const bindTax = () => { const r = q(".i-rate"); if (r) r.oninput = e => { const v = parseFloat(e.target.value); x.taxRate = isNaN(v) ? 0 : v / 100; refresh(); changed(); }; };
      const bindNotes = () => {
        const t = q(".i-notes"), pk = q(".peek");
        if (t) t.oninput = e => { x.notes = e.target.value; q(".i-note").classList.toggle("has", !!x.notes); changed(); };
        if (pk) pk.onclick = () => toggleNotes(true);
      };
      const toggleNotes = open => {
        x.open = open; q(".i-note").setAttribute("aria-expanded", String(open));
        q(".i-txt").innerHTML = incNotes(x); bindNotes();
        if (open) q(".i-notes").focus();
      };
      q(".e-name").oninput = e => { x.name = e.target.value; changed(); };
      q(".e-amt input").oninput = e => { x.amount = parseFloat(e.target.value) || 0; refresh(); changed(); };
      q(".i-per").onchange = e => {
        x.per = e.target.value; const pay = q(".i-pay");
        pay.hidden = x.per !== "Paycheck"; pay.innerHTML = incPay(x); bindPay(); refresh(); changed();
      };
      row.querySelectorAll(".i-type button").forEach(b => b.onclick = () => {
        if (x.type === b.dataset.t) return;
        x.type = b.dataset.t; if (x.type === "1099" && x.taxRate == null) x.taxRate = +S().taxRate || 0;
        row.querySelectorAll(".i-type button").forEach(z => z.classList.toggle("on", z === b));
        q(".i-tax").innerHTML = incTax(x); bindTax(); refresh(); changed();
      });
      q(".i-note").onclick = () => toggleNotes(!x.open);
      q(".e-del").onclick = () => {
        const i = +row.dataset.i, gone = E.st.incomes.splice(i, 1)[0];
        incList(); changed();
        undoToast(`Removed ${gone.name || "income"}`, () => { E.st.incomes.splice(i, 0, gone); incList(); changed(); });
      };
      bindWhen(); bindTax(); bindNotes(); bindPay();
    });
  }
  function incTotals() {
    const hh = C.avgYou + C.avgCj;
    $("inc-totals").innerHTML = `<span class="chip">You <b>${money(C.avgYou)}</b>/mo</span>
      <span class="chip">CJ <b>${money(C.avgCj)}</b>/mo</span>
      <span class="chip">Together <b>${money(hh)}</b>/mo</span>` +
      (C.avgCjTax > 0 ? `<span class="chip">CJ's 1099 taxes <b>${money(C.avgCjTax)}</b>/mo</span>` : "") +
      `<span class="chip">Averages over the next ${C.N} month${C.N > 1 ? "s" : ""}</span>`;
    youRow();
  }
  function undoToast(msg, undo) {
    const t = $("toast");
    t.innerHTML = `${esc(msg)} <button type="button" class="toast-undo">Undo</button>`; t.style.display = "block";
    t.querySelector("button").onclick = () => { t.style.display = "none"; undo(); };
    clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = "none", 6000);
  }

  // ---------- outputs ----------
  let C = null;
  function outputs() {
    if (!E.st || !STATE.T) return;
    C = compute();
    kpis(); chart(); planSelect(); plan(); table(); totals(); incTotals(); patternNote();
  }
  function kpis() {
    const s = S(), K = $("est-kpis");
    if (!K.dataset.built) {
      K.dataset.built = "1";
      K.innerHTML = [0, 1, 2, 3].map(i => `<div class="card glass kpi pop" style="--i:${i}"><div class="label"></div><div class="value"></div><div class="note"></div></div>`).join("");
    }
    const vals = [
      ["Expenses per month", money(C.avgExp), `Average over the next ${C.N} months`],
      ["Left over per month", money(C.avgLeft), C.avgCj > 0 ? `From ${money(C.avgInc)} household income, after taxes and expenses` : `After ${r2(s.taxRate * 100)}% for taxes and your expenses`],
      [`Savings in ${C.N} month${C.N > 1 ? "s" : ""}`, money(C.end), `${C.end >= C.start ? "+" : "−"}${money(Math.abs(C.end - C.start))} from ${money(C.start)} today`],
      ["Slow-month cushion", money(C.maxReserve), C.maxReserve > 0 ? "Keep at least this in savings" : "Every month covers itself"],
    ];
    [...K.children].forEach((card, i) => {
      card.querySelector(".label").textContent = vals[i][0];
      card.querySelector(".value").textContent = vals[i][1];
      card.querySelector(".note").textContent = vals[i][2];
      card.querySelector(".value").classList.toggle("down", i === 1 && C.avgLeft < 0);
    });
    countUp(K);
  }
  function patternNote() {
    const s = S(), sh = C.sh, el = $("est-pattern-note");
    if (s.pattern !== "Seasonal") { el.textContent = "Every month gets the same income."; return; }
    if (!sh.tot || sh.months < 9) { el.textContent = `${s.basisYear} doesn't have enough months of income to show a pattern, so every month gets the same income for now.`; return; }
    const hi = sh.arr.indexOf(Math.max(...sh.arr)), lo = sh.arr.indexOf(Math.min(...sh.arr));
    el.innerHTML = `Shaped like ${s.basisYear}: busiest in ${MON[hi]} <b>${money(sh.f[hi] * s.monthlyIncome)}</b>, slowest in ${MON[lo]} <b>${money(sh.f[lo] * s.monthlyIncome)}</b>.`;
  }
  function totals() {
    const ex = E.st.expenses, bills = ex.filter(x => x.freq === "Monthly" && x.dueDay), flex = ex.filter(x => x.freq === "Weekly" || x.freq === "Every 2 weeks" || (x.freq === "Monthly" && !x.dueDay));
    $("est-totals").innerHTML = `<span class="chip">Each month <b>${money(sum(ex, perMonth))}</b></span>
      <span class="chip">Bills on a due date <b>${money(sum(bills, perMonth))}</b></span>
      <span class="chip">Spending budgets <b>${money(sum(flex, perMonth))}</b></span>` +
      (ex.some(x => x.freq === "Yearly") ? `<span class="chip">Yearly bills <b>${money(sum(ex.filter(x => x.freq === "Yearly"), x => +x.amount || 0))}</b>/yr</span>` : "") +
      (ex.some(x => x.freq === "One-time") ? `<span class="chip">One-time <b>${money(sum(ex.filter(x => x.freq === "One-time"), x => +x.amount || 0))}</b></span>` : "");
  }

  function chart() {
    if (!C) return;
    document.querySelectorAll("#est-chart-mode button").forEach(b => b.classList.toggle("on", b.dataset.m === E.chart));
    updateThumb($("est-chart-mode"));
    const svg = $("est-chart"), W = svg.clientWidth || 600, H = 250, pad = { l: 50, r: 14, t: 16, b: 26 }, M = C.months, N = M.length;
    svg.classList.toggle("noanim", !E.firstDraw); E.firstDraw = false;
    $("est-chart-title").textContent = E.chart === "savings" ? "Savings over time" : "Left over each month";
    $("est-legend").innerHTML = E.chart === "savings"
      ? `<span><span class="sw" style="background:var(--c1)"></span>Savings at the end of each month</span>`
      : `<span><span class="sw" style="background:var(--c3)"></span>Goes to savings</span><span><span class="sw" style="background:var(--critical)"></span>Comes out of savings</span>`;
    const vals = E.chart === "savings" ? [C.start].concat(M.map(d => d.end)) : M.map(d => d.left);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (hi - lo < 100) hi = lo + 100;
    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo)), base = y(0);
    const slots = E.chart === "savings" ? N + 1 : N, bw = (W - pad.l - pad.r) / slots, cx = i => pad.l + bw * i + bw / 2;
    const fk = v => (v < 0 ? "−" : "") + fmtK(Math.abs(v));
    let s = `<defs><linearGradient id="eA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c1)" stop-opacity=".42"/><stop offset="1" stop-color="var(--c1)" stop-opacity="0"/></linearGradient></defs>`;
    for (let v = lo; v <= hi + 1e-6; v += step) {
      s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--sep)" ${Math.abs(v) > 1e-6 ? 'stroke-dasharray="2 4"' : ""}/>`;
      s += `<text x="${pad.l - 10}" y="${y(v) + 4}" text-anchor="end">${fk(v)}</text>`;
    }
    const every = Math.ceil(slots / Math.max(4, Math.floor((W - pad.l) / 48)));
    const lbls = E.chart === "savings" ? [{ t: "Now" }].concat(M.map(d => ({ t: mLabel(d) }))) : M.map(d => ({ t: mLabel(d) }));
    lbls.forEach((l, i) => { if (i % every === 0) s += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle">${l.t}</text>`; });
    if (E.chart === "savings") {
      const pts = vals.map((v, i) => [cx(i), y(v)]);
      const line = smoothPath(pts, pad.t, H - pad.b);
      s += `<path d="${line} L${pts[pts.length - 1][0]},${base} L${pts[0][0]},${base} Z" fill="url(#eA)"/>`;
      s += `<path d="${line}" fill="none" stroke="var(--c1)" stroke-width="2.5" stroke-linecap="round" class="draw"/>`;
      const e = pts[pts.length - 1];
      s += `<circle cx="${e[0]}" cy="${e[1]}" r="4.5" fill="var(--c1)" stroke="var(--card-solid)" stroke-width="2"/>`;
      s += `<text x="${Math.min(e[0], W - pad.r)}" y="${e[1] - 12}" text-anchor="end" style="fill:var(--text);font-weight:600;font-size:12px">${money(vals[vals.length - 1])}</text>`;
    } else {
      const barW = Math.min(30, bw * 0.6);
      M.forEach((d, i) => {
        const top = Math.min(y(d.left), base), h = Math.abs(y(d.left) - base);
        s += `<g class="bar" style="--i:${i}"><rect x="${cx(i) - barW / 2}" y="${top}" width="${barW}" height="${Math.max(1, h)}" rx="${Math.min(6, barW / 3)}" fill="${d.left >= 0 ? "var(--c3)" : "var(--critical)"}"/></g>`;
      });
    }
    lbls.forEach((_, i) => s += `<rect class="hit" data-i="${i}" x="${pad.l + bw * i}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/>`);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = s;
    svg.querySelectorAll(".hit").forEach(r => {
      r.onpointermove = e => {
        const i = +r.dataset.i, sav = E.chart === "savings";
        if (sav && i === 0) { showTip(e, `<b>Today</b><div class="r"><span>Savings</span><span>${money(C.start)}</span></div>`); return; }
        const d = M[sav ? i - 1 : i];
        showTip(e, `<b>${mLabel(d, true)}</b>
          ${d.cj > 0 ? `<div class="r"><span>Your income</span><span>${money(d.you)}</span></div><div class="r"><span>CJ's income</span><span>${money(d.cj)}</span></div>` : `<div class="r"><span>Income</span><span>${money(d.inc)}</span></div>`}
          <div class="r"><span>Taxes set aside</span><span>−${money(d.tax)}</span></div>
          <div class="r"><span>Expenses</span><span>−${money(d.exp)}</span></div>
          <div class="r"><span>Left over</span><span class="${d.left < 0 ? "down" : "up"}">${money(d.left)}</span></div>
          <div class="r"><span>Savings after</span><span>${money(d.end)}</span></div>`);
      };
      r.onpointerleave = hideTip;
    });
  }

  function planSelect() {
    const sel = $("est-plan-month");
    if (!C.months.some(d => d.key === E.planKey)) E.planKey = C.months[0].key;
    const html = C.months.map(d => `<option value="${d.key}" ${d.key === E.planKey ? "selected" : ""}>${mLabel(d, true)}</option>`).join("");
    if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; }
  }
  function plan() {
    const d = C.months.find(x => x.key === E.planKey) || C.months[0], el = $("est-plan");
    const dated = d.items.filter(o => o.x.freq !== "Weekly" && o.x.freq !== "Every 2 weeks" && !(o.x.freq === "Monthly" && !o.x.dueDay))
      .map(o => ({ o, day: o.x.freq === "Monthly" ? o.x.dueDay : null })).sort((a, b) => (a.day || 0) - (b.day || 0));
    const flex = d.items.filter(o => !dated.some(z => z.o === o));
    const early = sum(dated.filter(z => !z.day || z.day <= 15), z => z.o.amt);
    const line = (l, v, cls) => `<div class="stat-line ${cls || ""}"><span>${l}</span><span class="num">${v}</span></div>`;
    el.innerHTML = `<div class="hero-line"><b>${money(d.exp)}</b>in checking by the 1st to cover ${MON[d.m]}</div>
      <div class="plan-cols">
        <div><div class="set-label">Due on a date</div>${dated.length ? dated.map(z => line(`${z.day ? `<span class="due">${ord(z.day)}</span>` : `<span class="due">${z.o.x.freq === "Yearly" ? "Yearly" : "Once"}</span>`}${esc(z.o.x.name)}`, money2(z.o.amt))).join("") : `<div class="muted">No dated bills this month.</div>`}</div>
        <div><div class="set-label">Spread through the month</div>${flex.length ? flex.map(o => line(esc(o.x.name), money2(o.amt))).join("") : `<div class="muted">None.</div>`}</div>
      </div>
      ${early ? `<div class="foot">${money(early)} of bills are due by the 15th, before most of the month's pay comes in.</div>` : ""}
      <div style="margin-top:14px">
        ${d.cj > 0 ? line("Your income in " + MON[d.m], money(d.you)) + d.jobs.map(o => line(`CJ · ${esc(o.x.name || "job")} <span class="muted">${o.x.type}${o.x.per === "Paycheck" ? " · paid " + paydays(o.x, d.y, d.m).map(t => new Date(t).getUTCDate()).map(ord).join(", ") : ""}</span>`, money(o.amt))).join("")
          : line("Income expected in " + MON[d.m], money(d.inc))}
        ${line("Set aside for taxes", "−" + money(d.tax))}
        ${line("Expenses", "−" + money(d.exp))}
        ${line(d.left >= 0 ? "Move to savings" : "Pull from savings", `<span class="${d.left >= 0 ? "up" : "down"}">${money(Math.abs(d.left))}</span>`, "total")}
      </div>
      ${d.reserve > 0 ? `<div class="foot">Keep at least <b>${money(d.reserve)}</b> in savings going into ${MON[d.m]} to cover the slower months after it.</div>` : ""}`;
  }
  function table() {
    $("est-rows").innerHTML = C.months.map(d => `<tr>
      <td class="c-main">${mLabel(d, true)}</td>
      <td class="num d-only">${money(d.you)}</td>
      <td class="num d-only ${d.cj ? "" : "muted"}">${d.cj ? money(d.cj) : "—"}</td>
      <td class="num c-sub"><span class="m-lbl">In </span>${money(d.inc)}</td>
      <td class="num d-only">${money(d.tax)}</td>
      <td class="num c-sub"><span class="m-lbl">Out </span>${money(d.exp)}</td>
      <td class="num c-sub ${d.left < 0 ? "down" : "up"}"><span class="m-lbl">Left </span>${d.left >= 0 ? "+" : "−"}${money(Math.abs(d.left))}</td>
      <td class="num d-only muted">${d.reserve > 0 ? money(d.reserve) : "—"}</td>
      <td class="num c-tot">${money(d.end)}</td></tr>`).join("");
  }

  // ---------- page switching ----------
  function showPage(p) {
    const est = p === "estimator";
    $("page-income").hidden = est; $("page-estimator").hidden = !est;
    $("years").hidden = est; document.querySelector(".add-wrap").hidden = est;
    document.querySelectorAll("h1.pages button").forEach(b => { b.classList.toggle("on", b.dataset.page === p); b.setAttribute("aria-selected", String(b.dataset.page === p)); });
    document.title = est ? "Estimator · Income at a Glance" : "Income at a Glance";
    const want = est ? "#estimator" : location.pathname + location.search;
    if ((location.hash === "#estimator") !== est) history.replaceState(null, "", want);
    if (est) { E.firstDraw = true; if (E.st) { quickIncome(); outputs(); } }
    else if (STATE.T) render();   // income charts were sized while hidden: redraw them at full width
    else updateThumb($("years"));
  }
  document.querySelectorAll("h1.pages button").forEach(b => b.onclick = () => { if (!b.classList.contains("on")) { showPage(b.dataset.page); scrollTo({ top: 0 }); } });
  addEventListener("hashchange", () => showPage(location.hash === "#estimator" ? "estimator" : "income"));

  // ---------- entry from the main script ----------
  window.Estimator = {
    data(T) {
      if (!E.built) { E.built = true; bindInputs(); }
      if (E.dirty || E.saving || T === E.lastT) return;   // don't overwrite edits in progress, or redo a redraw of the same data
      E.lastT = T;
      adopt(T);
      inputs(); list(); incList();
      setStatus(E.fromSeed ? "Starting from your sheet's budget · saves when you change something"
        : E.savedAt ? `Saved to your sheet · ${E.savedAt}` : "Saved to your sheet", E.fromSeed ? "" : "ok");
      if (!$("page-estimator").hidden) outputs();
    }
  };
  showPage(location.hash === "#estimator" ? "estimator" : "income");
  if (STATE.T) Estimator.data(STATE.T);
})();
