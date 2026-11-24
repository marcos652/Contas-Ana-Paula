import { createClient } from '@supabase/supabase-js';
import { supabaseConfig } from './supabase-config.js';

/* ============ utilidades ============ */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num2 = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthOf = (d) => d.slice(0, 7);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const monthLabel = (m) => { const [y, mm] = m.split('-').map(Number); return cap(new Date(y, mm - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })); };
const shortMonth = (m) => { const [y, mm] = m.split('-'); return `${mm}/${y}`; };
const addMonths = (m, n) => { const [y, mm] = m.split('-').map(Number); const d = new Date(y, mm - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const fmtDate = (s) => (s ? s.split('-').reverse().join('/') : '');

function parseMoney(str) {
  if (str == null) return null;
  let s = String(str).replace(/R\$|\s/g, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/* ============ modelo ============ */
const TIPOS = {
  receber: { titulo: 'A receber', feito: 'Recebido', totalLabel: 'Total a receber', feitoLabel: 'Recebido', pendLabel: 'Pendente a receber' },
  pagar: { titulo: 'A pagar', feito: 'Pago', totalLabel: 'Total a pagar', feitoLabel: 'Pago', pendLabel: 'Pendente a pagar' },
};
const TIPO_COL = { texto: 'Texto', numero: 'Número', moeda: 'Valor em R$', data: 'Data', status: 'Status' };
const CATS_PADRAO = {
  receber: ['Salário', 'Extra', 'Reembolso', 'Empréstimo'],
  pagar: ['Moradia', 'Mercado', 'Contas da casa', 'Transporte', 'Saúde', 'Lazer', 'Cartão'],
};

const defaultSchema = () => ({
  receber: [
    { id: 'data', nome: 'Data prevista', tipo: 'data', fixo: true },
    { id: 'desc', nome: 'Descrição', tipo: 'texto' },
    { id: 'cat', nome: 'Categoria', tipo: 'texto' },
    { id: 'valor', nome: 'Valor', tipo: 'moeda', fixo: true },
    { id: 'status', nome: 'Status', tipo: 'status', fixo: true },
    { id: 'datapag', nome: 'Data de recebimento', tipo: 'data' },
  ],
  pagar: [
    { id: 'data', nome: 'Vencimento', tipo: 'data', fixo: true },
    { id: 'desc', nome: 'Descrição', tipo: 'texto' },
    { id: 'cat', nome: 'Categoria', tipo: 'texto' },
    { id: 'valor', nome: 'Valor', tipo: 'moeda', fixo: true },
    { id: 'status', nome: 'Status', tipo: 'status', fixo: true },
    { id: 'datapag', nome: 'Data do pagamento', tipo: 'data' },
    { id: 'forma', nome: 'Forma de pagamento', tipo: 'texto' },
    { id: 'obs', nome: 'Observações', tipo: 'texto' },
  ],
});

const now = new Date();
const state = {
  mode: null, // 'local' | 'cloud'
  uid: null,
  email: '',
  month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
  tab: 'resumo',
  schema: defaultSchema(),
  rows: [], // { id, tipo, mes, v:{}, ordem }
  editing: null, // { tipo, colId|null }
  focusRow: null,
  editLayout: false,
  prefs: null,
  mei: null,
};

const monthRows = (tipo, m = state.month) =>
  state.rows.filter((r) => r.tipo === tipo && r.mes === m).sort((a, b) => (a.v.data || '9999').localeCompare(b.v.data || '9999') || (a.ordem || 0) - (b.ordem || 0));

function sums(tipo, m) {
  let total = 0, feito = 0;
  for (const r of state.rows) {
    if (r.tipo !== tipo || r.mes !== m) continue;
    const v = Number(r.v.valor) || 0;
    total += v;
    if (r.v.status === 'feito') feito += v;
  }
  return { total, feito, pend: total - feito };
}

/* ============ armazenamento ============ */
const LS = 'cf:v1';
let cloud = null; // { sb, user }

const local = {
  load() {
    try {
      const d = JSON.parse(localStorage.getItem(LS) || 'null');
      if (d) { state.schema = d.schema || defaultSchema(); state.rows = d.rows || []; }
    } catch { /* dados corrompidos: começa vazio */ }
  },
  save() { localStorage.setItem(LS, JSON.stringify({ schema: state.schema, rows: state.rows })); },
};

const dbErr = ({ error }) => { if (error) onCloudError(error); };
function persistRow(row) {
  if (state.mode === 'local') return local.save();
  cloud.sb.from('lancamentos').upsert({ id: row.id, user_id: state.uid, tipo: row.tipo, mes: row.mes, v: row.v, ordem: row.ordem || 0 }).then(dbErr);
}
function removeRowStore(id) {
  if (state.mode === 'local') return local.save();
  cloud.sb.from('lancamentos').delete().eq('id', id).then(dbErr);
}
function saveConfig(chave, valor) {
  cloud.sb.from('config').upsert({ user_id: state.uid, chave, valor }, { onConflict: 'user_id,chave' }).then(dbErr);
}
function persistSchema() {
  if (state.mode === 'local') return local.save();
  saveConfig('colunas', state.schema);
}
function onCloudError(e) {
  console.error(e);
  toast('Não foi possível salvar na nuvem. Verifique a conexão.');
}

/* ============ Supabase (login e dados) ============ */
function authMsg(e) {
  const c = e && (e.code || '');
  const m = {
    invalid_credentials: 'E-mail ou senha incorretos.',
    email_not_confirmed: 'Confirme o e-mail antes de entrar. Procure a mensagem na caixa de entrada.',
    user_already_exists: 'Já existe uma conta com esse e-mail. Tente entrar.',
    weak_password: 'A senha precisa de pelo menos 6 caracteres.',
    validation_failed: 'E-mail inválido.',
    over_email_send_rate_limit: 'Muitos e-mails enviados. Aguarde um pouco e tente de novo.',
    over_request_rate_limit: 'Muitas tentativas. Aguarde um pouco e tente de novo.',
  };
  if (m[c]) return m[c];
  if (/invalid login/i.test(e && e.message)) return m.invalid_credentials;
  if (/fetch|network/i.test(e && e.message)) return 'Sem conexão com a internet.';
  return 'Não foi possível entrar. Tente de novo.';
}

async function enterCloud(user) {
  state.mode = 'cloud'; state.uid = user.id; state.email = user.email || '';
  state.rows = []; state.schema = defaultSchema(); state.mei = MEI_PADRAO();
  cloud.user = user;
  $('#login').hidden = true;
  try {
    const [l, c] = await Promise.all([
      cloud.sb.from('lancamentos').select('id,tipo,mes,v,ordem'),
      cloud.sb.from('config').select('chave,valor'),
    ]);
    if (l.error || c.error) throw (l.error || c.error);
    state.rows = l.data || [];
    const cfg = Object.fromEntries((c.data || []).map((x) => [x.chave, x.valor]));
    if (cfg.colunas) state.schema = cfg.colunas; else saveConfig('colunas', state.schema);
    if (cfg.preferencias) { state.prefs = normalizePrefs(cfg.preferencias); localStorage.setItem(PREFS_LS, JSON.stringify(state.prefs)); applyTheme(); }
    if (cfg.mei) { state.mei = normalizeMei(cfg.mei); localStorage.setItem(MEI_LS, JSON.stringify(state.mei)); }
  } catch (e) { onCloudError(e); }
  showApp();
  offerImport();
}

function offerImport() {
  try {
    const d = JSON.parse(localStorage.getItem(LS) || 'null');
    const key = 'cf:importado:' + state.uid;
    if (state.rows.length === 0 && d && d.rows && d.rows.length && !localStorage.getItem(key)) {
      localStorage.setItem(key, '1');
      if (confirm(`Encontramos ${d.rows.length} lançamentos salvos neste aparelho. Enviar para a sua conta?`)) {
        if (d.schema) { state.schema = d.schema; persistSchema(); }
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        state.rows = d.rows.map((r) => (uuid.test(r.id) ? r : { ...r, id: newId() }));
        state.rows.forEach(persistRow); render();
        toast('Lançamentos enviados para a sua conta.');
      }
    }
  } catch { /* ignora */ }
}

function cleanupCloud() { /* nada a desligar: os dados são buscados no login */ }

/* ============ preferências (tema e layout) ============ */
const PREFS_LS = 'cf:prefs';
const PREFS_PADRAO = () => ({ tema: { modo: 'claro', cor: '#2563eb', densidade: 'normal', cantos: 'suave' }, layout: { ordem: null, ocultos: [] } });
const CORES = [['Azul', '#2563eb'], ['Turquesa', '#0891b2'], ['Verde', '#16a34a'], ['Laranja', '#ea580c'], ['Rosa', '#db2777'], ['Grafite', '#334155']];
function normalizePrefs(p) {
  const d = PREFS_PADRAO();
  return { tema: { ...d.tema, ...(p && p.tema) }, layout: { ordem: (p && p.layout && p.layout.ordem) || null, ocultos: (p && p.layout && p.layout.ocultos) || [] } };
}
function loadPrefsLocal() {
  try { state.prefs = normalizePrefs(JSON.parse(localStorage.getItem(PREFS_LS) || 'null')); } catch { state.prefs = PREFS_PADRAO(); }
}
function savePrefs() {
  localStorage.setItem(PREFS_LS, JSON.stringify(state.prefs));
  if (state.mode === 'cloud' && cloud) saveConfig('preferencias', state.prefs);
}
function onColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111827' : '#ffffff';
}
function applyTheme() {
  const t = state.prefs.tema, root = document.documentElement;
  const dark = t.modo === 'escuro' || (t.modo === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = t.densidade; root.dataset.radius = t.cantos;
  root.style.setProperty('--accent', t.cor); root.style.setProperty('--on-accent', onColor(t.cor));
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#161a21' : '#ffffff');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.prefs.tema.modo === 'auto') applyTheme(); });

/* ============ MEI: dados, clientes, nota ============ */
const MEI_LS = 'cf:mei';
const LIMITE_MEI = 81000;
const MEI_PADRAO = () => ({ prestador: { nome: '', cnpj: '', municipio: 'Marília/SP', cnae: '', codServico: '', descricao: 'Serviço de cuidados e acompanhamento de pessoa' }, clientes: [] });
function normalizeMei(m) { const d = MEI_PADRAO(); return { prestador: { ...d.prestador, ...(m && m.prestador) }, clientes: (m && m.clientes) || [] }; }
function loadMeiLocal() { try { state.mei = normalizeMei(JSON.parse(localStorage.getItem(MEI_LS) || 'null')); } catch { state.mei = MEI_PADRAO(); } }
function saveMei() {
  localStorage.setItem(MEI_LS, JSON.stringify(state.mei));
  if (state.mode === 'cloud' && cloud) saveConfig('mei', state.mei);
}

/* ============ telas de entrada ============ */
function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false;
}
function enterLocal() {
  cleanupCloud();
  state.mode = 'local'; state.uid = null; state.email = '';
  state.rows = []; state.schema = defaultSchema();
  local.load(); loadMeiLocal();
  showApp();
}
function showApp() {
  $('#login').hidden = true; $('#app').hidden = false;
  const who = $('#who-label'), btn = $('#btn-sessao'), banner = $('#banner'), st = $('#status-label');
  btn.hidden = false;
  if (state.mode === 'cloud') {
    who.textContent = state.email; btn.textContent = 'Sair'; banner.hidden = true; st.textContent = 'Dados salvos na nuvem';
  } else if (supabaseConfig) {
    who.textContent = ''; btn.textContent = 'Entrar'; st.textContent = 'Salvo neste aparelho';
    banner.hidden = false; banner.textContent = 'Sem conta: seus dados ficam salvos só neste aparelho. Entre para guardar na nuvem.';
  } else {
    who.textContent = ''; btn.hidden = true; st.textContent = 'Salvo neste navegador';
    banner.hidden = false; banner.textContent = 'Os dados estão salvos só neste navegador. Para salvar na nuvem, ligue o Supabase (veja o README).';
  }
  render();
}

/* ============ renderização ============ */
const view = $('#view');
const ICON = (n, c = '') => `<svg class="i ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const TAB_NOME = { resumo: 'Início', receber: 'A receber', pagar: 'A pagar', clientes: 'Clientes e notas' };

function render() {
  if ($('#app').hidden) return;
  $('#mes-label').textContent = monthLabel(state.month);
  $('#mes-input').value = state.month;
  $('#mes-sub').textContent = `Hoje, ${fmtDate(todayStr())}`;
  $('#crumb-label').textContent = TAB_NOME[state.tab];
  document.querySelectorAll('.tabs [role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));
  const sl = view.querySelector('.tablewrap')?.scrollLeft || 0;
  view.innerHTML = state.tab === 'resumo' ? renderResumo() : state.tab === 'clientes' ? renderClientes() : renderSecao(state.tab);
  const tw = view.querySelector('.tablewrap'); if (tw) tw.scrollLeft = sl;
  if (state.focusRow) {
    const el = view.querySelector(`[data-row="${state.focusRow}"][data-col="desc"]`) || view.querySelector(`[data-row="${state.focusRow}"]`);
    el?.focus(); state.focusRow = null;
  }
}

function calc() {
  const m = state.month, r = sums('receber', m), p = sums('pagar', m), hoje = todayStr();
  const venc = state.rows.filter((x) => x.tipo === 'pagar' && x.v.status !== 'feito' && x.v.data && x.v.data < hoje);
  return { r, p, hoje, saldoReal: r.feito - p.feito, saldoPrev: r.total - p.total, venc, somaVenc: venc.reduce((a, x) => a + (Number(x.v.valor) || 0), 0) };
}

const kpi = (icon, label, value, hint, o = {}) =>
  `<div class="kpi"><div class="k-label">${ICON(icon, 'kicon')}<span>${label}</span></div><div class="k-value ${o.neg && value < 0 ? 'neg' : ''}">${brl(value)}</div>${hint ? `<div class="k-hint">${hint}</div>` : ''}</div>`;

const panel = (icon, title, badge, body, foot, flush = false) =>
  `<div class="panel"><div class="p-head"><h3>${ICON(icon, 'kicon')}${title}</h3>${badge ? `<span class="badge ${badge.cls || ''}">${badge.n}</span>` : ''}</div><div class="p-body ${flush ? 'flush' : ''}">${body}</div>${foot ? `<div class="p-foot">${foot}</div>` : ''}</div>`;

function fluxoHTML() {
  const [y, mm] = state.month.split('-').map(Number), n = new Date(y, mm, 0).getDate();
  const ent = Array(n).fill(0), sai = Array(n).fill(0);
  for (const x of state.rows) {
    if (x.mes !== state.month || !x.v.data) continue;
    const d = Number(x.v.data.slice(8, 10)) - 1; if (d < 0 || d >= n) continue;
    (x.tipo === 'receber' ? ent : sai)[d] += Number(x.v.valor) || 0;
  }
  const max = Math.max(...ent, ...sai, 0);
  const lines = [1, 2 / 3, 1 / 3, 0].map((f) => `<div class="fl-line" style="top:${(1 - f) * 100}%"><span>${brl(max * f).replace(/\s/g, '').replace(',00', '')}</span></div>`).join('');
  const cols = ent.map((_, i) => `<div class="fl-col" title="Dia ${i + 1}: entradas ${brl(ent[i])}, saídas ${brl(sai[i])}"><span class="fl-bar in" style="height:${max ? (ent[i] / max) * 100 : 0}%"></span><span class="fl-bar out" style="height:${max ? (sai[i] / max) * 100 : 0}%"></span></div>`).join('');
  const xs = [1, 5, 10, 15, 20, 25, n].filter((v, i, a) => a.indexOf(v) === i && v <= n).map((d) => `<span style="left:${((d - 0.5) / n) * 100}%">${d}</span>`).join('');
  return panel('chart', 'Fluxo do mês', null,
    `<div class="legend"><span><i style="background:var(--pos)"></i>Entradas</span><span><i style="background:var(--neg)"></i>Saídas</span></div>
     <div class="fl">${lines}<div class="fl-cols">${cols}</div>${max ? '' : '<div class="fl-empty">Sem movimentações no mês</div>'}</div><div class="fl-x">${xs}</div>`,
    'Valores pelo dia de vencimento ou previsão.');
}

function categoriasHTML() {
  const porCat = {};
  monthRows('pagar').forEach((x) => { const c = (x.v.cat || '').trim() || 'Sem categoria'; porCat[c] = (porCat[c] || 0) + (Number(x.v.valor) || 0); });
  const cats = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 7), maxCat = cats[0]?.[1] || 1;
  const body = cats.length
    ? `<div class="bars">${cats.map(([c, v]) => `<div class="bar-row"><span>${esc(c)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (v / maxCat) * 100)}%"></div></div><span class="num">${brl(v)}</span></div>`).join('')}</div>`
    : '<p class="empty-s">Ainda não há contas a pagar neste mês.</p>';
  return panel('tag', 'Gastos por categoria', null, body, `Contas a pagar de ${monthLabel(state.month)}.`);
}

function proximosHTML(tipo) {
  const hoje = todayStr();
  const pend = state.rows.filter((x) => x.tipo === tipo && x.v.status !== 'feito').sort((a, b) => (a.v.data || '9999').localeCompare(b.v.data || '9999'));
  const atras = pend.filter((x) => x.v.data && x.v.data < hoje).length;
  const lista = pend.slice(0, 5);
  const verbo = tipo === 'pagar' ? ['Vence em', 'Venceu em'] : ['Previsto para', 'Previsto para'];
  const body = lista.length ? lista.map((x) => {
    const late = x.v.data && x.v.data < hoje;
    return `<div class="item"><div class="info"><strong>${esc(x.v.desc || 'Sem descrição')}</strong><span class="sub ${late ? 'late' : ''}">${x.v.data ? `${verbo[late ? 1 : 0]} ${fmtDate(x.v.data)}` : 'Sem data'}</span></div><span class="amt">${brl(x.v.valor)}</span><button type="button" class="btn ghost sm" data-action="pagar-rapido" data-row="${x.id}">${tipo === 'pagar' ? 'Pagar' : 'Receber'}</button></div>`;
  }).join('') : '<p class="empty-s" style="padding:16px 20px">Nada pendente. Tudo em dia.</p>';
  const foot = `<span>${pend.length > 5 ? `+ ${pend.length - 5} mais` : ''}</span><button type="button" class="link" data-action="ir-tab" data-tab="${tipo}">Ver ${TIPOS[tipo].titulo.toLowerCase()} ›</button>`;
  return panel(tipo === 'pagar' ? 'out' : 'in', tipo === 'pagar' ? 'Próximas contas a pagar' : 'Próximos recebimentos', { n: pend.length, cls: atras ? 'warn' : '' }, body, foot, true);
}

function ultimasHTML() {
  const ult = state.rows.filter((x) => x.mes === state.month).sort((a, b) => (b.v.data || '').localeCompare(a.v.data || '') || (b.ordem || 0) - (a.ordem || 0)).slice(0, 6);
  const body = ult.length ? `<div class="mini-wrap"><table class="mini"><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th class="r">Valor</th><th>Status</th></tr></thead><tbody>${ult.map((x) => {
    const ent = x.tipo === 'receber';
    return `<tr><td>${fmtDate(x.v.data)}</td><td>${esc(x.v.desc || 'Sem descrição')}</td><td>${esc(x.v.cat || '')}</td><td><span class="pill ${ent ? 'in' : ''}">${ent ? 'Entrada' : 'Saída'}</span></td><td class="r ${ent ? 'pos' : 'neg'}">${ent ? '+' : '-'} ${brl(x.v.valor)}</td><td><span class="pill ${x.v.status === 'feito' ? 'ok' : ''}">${x.v.status === 'feito' ? TIPOS[x.tipo].feito : 'Pendente'}</span></td></tr>`;
  }).join('')}</tbody></table></div>` : '<p class="empty-s" style="padding:16px 20px">Nenhuma movimentação neste mês.</p>';
  return panel('list', 'Últimas movimentações', null, body, `<span></span><button type="button" class="link" data-action="ir-tab" data-tab="pagar">Ver contas a pagar ›</button>`, true);
}

const WIDGETS = [
  { id: 'saldo-real', nome: 'Saldo realizado', span: 1, hl: true, html: (d) => kpi('wallet', 'Saldo realizado', d.saldoReal, 'Recebido menos pago', { neg: true }) },
  { id: 'saldo-prev', nome: 'Saldo previsto', span: 1, html: (d) => kpi('trend', 'Saldo previsto', d.saldoPrev, 'A receber menos a pagar', { neg: true }) },
  { id: 'recebido', nome: 'Recebido', span: 1, html: (d) => kpi('in', 'Recebido', d.r.feito, `de ${brl(d.r.total)} previstos`) },
  { id: 'pago', nome: 'Pago', span: 1, html: (d) => kpi('out', 'Pago', d.p.feito, `de ${brl(d.p.total)} previstos`) },
  { id: 'tot-receber', nome: 'Total a receber', span: 1, html: (d) => kpi('in', 'Total a receber', d.r.total) },
  { id: 'pend-receber', nome: 'Pendente a receber', span: 1, html: (d) => kpi('clock', 'Pendente a receber', d.r.pend) },
  { id: 'tot-pagar', nome: 'Total a pagar', span: 1, html: (d) => kpi('out', 'Total a pagar', d.p.total) },
  { id: 'pend-pagar', nome: 'Pendente a pagar', span: 1, html: (d) => kpi('clock', 'Pendente a pagar', d.p.pend) },
  { id: 'fluxo', nome: 'Fluxo do mês', span: 2, html: fluxoHTML },
  { id: 'categorias', nome: 'Gastos por categoria', span: 2, html: categoriasHTML },
  { id: 'vencimentos', nome: 'Próximas contas a pagar', span: 2, html: () => proximosHTML('pagar') },
  { id: 'recebimentos', nome: 'Próximos recebimentos', span: 2, html: () => proximosHTML('receber') },
  { id: 'ultimas', nome: 'Últimas movimentações', span: 4, html: ultimasHTML },
];

function layoutState() {
  const L = state.prefs.layout, ids = WIDGETS.map((w) => w.id), base = (L.ordem || []).filter((id) => ids.includes(id));
  return { ordem: [...base, ...ids.filter((id) => !base.includes(id))], ocultos: (L.ocultos || []).filter((id) => ids.includes(id)) };
}
function reorder(id, targetId) {
  const { ordem } = layoutState(), from = ordem.indexOf(id), to = ordem.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return;
  ordem.splice(from, 1); ordem.splice(to, 0, id);
  state.prefs.layout.ordem = ordem; savePrefs(); render();
}

function renderResumo() {
  const d = calc(), { ordem, ocultos } = layoutState(), edit = state.editLayout;
  const vis = ordem.filter((id) => !ocultos.includes(id));
  const cards = vis.map((id, i) => {
    const w = WIDGETS.find((x) => x.id === id);
    const ctl = edit ? `<div class="w-edit"><span class="grip" aria-hidden="true">${ICON('grip')}</span><span class="w-name">${esc(w.nome)}</span><span class="grow"></span>
      <button type="button" data-action="w-move" data-w="${id}" data-dir="-1" aria-label="Mover ${esc(w.nome)} para trás" ${i === 0 ? 'disabled' : ''}>${ICON('left')}</button>
      <button type="button" data-action="w-move" data-w="${id}" data-dir="1" aria-label="Mover ${esc(w.nome)} para frente" ${i === vis.length - 1 ? 'disabled' : ''}>${ICON('right')}</button>
      <button type="button" data-action="w-hide" data-w="${id}" aria-label="Ocultar ${esc(w.nome)}">${ICON('eyeoff')}</button></div>` : '';
    return `<article class="w s${w.span}${w.hl ? ' hl' : ''}${edit ? ' editable' : ''}" data-w="${id}" ${edit ? 'draggable="true"' : ''}>${ctl}${w.html(d)}</article>`;
  }).join('');
  const tray = edit ? `<div class="tray"><span>${ocultos.length ? 'Cards ocultos:' : 'Nenhum card oculto.'}</span>${ocultos.map((id) => `<button type="button" class="btn ghost sm" data-action="w-show" data-w="${id}">${ICON('plus')}${esc(WIDGETS.find((w) => w.id === id).nome)}</button>`).join('')}</div>` : '';
  return `
    ${d.venc.length ? `<div class="alert-warn">${ICON('alert')}<span><strong>${d.venc.length} ${d.venc.length === 1 ? 'conta vencida' : 'contas vencidas'}</strong> sem pagamento, somando ${brl(d.somaVenc)}.</span><button class="link" type="button" data-action="ir-tab" data-tab="pagar">Ver contas a pagar ›</button></div>` : ''}
    <div class="view-head">
      <h2 class="v-title">Resumo financeiro</h2>
      <div class="view-actions">${edit
        ? `<button class="btn ghost sm" type="button" data-action="layout-reset">${ICON('reset')}Restaurar padrão</button><button class="btn sm" type="button" data-action="edit-end">${ICON('check')}Concluir</button>`
        : `<button class="btn ghost sm" type="button" data-action="edit-start">${ICON('grid')}Organizar cards</button>`}</div>
    </div>
    ${edit ? `<div class="editbar">${ICON('grip', 'kicon')}<span>Arraste os cards para mudar a ordem, ou use as setas. O olho oculta um card.</span></div>` : ''}
    <div class="grid">${cards}</div>
    ${tray}`;
}

function cellHTML(tipo, row, col) {
  const val = row.v[col.id];
  const base = `data-row="${row.id}" data-col="${col.id}" aria-label="${esc(col.nome)}${row.v.desc ? ', ' + esc(row.v.desc) : ''}"`;
  switch (col.tipo) {
    case 'data': return `<input type="date" value="${esc(val || '')}" ${base}>`;
    case 'moeda': return `<input type="text" inputmode="decimal" class="money" placeholder="0,00" value="${esc(num2(val))}" ${base}>`;
    case 'numero': return `<input type="text" inputmode="decimal" class="money" value="${esc(val == null ? '' : String(val).replace('.', ','))}" ${base}>`;
    case 'status': {
      const on = val === 'feito';
      return `<button type="button" class="chip" aria-pressed="${on}" data-action="status" data-row="${row.id}">${on ? ICON('check') + TIPOS[tipo].feito : 'Pendente'}</button>`;
    }
    default: return `<input type="text" value="${esc(val || '')}" ${col.id === 'cat' ? `list="cats-${tipo}"` : ''} ${base}>`;
  }
}

function renderSecao(tipo) {
  const T = TIPOS[tipo], cols = state.schema[tipo], rows = monthRows(tipo), s = sums(tipo, state.month);
  const usadas = [...new Set(state.rows.filter((r) => r.tipo === tipo && r.v.cat).map((r) => r.v.cat.trim()))];
  const cats = [...new Set([...usadas, ...CATS_PADRAO[tipo]])];
  const valorIdx = cols.findIndex((c) => c.id === 'valor');
  const head = cols.map((c) => `<th scope="col" class="${c.tipo === 'moeda' ? 'right' : ''}"><button type="button" class="colbtn" data-action="edit-col" data-col="${c.id}" title="Editar coluna ${esc(c.nome)}"><span>${esc(c.nome)}</span>${ICON('sliders')}</button></th>`).join('') + '<th scope="col"><span class="sr">Ações</span></th>';
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td data-label="${esc(c.nome)}">${cellHTML(tipo, r, c)}</td>`).join('')}<td class="act"><button type="button" class="row-del" data-action="del-row" data-row="${r.id}" aria-label="Excluir lançamento${r.v.desc ? ' ' + esc(r.v.desc) : ''}">${ICON('trash')}</button></td></tr>`).join('');
  const foot = `<tr>${cols.map((c, i) => (i === 0 ? '<td>Total do mês</td>' : i === valorIdx ? `<td class="right num">${brl(s.total)}</td>` : '<td class="hide-m"></td>')).join('')}<td class="hide-m"></td></tr>`;
  const cell = (icon, label, v) => `<div class="cell"><div class="k-label">${ICON(icon, 'kicon')}<span>${label}</span></div><div class="k-value">${brl(v)}</div></div>`;
  return `
    <div class="view-head">
      <h2 class="v-title">${T.titulo} em ${monthLabel(state.month)}</h2>
      <div class="view-actions">
        <button class="btn ghost sm" type="button" data-action="gerenciar-cols">${ICON('sliders')}Colunas</button>
        <button class="btn sm" type="button" data-action="add-row">${ICON('plus')}Novo lançamento</button>
      </div>
    </div>
    <div class="card cells">${cell(tipo === 'pagar' ? 'out' : 'in', T.totalLabel, s.total)}${cell('checkc', T.feitoLabel, s.feito)}${cell('clock', T.pendLabel, s.pend)}</div>
    <datalist id="cats-${tipo}">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    ${rows.length ? `<div class="tablewrap"><table class="ed"><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>` : `
      <div class="empty">
        <p><strong>Nada em ${monthLabel(state.month)} ainda.</strong><br><span class="muted">Adicione o primeiro lançamento ou traga os do mês anterior.</span></p>
        <div class="row" style="justify-content:center">
          <button class="btn" type="button" data-action="add-row">${ICON('plus')}Novo lançamento</button>
          <button class="btn ghost" type="button" data-action="copiar">${ICON('copy')}Copiar mês anterior</button>
        </div>
      </div>`}
  `;
}


/* ============ tela Clientes e notas ============ */
const GERAL = $('#dlg-geral'), GBODY = $('#geral-body');
const openDlg = (html) => { GBODY.innerHTML = html; if (!GERAL.open) GERAL.showModal(); };
const closeDlg = () => { if (GERAL.open) GERAL.close(); };
const cliente = (id) => state.mei.clientes.find((c) => c.id === id);
const meiCompleto = () => state.mei.prestador.nome.trim() && state.mei.prestador.cnpj.trim();

function renderClientes() {
  const ano = state.month.slice(0, 4);
  const recAno = state.rows.filter((x) => x.tipo === 'receber' && x.v.status === 'feito' && (x.v.data || '').startsWith(ano)).reduce((s, x) => s + (Number(x.v.valor) || 0), 0);
  const pct = Math.min(100, (recAno / LIMITE_MEI) * 100), perto = recAno >= LIMITE_MEI * 0.8;
  const mensal = monthRows('receber').filter((x) => x.v.clienteId);
  const cl = state.mei.clientes;
  const totMes = mensal.reduce((s, x) => s + (Number(x.v.valor) || 0), 0);
  return `
    <div class="view-head"><h2 class="v-title">Clientes e notas em ${monthLabel(state.month)}</h2>
      <div class="view-actions"><button class="btn ghost sm" type="button" data-action="mei-dados">${ICON('sliders')}Dados da MEI</button>
      <button class="btn ghost sm" type="button" data-action="rel-mensal">${ICON('down')}Relatório mensal (PDF)</button></div></div>
    ${meiCompleto() ? '' : `<div class="notice">${ICON('alert')}<span>Preencha os <button class="link" type="button" data-action="mei-dados">dados da MEI</button> (nome e CNPJ) para gerar recibo e preparar a nota.</span></div>`}
    <div class="card limit">
      <div class="limit-top"><div><div class="k-label">${ICON('wallet', 'kicon')}<span>Receita recebida em ${ano}</span></div><div class="k-value">${brl(recAno)}</div></div>
      <span class="muted small">Limite anual do MEI: ${brl(LIMITE_MEI)} (confira se mudou)</span></div>
      <div class="bar-track"><div class="bar-fill ${perto ? 'warn' : ''}" style="width:${pct}%"></div></div>
      <span class="small ${perto ? '' : 'muted'}" ${perto ? 'style="color:var(--neg)"' : ''}>${perto ? 'Atenção: você passou de 80% do limite. Fale com o contador.' : `Faltam ${brl(Math.max(0, LIMITE_MEI - recAno))} para o limite.`}</span>
    </div>

    <div class="view-head"><h2 class="v-title">Quem paga a mensalidade</h2>
      <div class="view-actions"><button class="btn sm" type="button" data-action="cli-novo">${ICON('plus')}Novo cliente</button></div></div>
    ${cl.length ? `<div class="card mini-wrap"><table class="mini"><thead><tr><th>Quem paga</th><th>Pessoa cuidada</th><th class="r">Mensalidade</th><th>Vence dia</th><th></th></tr></thead><tbody>${cl.map((c) => `<tr><td>${esc(c.pagador)}</td><td>${esc(c.pessoa)}</td><td class="r">${brl(c.valor)}</td><td>${esc(c.dia)}</td><td><div class="tbl-act"><button class="btn ghost sm" type="button" data-action="cli-edit" data-id="${c.id}">Editar</button><button class="row-del" type="button" data-action="cli-del" data-id="${c.id}" aria-label="Excluir cliente ${esc(c.pagador)}">${ICON('trash')}</button></div></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><p><strong>Nenhum cliente ainda.</strong><br><span class="muted">Cadastre quem paga a mensalidade e o valor combinado.</span></p><button class="btn" type="button" data-action="cli-novo">${ICON('plus')}Novo cliente</button></div>`}

    <div class="view-head sec-block"><h2 class="v-title">Mensalidades de ${monthLabel(state.month)} <span class="muted">(${brl(totMes)})</span></h2>
      <div class="view-actions"><button class="btn ghost sm" type="button" data-action="gerar-mensal" ${cl.length ? '' : 'disabled'}>${ICON('plus')}Gerar mensalidades do mês</button></div></div>
    ${mensal.length ? `<div class="card mini-wrap"><table class="mini"><thead><tr><th>Cliente</th><th class="r">Valor</th><th>Status</th><th>Nota</th><th></th></tr></thead><tbody>${mensal.map((x) => { const c = cliente(x.v.clienteId); return `<tr><td>${esc(c ? c.pagador : x.v.desc)}<div class="muted small">${esc(c ? c.pessoa : '')}</div></td><td class="r">${brl(x.v.valor)}</td><td><button type="button" class="chip" style="margin:0" aria-pressed="${x.v.status === 'feito'}" data-action="status" data-row="${x.id}">${x.v.status === 'feito' ? ICON('check') + 'Recebido' : 'Pendente'}</button></td><td>${x.v.notaNumero ? `<span class="pill ok">Nº ${esc(x.v.notaNumero)}</span>` : '<span class="pill">Não emitida</span>'}</td><td><div class="tbl-act"><button class="btn ghost sm" type="button" data-action="recibo" data-row="${x.id}">Recibo</button><button class="btn sm" type="button" data-action="nota" data-row="${x.id}">Preparar nota</button></div></td></tr>`; }).join('')}</tbody></table></div>`
      : `<p class="muted">${cl.length ? 'Clique em "Gerar mensalidades do mês" para criar a cobrança de cada cliente.' : 'Cadastre um cliente para gerar as mensalidades.'}</p>`}
    <p class="muted small" style="margin-top:16px">Este site prepara os dados da nota e o recibo. A emissão da nota fiscal é feita no sistema oficial da prefeitura ou no Emissor Nacional.</p>`;
}

function dlgMei() {
  const p = state.mei.prestador, f = (id, l, v, ph = '', full = false) => `<label class="field ${full ? 'full' : ''}"><span>${l}</span><input type="text" id="${id}" value="${esc(v)}" placeholder="${ph}"></label>`;
  openDlg(`<h2>Dados da MEI</h2><form id="f-mei" class="dlg" style="padding:0"><div class="form-grid">
    ${f('m-nome', 'Nome / razão social', p.nome, '', true)}${f('m-cnpj', 'CNPJ', p.cnpj, '00.000.000/0000-00')}${f('m-mun', 'Município', p.municipio)}
    ${f('m-cnae', 'Atividade (CNAE)', p.cnae, 'Conforme o certificado MEI')}${f('m-cod', 'Código do serviço', p.codServico, 'Confirme com o contador')}
    <label class="field full"><span>Descrição padrão do serviço</span><textarea id="m-desc">${esc(p.descricao)}</textarea></label></div>
    <div class="dlg-actions"><span class="grow"></span><button class="btn ghost" type="button" data-g="fechar">Cancelar</button><button class="btn" type="submit">Salvar</button></div></form>`);
  $('#f-mei').addEventListener('submit', (e) => {
    e.preventDefault();
    state.mei.prestador = { nome: $('#m-nome').value.trim(), cnpj: $('#m-cnpj').value.trim(), municipio: $('#m-mun').value.trim(), cnae: $('#m-cnae').value.trim(), codServico: $('#m-cod').value.trim(), descricao: $('#m-desc').value.trim() };
    saveMei(); closeDlg(); render(); toast('Dados da MEI salvos.');
  });
}

function dlgCliente(id) {
  const c = id ? cliente(id) : { pagador: '', cpf: '', pessoa: '', valor: '', dia: 5 };
  openDlg(`<h2>${id ? 'Editar cliente' : 'Novo cliente'}</h2><form id="f-cli" class="dlg" style="padding:0"><div class="form-grid">
    <label class="field full"><span>Quem paga (nome completo)</span><input type="text" id="c-pag" value="${esc(c.pagador)}" required></label>
    <label class="field"><span>CPF de quem paga (opcional)</span><input type="text" id="c-cpf" inputmode="numeric" value="${esc(c.cpf)}" placeholder="Necessário para nota com CPF"></label>
    <label class="field"><span>Pessoa cuidada</span><input type="text" id="c-pes" value="${esc(c.pessoa)}" required></label>
    <label class="field"><span>Mensalidade combinada (R$)</span><input type="text" id="c-val" inputmode="decimal" value="${esc(num2(c.valor))}" placeholder="0,00" required></label>
    <label class="field"><span>Vence todo dia</span><input type="number" id="c-dia" min="1" max="31" value="${esc(c.dia)}" required></label></div>
    <div class="dlg-actions"><span class="grow"></span><button class="btn ghost" type="button" data-g="fechar">Cancelar</button><button class="btn" type="submit">Salvar</button></div></form>`);
  $('#f-cli').addEventListener('submit', (e) => {
    e.preventDefault();
    const nv = { id: id || newId(), pagador: $('#c-pag').value.trim(), cpf: $('#c-cpf').value.trim(), pessoa: $('#c-pes').value.trim(), valor: parseMoney($('#c-val').value) || 0, dia: Math.min(31, Math.max(1, Number($('#c-dia').value) || 1)) };
    if (id) Object.assign(cliente(id), nv); else state.mei.clientes.push(nv);
    saveMei(); closeDlg(); render();
  });
}

function gerarMensalidades() {
  let n = 0; const [y, m] = state.month.split('-').map(Number), last = new Date(y, m, 0).getDate();
  for (const c of state.mei.clientes) {
    if (state.rows.some((x) => x.tipo === 'receber' && x.mes === state.month && x.v.clienteId === c.id)) continue;
    const row = { id: newId(), tipo: 'receber', mes: state.month, ordem: Date.now() + n, v: { data: `${state.month}-${pad(Math.min(c.dia, last))}`, desc: `Mensalidade - ${c.pessoa}`, cat: 'Cuidados', valor: c.valor, status: 'pendente', clienteId: c.id } };
    state.rows.push(row); persistRow(row); n++;
  }
  render(); toast(n ? `${n} ${n === 1 ? 'mensalidade criada' : 'mensalidades criadas'}.` : 'As mensalidades deste mês já foram criadas.');
}

function dadosNota(row) {
  const c = cliente(row.v.clienteId) || { pagador: '', cpf: '', pessoa: '' }, p = state.mei.prestador;
  const comp = shortMonth(row.mes), desc = `${p.descricao || 'Serviço de cuidados'} - ${c.pessoa}. Competência ${comp}.`;
  return { c, p, comp, desc, valor: brl(row.v.valor), data: fmtDate(row.v.datapag || row.v.data) };
}

function dlgNota(rowId) {
  const row = findRow(rowId); if (!row) return;
  const { c, p, comp, desc, valor, data } = dadosNota(row);
  const linhas = (t, arr) => `<div class="kv"><div class="kv-h">${t}</div>${arr.map(([k, v]) => `<div class="kv-r"><span class="k">${k}</span><span class="v ${v ? '' : 'empty'}">${v ? esc(v) : 'Preencher'}</span>${v ? `<button class="btn ghost sm" type="button" data-g="copiar" data-v="${esc(v)}">Copiar</button>` : ''}</div>`).join('')}</div>`;
  const todos = [`Prestador: ${p.nome} - CNPJ ${p.cnpj} - ${p.municipio}`, `Tomador: ${c.pagador}${c.cpf ? ' - CPF ' + c.cpf : ''}`, `Serviço: ${desc}`, `Código do serviço: ${p.codServico}`, `Valor: ${valor}`, `Data: ${data}`].join('\n');
  openDlg(`<h2>Preparar nota</h2><p class="muted small" style="margin:0">Confira os dados, copie para o emissor e registre o número depois de emitir.</p>
    ${linhas('Prestador (MEI)', [['Nome', p.nome], ['CNPJ', p.cnpj], ['Município', p.municipio], ['Código do serviço', p.codServico]])}
    ${linhas('Tomador (quem paga)', [['Nome', c.pagador], ['CPF', c.cpf]])}
    ${linhas('Serviço', [['Descrição', desc], ['Valor', valor], ['Data', data]])}
    <div class="dlg-actions"><button class="btn ghost" type="button" data-g="copiar" data-v="${esc(todos)}">${ICON('copy')}Copiar tudo</button>
      <a class="btn" href="https://www.nfse.gov.br/EmissorNacional" target="_blank" rel="noopener">Abrir Emissor Nacional</a></div>
    <form id="f-nota" class="dlg" style="padding:0"><div class="form-grid"><label class="field"><span>Número da nota emitida</span><input type="text" id="n-num" value="${esc(row.v.notaNumero || '')}"></label>
    <label class="field"><span>Data de emissão</span><input type="date" id="n-data" value="${esc(row.v.notaData || '')}"></label></div>
    <div class="dlg-actions"><span class="grow"></span><button class="btn ghost" type="button" data-g="fechar">Fechar</button><button class="btn" type="submit">Registrar nota</button></div></form>`);
  $('#f-nota').addEventListener('submit', (e) => {
    e.preventDefault(); row.v.notaNumero = $('#n-num').value.trim() || null; row.v.notaData = $('#n-data').value || null;
    persistRow(row); closeDlg(); render(); toast('Nota registrada.');
  });
}
GBODY.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-g]'); if (!b) return;
  if (b.dataset.g === 'fechar') closeDlg();
  else if (b.dataset.g === 'copiar') { try { await navigator.clipboard.writeText(b.dataset.v); toast('Copiado.'); } catch { toast('Não foi possível copiar. Selecione o texto manualmente.'); } }
});

function extenso(n) {
  const u = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const d = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const c = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  const ate999 = (x) => { if (x === 100) return 'cem'; const s = []; if (x >= 100) { s.push(c[Math.floor(x / 100)]); x %= 100; } if (x > 0) s.push(x < 20 ? u[x] : d[Math.floor(x / 10)] + (x % 10 ? ' e ' + u[x % 10] : '')); return s.join(' e '); };
  const milhar = (x) => { const m = Math.floor(x / 1000), r = x % 1000, p = []; if (m) p.push(m === 1 ? 'mil' : ate999(m) + ' mil'); if (r) p.push(ate999(r)); return p.join(m && r && (r < 100 || r % 100 === 0) ? ' e ' : ' '); };
  const reais = Math.floor(n), cent = Math.round((n - reais) * 100), out = [];
  if (reais > 0) out.push(`${milhar(reais)} ${reais === 1 ? 'real' : 'reais'}`);
  if (cent > 0) out.push(`${ate999(cent)} ${cent === 1 ? 'centavo' : 'centavos'}`);
  return out.join(' e ') || 'zero real';
}

async function gerarRecibo(rowId) {
  const row = findRow(rowId); if (!row) return;
  if (!meiCompleto()) { toast('Preencha os dados da MEI antes de gerar o recibo.'); return dlgMei(); }
  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    const { c, p, comp, valor } = dadosNota(row), v = Number(row.v.valor) || 0;
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.text('RECIBO', 297, 90, { align: 'center' });
    doc.setFontSize(14); doc.text(valor, 297, 125, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(12);
    const texto = `Recebi de ${c.pagador}${c.cpf ? ', CPF ' + c.cpf : ''}, a importância de ${valor} (${extenso(v)}), referente à prestação de serviço de cuidados e acompanhamento de ${c.pessoa}, competência ${comp}.`;
    doc.text(doc.splitTextToSize(texto, 460), 68, 180, { lineHeightFactor: 1.6 });
    doc.text(`${(p.municipio || '').split('/')[0] || 'Local'}, ${fmtDate(row.v.datapag || todayStr())}.`, 68, 330);
    doc.line(150, 440, 445, 440);
    doc.setFont('helvetica', 'bold'); doc.text(p.nome, 297, 460, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.text(`CNPJ ${p.cnpj}`, 297, 478, { align: 'center' });
    doc.save(`recibo-${(c.pagador || 'cliente').split(' ')[0].normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase() || 'cliente'}-${row.mes}.pdf`);
  } catch (e) { console.error(e); toast('Não foi possível gerar o recibo. Verifique a conexão.'); }
}

async function gerarRelatorioMensal() {
  if (!meiCompleto()) { toast('Preencha os dados da MEI antes de gerar o relatório.'); return dlgMei(); }
  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    const p = state.mei.prestador, doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const rows = monthRows('receber').filter((x) => x.v.status === 'feito');
    const total = rows.reduce((s, x) => s + (Number(x.v.valor) || 0), 0);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('RELATÓRIO MENSAL DAS RECEITAS BRUTAS', 40, 56);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text(`${p.nome} - CNPJ ${p.cnpj}`, 40, 78); doc.text(`Período: ${monthLabel(state.month)}`, 40, 94);
    doc.autoTable({ startY: 112, margin: { left: 40, right: 40 }, styles: { fontSize: 10, cellPadding: 6 }, headStyles: { fillColor: [35, 35, 35] }, columnStyles: { 3: { halign: 'right' } },
      head: [['Data', 'Descrição', 'Nota fiscal', 'Valor']],
      body: rows.length ? rows.map((x) => [fmtDate(x.v.datapag || x.v.data), x.v.desc || '', x.v.notaNumero ? `Nº ${x.v.notaNumero}` : 'Sem nota', brl(x.v.valor)]) : [[{ content: 'Sem receitas recebidas no mês.', colSpan: 4 }]],
      foot: [['', '', 'Total de serviços', brl(total)]], footStyles: { fillColor: [235, 235, 235], textColor: 35, fontStyle: 'bold', halign: 'right' } });
    const y = doc.lastAutoTable.finalY + 60;
    doc.line(40, y, 260, y); doc.setFontSize(10); doc.text(`${p.nome} - responsável`, 40, y + 14);
    doc.text(`Gerado em ${fmtDate(todayStr())}. Guarde junto com as notas e comprovantes.`, 40, y + 40);
    doc.save(`relatorio-receitas-${state.month}.pdf`);
  } catch (e) { console.error(e); toast('Não foi possível gerar o relatório. Verifique a conexão.'); }
}

/* ============ ações ============ */
function findRow(id) { return state.rows.find((r) => r.id === id); }

function addRow(tipo) {
  const cur = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const data = state.month === cur ? todayStr() : `${state.month}-01`;
  const row = { id: newId(), tipo, mes: state.month, v: { data, status: 'pendente' }, ordem: Date.now() };
  state.rows.push(row); persistRow(row);
  state.focusRow = row.id; render();
}

function deleteRow(id) {
  const i = state.rows.findIndex((r) => r.id === id);
  if (i < 0) return;
  const [row] = state.rows.splice(i, 1);
  removeRowStore(id); render();
  toast('Lançamento excluído.', () => { state.rows.push(row); persistRow(row); render(); });
}

function copyPrevMonth() {
  const prev = addMonths(state.month, -1);
  const tipos = state.tab === 'receber' || state.tab === 'pagar' ? [state.tab] : ['receber', 'pagar'];
  let n = 0;
  for (const tipo of tipos) {
    for (const r of monthRows(tipo, prev)) {
      const v = { ...r.v, status: 'pendente' };
      delete v.datapag;
      if (v.data) { const [y, m, d] = v.data.split('-').map(Number); const [ty, tm] = state.month.split('-').map(Number); const last = new Date(ty, tm, 0).getDate(); v.data = `${ty}-${pad(tm)}-${pad(Math.min(d, last))}`; }
      else v.data = `${state.month}-01`;
      const row = { id: newId(), tipo, mes: state.month, v, ordem: Date.now() + n };
      state.rows.push(row); persistRow(row); n++;
    }
  }
  render();
  toast(n ? `${n} ${n === 1 ? 'lançamento copiado' : 'lançamentos copiados'} de ${monthLabel(prev)}.` : `Nada para copiar em ${monthLabel(prev)}.`);
}

view.addEventListener('change', (e) => {
  const el = e.target.closest('[data-row][data-col]');
  if (!el) return;
  const row = findRow(el.dataset.row); if (!row) return;
  const col = state.schema[row.tipo].find((c) => c.id === el.dataset.col); if (!col) return;
  let val = el.value;
  if (col.tipo === 'moeda' || col.tipo === 'numero') val = parseMoney(val);
  else if (val === '') val = null;
  row.v[col.id] = val;
  let moved = false;
  if (col.id === 'data' && val && monthOf(val) !== row.mes) { row.mes = monthOf(val); moved = true; }
  persistRow(row); render();
  if (moved) toast(`Lançamento movido para ${monthLabel(row.mes)}.`);
});

view.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]'); if (!b) return;
  const a = b.dataset.action;
  if (a === 'add-row') addRow(state.tab);
  else if (a === 'del-row') deleteRow(b.dataset.row);
  else if (a === 'copiar') copyPrevMonth();
  else if (a === 'mei-dados') dlgMei();
  else if (a === 'cli-novo') dlgCliente(null);
  else if (a === 'cli-edit') dlgCliente(b.dataset.id);
  else if (a === 'cli-del') { const i = state.mei.clientes.findIndex((c) => c.id === b.dataset.id); if (i >= 0) { const [rm] = state.mei.clientes.splice(i, 1); saveMei(); render(); toast('Cliente excluído.', () => { state.mei.clientes.splice(i, 0, rm); saveMei(); render(); }); } }
  else if (a === 'gerar-mensal') gerarMensalidades();
  else if (a === 'recibo') gerarRecibo(b.dataset.row);
  else if (a === 'nota') dlgNota(b.dataset.row);
  else if (a === 'rel-mensal') gerarRelatorioMensal();
  else if (a === 'ir-tab') { state.tab = b.dataset.tab; render(); }
  else if (a === 'edit-start') { state.editLayout = true; render(); }
  else if (a === 'edit-end') { state.editLayout = false; render(); }
  else if (a === 'layout-reset') { state.prefs.layout = { ordem: null, ocultos: [] }; savePrefs(); render(); }
  else if (a === 'w-hide') { const L = layoutState(); state.prefs.layout.ordem = L.ordem; state.prefs.layout.ocultos = [...L.ocultos, b.dataset.w]; savePrefs(); render(); }
  else if (a === 'w-show') { const L = layoutState(); state.prefs.layout.ordem = L.ordem; state.prefs.layout.ocultos = L.ocultos.filter((x) => x !== b.dataset.w); savePrefs(); render(); }
  else if (a === 'w-move') {
    const L = layoutState(), vis = L.ordem.filter((x) => !L.ocultos.includes(x)), i = vis.indexOf(b.dataset.w), j = i + Number(b.dataset.dir);
    if (j >= 0 && j < vis.length) reorder(b.dataset.w, vis[j]);
  }
  else if (a === 'pagar-rapido') {
    const row = findRow(b.dataset.row); if (!row) return;
    row.v.status = 'feito';
    if (state.schema[row.tipo].some((c) => c.id === 'datapag') && !row.v.datapag) row.v.datapag = todayStr();
    persistRow(row); render(); toast(row.tipo === 'pagar' ? 'Conta marcada como paga.' : 'Marcado como recebido.');
  }
  else if (a === 'gerenciar-cols') openColList();
  else if (a === 'edit-col') openColEditor(b.dataset.col);
  else if (a === 'status') {
    const row = findRow(b.dataset.row); if (!row) return;
    const on = row.v.status !== 'feito';
    row.v.status = on ? 'feito' : 'pendente';
    if (on && state.schema[row.tipo].some((c) => c.id === 'datapag') && !row.v.datapag) row.v.datapag = todayStr();
    persistRow(row); render();
  }
});

/* navegação */
document.querySelectorAll('.tabs [role=tab]').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; render(); }));
$('#mes-prev').addEventListener('click', () => { state.month = addMonths(state.month, -1); render(); });
$('#mes-next').addEventListener('click', () => { state.month = addMonths(state.month, 1); render(); });
$('#mes-input').addEventListener('change', (e) => { if (e.target.value) { state.month = e.target.value; render(); } });
$('#btn-copiar').addEventListener('click', copyPrevMonth);
$('#mes-hoje').addEventListener('click', () => { state.month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`; render(); });

/* arrastar e soltar os cards */
let dragId = null;
view.addEventListener('dragstart', (e) => {
  const w = e.target.closest('.w.editable'); if (!w) return;
  dragId = w.dataset.w; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); w.classList.add('dragging');
});
view.addEventListener('dragover', (e) => {
  if (!dragId) return;
  const w = e.target.closest('.w.editable'); if (!w || w.dataset.w === dragId) return;
  e.preventDefault(); view.querySelectorAll('.dropt').forEach((x) => x.classList.remove('dropt')); w.classList.add('dropt');
});
view.addEventListener('drop', (e) => {
  const w = e.target.closest('.w.editable'); if (!dragId || !w) return;
  e.preventDefault(); const id = dragId; dragId = null; reorder(id, w.dataset.w);
});
view.addEventListener('dragend', () => { dragId = null; render(); });

/* tema */
const dlgTema = $('#dlg-tema');
function syncTemaUI() {
  const t = state.prefs.tema;
  dlgTema.querySelectorAll('input[type=radio]').forEach((r) => { r.checked = t[r.name] === r.value; });
  $('#cor-custom').value = t.cor;
  $('#swatches').innerHTML = CORES.map(([n, c]) => `<button type="button" class="swatch" data-cor="${c}" style="background:${c}" aria-label="${n}" aria-pressed="${c.toLowerCase() === t.cor.toLowerCase()}"></button>`).join('');
}
function setTema(patch) { state.prefs.tema = { ...state.prefs.tema, ...patch }; applyTheme(); savePrefs(); syncTemaUI(); }
$('#btn-tema').addEventListener('click', () => { syncTemaUI(); dlgTema.showModal(); });
dlgTema.addEventListener('change', (e) => { if (e.target.matches('input[type=radio]')) setTema({ [e.target.name]: e.target.value }); });
$('#swatches').addEventListener('click', (e) => { const b = e.target.closest('[data-cor]'); if (b) setTema({ cor: b.dataset.cor }); });
$('#cor-custom').addEventListener('input', (e) => setTema({ cor: e.target.value }));
$('#tema-reset').addEventListener('click', () => setTema(PREFS_PADRAO().tema));

/* ============ colunas ============ */
const dlgCols = $('#dlg-cols'), dlgCol = $('#dlg-col');

function openColList() {
  const tipo = state.tab;
  $('#dlg-cols-titulo').textContent = `Colunas de ${TIPOS[tipo].titulo.toLowerCase()}`;
  $('#col-list').innerHTML = state.schema[tipo].map((c) => `<li><span class="grow"><strong>${esc(c.nome)}</strong><br><span class="tipo">${TIPO_COL[c.tipo]}</span></span><button class="btn ghost sm" type="button" data-col="${c.id}">Editar</button></li>`).join('');
  if (!dlgCols.open) dlgCols.showModal();
}
$('#col-list').addEventListener('click', (e) => { const b = e.target.closest('[data-col]'); if (b) openColEditor(b.dataset.col); });
$('#btn-nova-coluna').addEventListener('click', () => openColEditor(null));

function openColEditor(colId) {
  const tipo = state.tab;
  const col = colId ? state.schema[tipo].find((c) => c.id === colId) : null;
  state.editing = { tipo, colId };
  $('#dlg-col-titulo').textContent = col ? 'Editar coluna' : 'Nova coluna';
  $('#col-nome').value = col ? col.nome : '';
  const sel = $('#col-tipo');
  sel.value = col && col.tipo !== 'status' ? col.tipo : 'texto';
  sel.disabled = !!(col && col.fixo);
  $('#col-aviso').hidden = !(col && col.fixo);
  $('#col-mover').hidden = !col;
  const del = $('#col-excluir'); del.hidden = !col || !!col.fixo; del.textContent = 'Excluir coluna'; del.classList.remove('armed');
  if (dlgCols.open) dlgCols.close();
  dlgCol.showModal();
  $('#col-nome').focus();
}

$('#form-col').addEventListener('submit', (e) => {
  e.preventDefault();
  const { tipo, colId } = state.editing;
  const nome = $('#col-nome').value.trim(); if (!nome) return;
  const cols = state.schema[tipo];
  if (colId) {
    const c = cols.find((x) => x.id === colId);
    c.nome = nome; if (!c.fixo) c.tipo = $('#col-tipo').value;
  } else {
    cols.push({ id: 'c_' + newId().slice(0, 8), nome, tipo: $('#col-tipo').value });
  }
  persistSchema(); dlgCol.close(); render();
  if (state.tab !== 'resumo') openColList();
});
$('#col-cancelar').addEventListener('click', () => { dlgCol.close(); if (state.tab !== 'resumo') openColList(); });
$('#col-excluir').addEventListener('click', (e) => {
  const b = e.currentTarget;
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Confirmar exclusão'; return; }
  const { tipo, colId } = state.editing;
  state.schema[tipo] = state.schema[tipo].filter((c) => c.id !== colId);
  persistSchema(); dlgCol.close(); render(); toast('Coluna excluída.');
});
function moveCol(dir) {
  const { tipo, colId } = state.editing; const cols = state.schema[tipo];
  const i = cols.findIndex((c) => c.id === colId), j = i + dir;
  if (j < 0 || j >= cols.length) return;
  [cols[i], cols[j]] = [cols[j], cols[i]];
  persistSchema(); render();
}
$('#col-esq').addEventListener('click', () => moveCol(-1));
$('#col-dir').addEventListener('click', () => moveCol(1));

/* ============ aviso ============ */
let toastTimer;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Desfazer</button>' : ''}`;
  t.hidden = false;
  if (undo) t.querySelector('button').onclick = () => { undo(); t.hidden = true; };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 6000 : 3500);
}

/* ============ exportação ============ */
const dlgExp = $('#dlg-export');
$('#btn-exportar').addEventListener('click', () => { $('#exp-mes').textContent = monthLabel(state.month); $('#exp-status').textContent = ''; dlgExp.showModal(); });
$('#exp-fechar').addEventListener('click', () => dlgExp.close());

const scripts = {};
function loadScript(src) {
  return (scripts[src] ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar ' + src)); document.head.appendChild(s); }));
}
function monthsInScope(escopo) {
  if (escopo === 'mes') return [state.month];
  const set = [...new Set(state.rows.map((r) => r.mes).filter(Boolean))].sort();
  return set.length ? set : [state.month];
}
function cellText(col, val, tipo) {
  if (val == null || val === '') return '';
  if (col.tipo === 'moeda') return brl(val);
  if (col.tipo === 'data') return fmtDate(val);
  if (col.tipo === 'status') return val === 'feito' ? TIPOS[tipo].feito : 'Pendente';
  if (col.tipo === 'numero') return String(val).replace('.', ',');
  return String(val);
}
const escopoSel = () => document.querySelector('input[name=escopo]:checked').value;
const stamp = () => new Date().toISOString().slice(0, 10);
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }

$('#exp-pdf').addEventListener('click', async () => {
  const st = $('#exp-status'); st.textContent = 'Gerando o PDF...';
  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
    const months = monthsInScope(escopoSel());

    months.forEach((m, idx) => {
      if (idx > 0) doc.addPage();
      doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(35);
      doc.text(`Controle financeiro - ${monthLabel(m)}`, M, 50);
      const r = sums('receber', m), p = sums('pagar', m);
      doc.autoTable({
        startY: 66, margin: { left: M, right: M }, theme: 'grid', styles: { fontSize: 10, cellPadding: 6, lineColor: [225, 225, 225] },
        headStyles: { fillColor: [35, 35, 35], textColor: 255, halign: 'right' }, columnStyles: { 1: { halign: 'right' } },
        didParseCell: (d) => { if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left'; },
        head: [['Indicador', 'Valor']],
        body: [
          ['Total a receber', brl(r.total)], ['Recebido', brl(r.feito)], ['Pendente a receber', brl(r.pend)],
          ['Total a pagar', brl(p.total)], ['Pago', brl(p.feito)], ['Pendente a pagar', brl(p.pend)],
          ['Saldo realizado (recebido - pago)', brl(r.feito - p.feito)], ['Saldo previsto (a receber - a pagar)', brl(r.total - p.total)],
        ],
        tableWidth: 360,
      });
      for (const tipo of ['receber', 'pagar']) {
        const cols = state.schema[tipo], rows = monthRows(tipo, m);
        let y = doc.lastAutoTable.finalY + 28;
        if (y > H - 120) { doc.addPage(); y = 50; }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(TIPOS[tipo].titulo, M, y);
        const vi = cols.findIndex((c) => c.id === 'valor');
        const colStyles = {}; cols.forEach((c, i) => { if (c.tipo === 'moeda') colStyles[i] = { halign: 'right' }; });
        doc.autoTable({
          startY: y + 8, margin: { left: M, right: M }, theme: 'striped', styles: { fontSize: 9, cellPadding: 5 },
          headStyles: { fillColor: [35, 35, 35], textColor: 255 }, alternateRowStyles: { fillColor: [245, 245, 245] },
          footStyles: { fillColor: [161, 255, 203], textColor: 35, fontStyle: 'bold' }, columnStyles: colStyles,
          didParseCell: (d) => { if (d.section !== 'body' && colStyles[d.column.index]) d.cell.styles.halign = 'right'; },
          head: [cols.map((c) => c.nome)],
          body: rows.length ? rows.map((row) => cols.map((c) => cellText(c, row.v[c.id], tipo))) : [[{ content: 'Sem lançamentos neste mês.', colSpan: cols.length, styles: { textColor: 120 } }]],
          foot: rows.length ? [cols.map((c, i) => (i === 0 ? 'Total' : i === vi ? brl(sums(tipo, m).total) : ''))] : undefined,
        });
      }
    });
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120);
      doc.text(`Gerado em ${fmtDate(todayStr())}`, M, H - 20);
      doc.text(`Página ${i} de ${n}`, W - M, H - 20, { align: 'right' });
    }
    download(doc.output('blob'), `controle-financeiro-${escopoSel() === 'mes' ? state.month : 'completo'}-${stamp()}.pdf`);
    st.textContent = 'PDF gerado.';
  } catch (e) { console.error(e); st.textContent = 'Não foi possível gerar o PDF. Verifique a conexão e tente de novo.'; }
});

$('#exp-xlsx').addEventListener('click', async () => {
  const st = $('#exp-status'); st.textContent = 'Gerando o Excel...';
  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js');
    const wb = new window.ExcelJS.Workbook();
    wb.calcProperties.fullCalcOnLoad = true;
    const months = monthsInScope(escopoSel());
    const resumo = wb.addWorksheet('Resumo Financeiro');
    const sheets = {};
    const INK = 'FF232323', MINT = 'FFA1FFCB', GREY = 'FFF3F3F3';
    const headStyle = (row) => row.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } }; c.alignment = { vertical: 'middle', wrapText: true }; });

    for (const tipo of ['receber', 'pagar']) {
      const cols = state.schema[tipo];
      const ws = wb.addWorksheet(tipo === 'receber' ? 'Contas a Receber' : 'Contas a Pagar');
      ws.columns = [{ header: 'Mês', key: 'mes', width: 10 }, ...cols.map((c) => ({ header: c.nome, key: c.id, width: c.tipo === 'texto' ? 28 : 16 }))];
      headStyle(ws.getRow(1)); ws.views = [{ state: 'frozen', ySplit: 1 }];
      for (const m of months) for (const r of monthRows(tipo, m)) {
        const vals = { mes: shortMonth(m) };
        cols.forEach((c) => {
          const v = r.v[c.id];
          if (v == null || v === '') vals[c.id] = null;
          else if (c.tipo === 'data') { const [y, mm, d] = v.split('-').map(Number); vals[c.id] = new Date(Date.UTC(y, mm - 1, d)); }
          else if (c.tipo === 'status') vals[c.id] = v === 'feito' ? TIPOS[tipo].feito : 'Pendente';
          else vals[c.id] = v;
        });
        ws.addRow(vals);
      }
      cols.forEach((c, i) => {
        const col = ws.getColumn(i + 2);
        if (c.tipo === 'moeda') col.numFmt = '"R$" #,##0.00';
        if (c.tipo === 'data') col.numFmt = 'dd/mm/yyyy';
      });
      sheets[tipo] = { name: ws.name, valor: ws.getColumn(cols.findIndex((c) => c.id === 'valor') + 2).letter, status: ws.getColumn(cols.findIndex((c) => c.id === 'status') + 2).letter };
    }

    resumo.columns = [{ width: 14 }, ...Array(8).fill({ width: 20 })];
    resumo.addRow(['RESUMO FINANCEIRO']).font = { bold: true, size: 14 };
    resumo.addRow([]);
    const hdr = resumo.addRow(['Mês', 'Total a receber', 'Recebido', 'Pendente a receber', 'Total a pagar', 'Pago', 'Pendente a pagar', 'Saldo realizado', 'Saldo previsto']);
    headStyle(hdr);
    const f = (tipo, rowN, status) => {
      const s = sheets[tipo], rg = (c) => `'${s.name}'!$${c}$2:$${c}$5000`, mesRg = `'${s.name}'!$A$2:$A$5000`;
      return `SUMIFS(${rg(s.valor)},${mesRg},$A${rowN}${status ? `,${rg(s.status)},"${status}"` : ''})`;
    };
    const first = hdr.number + 1;
    months.forEach((m, i) => {
      const n = first + i;
      const row = resumo.addRow([shortMonth(m)]);
      row.getCell(2).value = { formula: f('receber', n) };
      row.getCell(3).value = { formula: f('receber', n, 'Recebido') };
      row.getCell(4).value = { formula: `B${n}-C${n}` };
      row.getCell(5).value = { formula: f('pagar', n) };
      row.getCell(6).value = { formula: f('pagar', n, 'Pago') };
      row.getCell(7).value = { formula: `E${n}-F${n}` };
      row.getCell(8).value = { formula: `C${n}-F${n}` };
      row.getCell(9).value = { formula: `B${n}-E${n}` };
    });
    if (months.length > 1) {
      const last = first + months.length - 1, n = last + 1;
      const row = resumo.addRow(['Total']);
      for (let c = 2; c <= 9; c++) { const L = String.fromCharCode(64 + c); row.getCell(c).value = { formula: `SUM(${L}${first}:${L}${last})` }; }
      row.font = { bold: true }; row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MINT } }; });
    }
    for (let r = hdr.number + 1; r <= resumo.rowCount; r++) for (let c = 2; c <= 9; c++) resumo.getCell(r, c).numFmt = '"R$" #,##0.00';
    resumo.getColumn(1).eachCell((c, r) => { if (r > hdr.number) c.fill = c.fill?.fgColor?.argb === MINT ? c.fill : { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } }; });

    const buf = await wb.xlsx.writeBuffer();
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `controle-financeiro-${escopoSel() === 'mes' ? state.month : 'completo'}-${stamp()}.xlsx`);
    st.textContent = 'Excel gerado.';
  } catch (e) { console.error(e); st.textContent = 'Não foi possível gerar o Excel. Verifique a conexão e tente de novo.'; }
});

/* ============ sessão ============ */
$('#btn-sessao').addEventListener('click', async () => {
  localStorage.removeItem('cf:modo');
  if (state.mode === 'cloud') await cloud.sb.auth.signOut();
  else showLogin();
});

function setupLogin() {
  const err = $('#auth-error'), form = $('#form-auth'), sb = cloud.sb;
  const showErr = (m) => { err.textContent = m; err.hidden = !m; };
  const campos = () => { const f = new FormData(form); return { email: String(f.get('email') || '').trim(), password: String(f.get('senha') || '') }; };
  if (!supabaseConfig.google) { $('#btn-google').hidden = true; $('#or-google').hidden = true; }
  $('#btn-google').addEventListener('click', async () => {
    showErr('');
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
    if (error) showErr(authMsg(error));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); showErr('');
    const { error } = await sb.auth.signInWithPassword(campos());
    if (error) showErr(authMsg(error));
  });
  $('#btn-criar').addEventListener('click', async () => {
    showErr('');
    const { data, error } = await sb.auth.signUp({ ...campos(), options: { emailRedirectTo: location.origin } });
    if (error) return showErr(authMsg(error));
    if (!data.session) toast('Enviamos um e-mail para confirmar a conta. Depois é só entrar.');
  });
  $('#btn-reset').addEventListener('click', async () => {
    const { email } = campos();
    if (!email) return showErr('Digite o seu e-mail acima para receber o link.');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    if (error) showErr(authMsg(error)); else { showErr(''); toast('Enviamos um link para redefinir a senha.'); }
  });
  $('#btn-local').addEventListener('click', () => { localStorage.setItem('cf:modo', 'local'); enterLocal(); });
}

async function boot() {
  loadPrefsLocal(); loadMeiLocal(); applyTheme();
  if (!supabaseConfig) { enterLocal(); return; }
  cloud = { sb: createClient(supabaseConfig.url, supabaseConfig.anonKey), user: null };
  setupLogin();
  cloud.sb.auth.onAuthStateChange((_evento, session) => {
    const u = session && session.user;
    if (u) {
      if (cloud.entrando === u.id) return;
      cloud.entrando = u.id;
      setTimeout(() => enterCloud(u), 0);
      return;
    }
    cloud.entrando = null;
    if (localStorage.getItem('cf:modo') === 'local') enterLocal();
    else { state.mode = null; state.uid = null; showLogin(); }
  });
}
boot();
