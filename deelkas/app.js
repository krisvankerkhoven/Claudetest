(function () {
'use strict';
const CFG = window.DEELKAS_CONFIG || {};
const REMOTE = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);

/* ---------- hulpfuncties ---------- */
const eur = c => (c / 100).toLocaleString('nl-BE', { style: 'currency', currency: 'EUR' });
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const parseAmt = s => { const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) && v > 0 ? Math.round(v * 100) : 0; };
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

/* ---------- opslag: Supabase (gedeeld) of lokaal (enkel deze browser) ---------- */
const remote = {
  async rpc(fn, args) {
    const r = await fetch(CFG.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseAnonKey, Authorization: 'Bearer ' + CFG.supabaseAnonKey },
      body: JSON.stringify(args)
    });
    if (!r.ok) { let m = 'Fout ' + r.status; try { m = (await r.json()).message || m; } catch (e) {} throw new Error(m); }
    const t = await r.text(); return t ? JSON.parse(t) : null;
  },
  createGroup: name => remote.rpc('create_group', { p_name: name }),
  getGroup: code => remote.rpc('get_group', { p_code: code }),
  renameGroup: (code, name) => remote.rpc('rename_group', { p_code: code, p_name: name }),
  addMember: (code, name) => remote.rpc('add_member', { p_code: code, p_name: name }),
  removeMember: (code, id) => remote.rpc('remove_member', { p_code: code, p_id: id }),
  addExpense: (code, e) => remote.rpc('add_expense', { p_code: code, p_desc: e.desc, p_amount: e.amount, p_paid_by: e.paidBy, p_shares: e.shares, p_date: e.date }),
  deleteExpense: (code, id) => remote.rpc('delete_expense', { p_code: code, p_id: id }),
  addSettlement: (code, s) => remote.rpc('add_settlement', { p_code: code, p_from: s.from, p_to: s.to, p_amount: s.amount, p_date: s.date }),
  deleteSettlement: (code, id) => remote.rpc('delete_settlement', { p_code: code, p_id: id })
};
const local = {
  _k: c => 'deelkas.local.' + c,
  _load(c) { const g = ls.get(local._k(c), null); if (!g) throw new Error('Onbekende groep'); return g; },
  _save(c, g) { ls.set(local._k(c), g); },
  async createGroup(name) { const c = uid().replace(/-/g, '').slice(0, 20); local._save(c, { name, members: [], expenses: [], settlements: [] }); return c; },
  async getGroup(c) { return ls.get(local._k(c), null); },
  async renameGroup(c, n) { const g = local._load(c); g.name = n; local._save(c, g); },
  async addMember(c, n) { const g = local._load(c); g.members.push({ id: uid(), name: n }); local._save(c, g); },
  async removeMember(c, id) {
    const g = local._load(c);
    if (g.expenses.some(e => e.paidBy === id || id in e.shares) || g.settlements.some(s => s.from === id || s.to === id)) throw new Error('Dit lid heeft al uitgaven');
    g.members = g.members.filter(m => m.id !== id); local._save(c, g);
  },
  async addExpense(c, e) { const g = local._load(c); g.expenses.push({ id: uid(), createdAt: Date.now(), ...e }); local._save(c, g); },
  async deleteExpense(c, id) { const g = local._load(c); g.expenses = g.expenses.filter(e => e.id !== id); local._save(c, g); },
  async addSettlement(c, s) { const g = local._load(c); g.settlements.push({ id: uid(), createdAt: Date.now(), ...s }); local._save(c, g); },
  async deleteSettlement(c, id) { const g = local._load(c); g.settlements = g.settlements.filter(s => s.id !== id); local._save(c, g); }
};
const api = REMOTE ? remote : local;

/* ---------- berekeningen ---------- */
function balances(g) {
  const b = {}; g.members.forEach(m => b[m.id] = 0);
  const add = (id, c) => { b[id] = (b[id] || 0) + c; };
  g.expenses.forEach(e => { add(e.paidBy, e.amount); for (const [k, v] of Object.entries(e.shares || {})) add(k, -v); });
  g.settlements.forEach(s => { add(s.from, s.amount); add(s.to, -s.amount); });
  return b;
}
function suggest(b) {
  const cr = [], de = [];
  for (const [id, v] of Object.entries(b)) { if (v > 0) cr.push({ id, v }); else if (v < 0) de.push({ id, v: -v }); }
  cr.sort((a, c) => c.v - a.v); de.sort((a, c) => c.v - a.v);
  const out = []; let i = 0, j = 0;
  while (i < de.length && j < cr.length) {
    const x = Math.min(de[i].v, cr[j].v);
    if (x > 0) out.push({ from: de[i].id, to: cr[j].id, amount: x });
    de[i].v -= x; cr[j].v -= x;
    if (de[i].v === 0) i++; if (cr[j].v === 0) j++;
  }
  return out;
}
function equalShares(total, ids) {
  const n = ids.length, base = Math.floor(total / n); let r = total - base * n; const s = {};
  ids.forEach(id => { s[id] = base + (r > 0 ? 1 : 0); if (r > 0) r--; });
  return s;
}

/* ---------- routing ---------- */
const root = document.getElementById('app');
let timer = null;
function route() {
  clearInterval(timer);
  const m = location.hash.match(/^#g=([A-Za-z0-9]+)$/);
  if (m) showGroup(m[1]); else showHome();
}
window.addEventListener('hashchange', route);

/* ---------- startscherm ---------- */
function showHome() {
  document.title = 'Deelkas';
  const recent = ls.get('deelkas.recent', []);
  const err = h('div', { class: 'err', role: 'alert' });
  const nameIn = h('input', { id: 'gn', placeholder: 'Bv. Weekend Ardennen', maxlength: '60', autocomplete: 'off' });
  const codeIn = h('input', { id: 'gc', placeholder: 'Code of link van een vriend', autocomplete: 'off' });
  root.replaceChildren(h('div', { class: 'home' },
    h('div', null, h('h1', null, 'Deelkas'), h('p', null, 'Houd gedeelde kosten bij met vrienden. Geen account nodig.')),
    !REMOTE ? h('div', { class: 'note' }, 'Testmodus: de gegevens blijven enkel in deze browser. Vul config.js in om te delen met vrienden.') : null,
    h('form', { class: 'card stack', onsubmit: async e => {
      e.preventDefault(); const n = nameIn.value.trim(); if (!n) { err.textContent = 'Geef de groep een naam.'; return; }
      try { const c = await api.createGroup(n); remember(c, n); location.hash = '#g=' + c; } catch (x) { err.textContent = 'Aanmaken lukte niet: ' + x.message; }
    } }, h('h2', null, 'Nieuwe groep'), h('div', null, h('label', { for: 'gn' }, 'Naam'), nameIn), h('button', { class: 'primary' }, 'Groep maken')),
    h('form', { class: 'card stack', onsubmit: e => {
      e.preventDefault(); const raw = codeIn.value.trim(); const m = raw.match(/g=([A-Za-z0-9]+)/) || raw.match(/^([A-Za-z0-9]+)$/);
      if (!m) { err.textContent = 'Die code herken ik niet.'; return; } location.hash = '#g=' + m[1];
    } }, h('h2', null, 'Bestaande groep openen'), h('div', null, h('label', { for: 'gc' }, 'Code of link'), codeIn), h('button', null, 'Openen')),
    err,
    recent.length ? h('div', { class: 'card recent' }, h('h2', null, 'Jouw groepen'), ...recent.map(r => h('a', { href: '#g=' + r.code }, h('span', null, r.name), h('span', { class: 'hint' }, 'openen')))) : null
  ));
}
function remember(code, name) {
  const r = ls.get('deelkas.recent', []).filter(x => x.code !== code);
  r.unshift({ code, name }); ls.set('deelkas.recent', r.slice(0, 20));
}

/* ---------- groepsscherm ---------- */
async function showGroup(code) {
  let G = null, me = ls.get('deelkas.me.' + code, '');
  const form = { desc: '', amount: '', paidBy: '', mode: 'equal', date: today(), part: {}, exact: {}, err: '' };
  const armed = {};
  const name = id => { const m = G.members.find(x => x.id === id); return m ? m.name : 'Onbekend'; };

  root.replaceChildren(h('div', { class: 'home' }, h('p', null, 'Laden…')));
  const first = await api.getGroup(code).catch(e => ({ __err: e.message }));
  if (!first || first.__err) {
    root.replaceChildren(h('div', { class: 'home' }, h('h1', null, 'Deelkas'),
      h('div', { class: 'note' }, first ? 'Laden mislukt: ' + first.__err : 'Deze groep bestaat niet (meer). Controleer de code.'),
      h('a', { href: '#' }, 'Terug')));
    return;
  }
  G = first; remember(code, G.name); document.title = G.name + ' · Deelkas';

  root.replaceChildren(
    h('div', { class: 'topbar' }, h('a', { href: '#' }, '← Alle groepen')),
    h('header', null,
      h('div', { class: 'title' }, h('label', { for: 'gname', style: 'margin:0' }, 'Groep'),
        h('input', { id: 'gname', value: G.name, maxlength: '60', 'aria-label': 'Naam van de groep' })),
      h('div', { class: 'share' },
        h('div', { class: 'me' }, h('label', { for: 'me', style: 'margin:0' }, 'Ik ben'), h('select', { id: 'me', style: 'width:auto' })),
        h('button', { id: 'copy', type: 'button' }, 'Kopieer link'))),
    h('div', { id: 'status', class: 'note', hidden: true }),
    h('div', { class: 'grid', style: 'margin-top:16px' },
      h('div', { class: 'col' },
        h('section', { class: 'card' }, h('h2', null, 'Vrienden'), h('div', { id: 'members', class: 'chips' }),
          h('form', { id: 'addm', class: 'add' }, h('input', { id: 'newm', placeholder: 'Naam toevoegen', maxlength: '30', 'aria-label': 'Naam', autocomplete: 'off' }), h('button', { class: 'primary' }, 'Toevoegen'))),
        h('section', { class: 'card' }, h('h2', null, 'Nieuwe uitgave'), h('form', { id: 'exp', class: 'stack', novalidate: true }))),
      h('div', { class: 'col' },
        h('section', { class: 'card' }, h('h2', null, 'Saldo'), h('div', { id: 'headline' }), h('div', { id: 'bal', class: 'bal' })),
        h('section', { class: 'card' }, h('h2', null, 'Afrekenen'), h('div', { id: 'pay' })),
        h('section', { class: 'card' }, h('h2', null, 'Activiteit'), h('div', { id: 'feed', class: 'feed' })))));

  const $ = s => root.querySelector(s);
  const say = m => { const s = $('#status'); s.hidden = !m; s.textContent = m || ''; };
  const run = async fn => { try { await fn(); say(''); await refresh(true); } catch (e) { say('Opslaan lukte niet: ' + e.message); } };

  function renderMembers() {
    const box = $('#members'); box.replaceChildren();
    if (!G.members.length) box.append(h('div', { class: 'empty' }, 'Voeg eerst de vrienden toe die mee delen.'));
    G.members.forEach(m => {
      const used = G.expenses.some(e => e.paidBy === m.id || (e.shares && m.id in e.shares)) || G.settlements.some(s => s.from === m.id || s.to === m.id);
      box.append(h('span', { class: 'chip' }, m.name, h('button', { class: 'ghost', type: 'button', disabled: used, title: used ? 'Heeft al uitgaven en kan niet verwijderd worden' : 'Verwijderen', 'aria-label': 'Verwijder ' + m.name, onclick: () => run(() => api.removeMember(code, m.id)) }, '×')));
    });
    const sel = $('#me'); sel.replaceChildren(h('option', { value: '' }, 'kies je naam'), ...G.members.map(m => h('option', { value: m.id }, m.name)));
    if (!G.members.some(m => m.id === me)) me = '';
    sel.value = me;
  }

  function renderForm() {
    const f = $('#exp'); f.replaceChildren();
    const ms = G.members;
    if (ms.length < 2) { f.append(h('div', { class: 'empty' }, 'Voeg minstens twee vrienden toe om een uitgave te noteren.')); return; }
    ms.forEach(m => { if (!(m.id in form.part)) form.part[m.id] = true; });
    if (!ms.some(m => m.id === form.paidBy)) form.paidBy = ms.some(m => m.id === me) ? me : ms[0].id;
    const info = h('div', { class: 'hint' });
    const upd = () => {
      if (form.mode !== 'exact') { info.textContent = ''; return; }
      const tot = parseAmt(form.amount), sum = ms.reduce((a, m) => a + (form.part[m.id] ? parseAmt(form.exact[m.id] || '') : 0), 0), rest = tot - sum;
      info.className = 'hint' + (rest !== 0 ? ' bad' : '');
      info.textContent = rest === 0 ? 'Alles verdeeld' : (rest > 0 ? 'Nog te verdelen: ' : 'Te veel verdeeld: ') + eur(Math.abs(rest));
    };
    const hints = [];
    const updEqual = () => {
      const ids = ms.filter(x => form.part[x.id]).map(x => x.id), tot = parseAmt(form.amount), sh = ids.length && tot ? equalShares(tot, ids) : {};
      hints.forEach(([id, el]) => { el.textContent = sh[id] != null ? eur(sh[id]) : ''; });
    };
    f.append(
      h('div', null, h('label', { for: 'f-desc' }, 'Waarvoor'), h('input', { id: 'f-desc', value: form.desc, maxlength: '80', placeholder: 'Bv. Boodschappen weekend', autocomplete: 'off', oninput: e => form.desc = e.target.value })),
      h('div', { class: 'row' },
        h('div', null, h('label', { for: 'f-amt' }, 'Bedrag (€)'), h('input', { id: 'f-amt', value: form.amount, inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off', oninput: e => { form.amount = e.target.value; upd(); updEqual(); } })),
        h('div', null, h('label', { for: 'f-date' }, 'Datum'), h('input', { id: 'f-date', type: 'date', value: form.date, onchange: e => form.date = e.target.value }))),
      h('div', null, h('label', { for: 'f-paid' }, 'Betaald door'), h('select', { id: 'f-paid', onchange: e => form.paidBy = e.target.value }, ...ms.map(m => h('option', { value: m.id, selected: m.id === form.paidBy }, m.name)))),
      h('div', null, h('label', null, 'Verdeling'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Verdeling' },
        h('button', { type: 'button', 'aria-pressed': String(form.mode === 'equal'), onclick: () => { form.mode = 'equal'; renderForm(); } }, 'Gelijk'),
        h('button', { type: 'button', 'aria-pressed': String(form.mode === 'exact'), onclick: () => { form.mode = 'exact'; renderForm(); } }, 'Per bedrag'))),
      h('div', { class: 'who' }, ...ms.map(m => {
        const tail = form.mode === 'exact'
          ? h('input', { class: 'amt', value: form.exact[m.id] || '', inputmode: 'decimal', placeholder: '0,00', disabled: !form.part[m.id], 'aria-label': 'Bedrag voor ' + m.name, oninput: e => { form.exact[m.id] = e.target.value; upd(); } })
          : h('span', { class: 'hint', style: 'text-align:right' });
        if (form.mode !== 'exact') hints.push([m.id, tail]);
        return h('label', { class: 'line', style: 'text-transform:none;letter-spacing:0;font-size:15px;font-weight:400;color:var(--fg);margin:0' },
          h('input', { type: 'checkbox', checked: !!form.part[m.id], onchange: e => { form.part[m.id] = e.target.checked; renderForm(); } }),
          h('span', { class: 'n' }, m.name), tail);
      })),
      info,
      h('div', { class: 'err', id: 'f-err', role: 'alert' }, form.err),
      h('button', { class: 'primary', type: 'submit' }, 'Uitgave opslaan'));
    upd(); updEqual();
  }

  $('#exp').addEventListener('submit', async ev => {
    ev.preventDefault();
    const fail = m => { form.err = m; const e = $('#f-err'); if (e) e.textContent = m; };
    const total = parseAmt(form.amount);
    if (!form.desc.trim()) return fail('Vul in waarvoor het was.');
    if (!total) return fail('Vul een bedrag in, bv. 24,50.');
    const ids = G.members.filter(m => form.part[m.id]).map(m => m.id);
    if (!ids.length) return fail('Kies minstens één persoon die meedeelt.');
    let shares;
    if (form.mode === 'equal') shares = equalShares(total, ids);
    else {
      shares = {}; let sum = 0;
      ids.forEach(id => { const c = parseAmt(form.exact[id] || ''); if (c) { shares[id] = c; sum += c; } });
      if (sum !== total) return fail('De bedragen tellen op tot ' + eur(sum) + ', niet tot ' + eur(total) + '.');
    }
    try {
      await api.addExpense(code, { desc: form.desc.trim(), amount: total, paidBy: form.paidBy, shares, date: form.date || today() });
      form.desc = ''; form.amount = ''; form.exact = {}; form.err = '';
      await refresh(true); renderForm();
    } catch (e) { fail('Opslaan lukte niet: ' + e.message); }
  });

  function renderBalances() {
    const b = balances(G), bal = $('#bal'), hl = $('#headline'); bal.replaceChildren(); hl.replaceChildren();
    if (!G.members.length) { bal.append(h('div', { class: 'empty' }, 'Nog niemand toegevoegd.')); return; }
    const max = Math.max(1, ...Object.values(b).map(Math.abs));
    if (me && b[me] != null) { const v = b[me]; hl.append(h('p', { class: 'headline' }, v > 0 ? 'Je krijgt nog ' + eur(v) + ' terug.' : v < 0 ? 'Je moet nog ' + eur(-v) + ' betalen.' : 'Jij staat quitte.')); }
    G.members.forEach(m => {
      const v = b[m.id] || 0, w = Math.min(50, Math.abs(v) / max * 50);
      bal.append(h('div', { class: 'r' },
        h('span', { class: 'nm' + (m.id === me ? ' me' : '') }, m.name + (m.id === me ? ' (jij)' : '')),
        h('div', { class: 'bar' }, v ? h('i', { class: v > 0 ? 'p' : 'n', style: 'width:' + w + '%' }) : null),
        h('span', { class: 'num ' + (v > 0 ? 'p' : v < 0 ? 'n' : '') }, (v > 0 ? '+' : v < 0 ? '−' : '') + eur(Math.abs(v)))));
    });
  }
  function renderPay() {
    const box = $('#pay'); box.replaceChildren();
    const list = suggest(balances(G));
    if (!list.length) { box.append(h('div', { class: 'empty' }, G.expenses.length || G.settlements.length ? 'Alles is vereffend.' : 'Zodra er uitgaven zijn, zie je hier wie wie moet betalen.')); return; }
    list.forEach(p => box.append(h('div', { class: 'pay' },
      h('span', null, h('strong', null, name(p.from)), ' betaalt ', h('strong', null, name(p.to)), ' ', h('span', { class: 'num' }, eur(p.amount))),
      h('button', { onclick: () => run(() => api.addSettlement(code, { from: p.from, to: p.to, amount: p.amount, date: today() })) }, 'Markeer als betaald'))));
  }
  function delBtn(key, fn) {
    const b = h('button', { class: 'ghost', 'aria-label': 'Verwijderen', onclick: () => {
      if (armed[key]) { delete armed[key]; run(fn); }
      else { armed[key] = 1; b.textContent = 'Zeker?'; b.style.color = 'var(--neg)'; setTimeout(() => { delete armed[key]; b.textContent = 'Verwijder'; b.style.color = ''; }, 3000); }
    } }, 'Verwijder');
    return b;
  }
  function renderFeed() {
    const box = $('#feed'); box.replaceChildren();
    const items = [...G.expenses.map(e => ({ k: 'e', ...e })), ...G.settlements.map(s => ({ k: 's', ...s }))]
      .sort((a, c) => (c.date || '').localeCompare(a.date || '') || (c.createdAt || 0) - (a.createdAt || 0));
    if (!items.length) { box.append(h('div', { class: 'empty' }, 'Nog geen uitgaven. Noteer de eerste links.')); return; }
    let day = '';
    items.forEach(it => {
      if (it.date !== day) { day = it.date; const d = new Date(it.date + 'T12:00:00'); box.append(h('div', { class: 'day' }, isNaN(d) ? it.date : d.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long' }))); }
      if (it.k === 'e') {
        const n = Object.keys(it.shares || {}).length;
        box.append(h('div', { class: 'it' },
          h('div', null, h('div', { class: 't' }, it.desc), h('div', { class: 's' }, name(it.paidBy) + ' betaalde, gedeeld met ' + n + (n === 1 ? ' persoon' : ' personen'))),
          h('span', { class: 'num' }, eur(it.amount)), delBtn('e' + it.id, () => api.deleteExpense(code, it.id))));
      } else {
        box.append(h('div', { class: 'it' },
          h('div', null, h('div', { class: 't' }, name(it.from) + ' → ' + name(it.to)), h('div', { class: 's' }, 'Terugbetaling')),
          h('span', { class: 'num p' }, eur(it.amount)), delBtn('s' + it.id, () => api.deleteSettlement(code, it.id))));
      }
    });
  }

  let sig = '';
  function renderAll(forceForm) {
    const s = G.members.map(m => m.id + m.name).join('|');
    if (s !== sig || forceForm) { sig = s; renderMembers(); renderForm(); }
    renderBalances(); renderPay(); renderFeed();
  }
  async function refresh(quiet) {
    try {
      const g = await api.getGroup(code);
      if (!g) { say('Deze groep bestaat niet meer.'); return; }
      const changed = JSON.stringify(g) !== JSON.stringify(G);
      G = g; if (changed) { renderAll(); const gn = $('#gname'); if (document.activeElement !== gn) gn.value = G.name; }
      if (!quiet) say('');
    } catch (e) { say('Verbinding verloren, ik probeer het zo opnieuw.'); }
  }

  $('#addm').addEventListener('submit', e => {
    e.preventDefault(); const inp = $('#newm'), n = inp.value.trim(); if (!n) return;
    inp.value = ''; if (G.members.some(m => m.name.toLowerCase() === n.toLowerCase())) return;
    run(() => api.addMember(code, n));
  });
  $('#me').addEventListener('change', e => { me = e.target.value; ls.set('deelkas.me.' + code, me); renderBalances(); renderForm(); });
  let gt; $('#gname').addEventListener('input', e => { clearTimeout(gt); const v = e.target.value.trim(); gt = setTimeout(() => { if (v) { api.renameGroup(code, v).then(() => remember(code, v)).catch(() => say('Naam wijzigen lukte niet.')); } }, 700); });
  $('#copy').addEventListener('click', async e => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Gekopieerd'; setTimeout(() => e.target.textContent = 'Kopieer link', 1500); }
    catch (x) { e.target.textContent = 'Kopieer uit de adresbalk'; }
  });

  sig = ''; renderAll(true);
  timer = setInterval(() => { if (!document.hidden) refresh(); }, 6000);
}

route();
})();
