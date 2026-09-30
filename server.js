'use strict';
/*
 * esprit mode — carte de fidélité — v0.9.0
 * Règle : 1 € = 1 point ; carte pleine à 300 points = bon d'achat de 30 € valable 1 an (paramétrable).
 *
 * Variables d'environnement :
 *   DATABASE_URL    — base PostgreSQL (la même que la v0.8.3 : les données sont reprises telles quelles)
 *   ADMIN_PASSWORD  — mot de passe du compte « admin » (10 caractères min.). Obligatoire tant que le compte admin a encore son ancien code.
 *   ADMIN_USERNAME  (facultatif, défaut « admin »)
 *   MIGRATE_FROM_DATABASE_URL (facultatif) — ancienne base à recopier une seule fois si DATABASE_URL est une base neuve et vide
 *   PUBLIC_URL      (recommandé) — ex. https://esprit-mode.onrender.com
 *   TZ              (recommandé) — Europe/Paris
 *   BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME (facultatif) — envoi gratuit des e-mails d'offres via Brevo (300/jour)
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const VERSION = '1.2.2';
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000), HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : __dirname);
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('DATA_DIR:', e.message); }
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'esprit-mode-data.json');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 }) : null;

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const DAY = 86400000;
const SESSION_DAYS = 30;

/* ======================= Données ======================= */

const DEFAULT_SETTINGS = { points_per_euro: 1, threshold: 300, voucher_value_cents: 3000, voucher_validity_days: 365, auto_voucher: true, voucher_conditions: "Bon d'achat valable dans les deux boutiques esprit mode, en une seule fois." };
const DEFAULT_OPTIONS = {
  email_voucher: false,                 // e-mail « Carte pleine ! » à la création d'un bon
  email_expiry_reminder: false, reminder_days: 30,   // rappel avant expiration d'un bon
  birthday_suggested_points: 20, birthday_sellers_can_offer: false,
  birthday_auto_points: false, birthday_auto_email: false,
  levels_enabled: false, levels: [{ name: 'Essentielle', min: 0 }, { name: 'Élégante', min: 600 }, { name: 'Icône', min: 1500 }],
  welcome_bonus_enabled: false, welcome_bonus_points: 20,
  special_day_enabled: false, special_day_multiplier: 2, special_day_label: 'Journée spéciale',
  weekly_backup: false, backup_email: 'espritmode13@gmail.com'
};
const SEQ_KEYS = ['customers', 'purchases', 'users', 'rewards', 'redemptions', 'campaigns', 'loyalty_adjustments', 'vouchers', 'audit', 'videos', 'gift_cards'];
const STORES = ['Général de Gaulle', 'Clemenceau'];

function emptyDb() {
  return { customers: [], purchases: [], users: [], rewards: [], redemptions: [], loyalty_adjustments: [], campaigns: [], vouchers: [], sessions: [], audit: [], videos: [], gift_cards: [], email_log: {},
    settings: { ...DEFAULT_SETTINGS }, seq: Object.fromEntries(SEQ_KEYS.map(k => [k, 1])), migrations: {} };
}
function normalizeDb(x) {
  const base = emptyDb();
  const d = { ...base, ...(x || {}) };
  for (const k of Object.keys(base)) if (Array.isArray(base[k]) && !Array.isArray(d[k])) d[k] = [];
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  d.settings.options = { ...DEFAULT_OPTIONS, ...((d.settings && d.settings.options) || {}) };
  d.meta = d.meta || {};
  for (const k of ['cadeau', 'avoir']) { let n = (d.gift_cards || []).filter(g => g.kind === k).reduce((m, g) => Math.max(m, g.number || 0), 0); for (const g of (d.gift_cards || [])) if (g.kind === k && !g.number) g.number = ++n; }
  d.seq = { ...base.seq, ...(d.seq || {}) };
  d.migrations = d.migrations || {};
  d.email_log = d.email_log && typeof d.email_log === 'object' && !Array.isArray(d.email_log) ? d.email_log : {};
  for (const k of SEQ_KEYS) {
    const max = (d[k] || []).reduce((n, r) => Math.max(n, Number(r.id) || 0), 0);
    if (!(Number(d.seq[k]) > max)) d.seq[k] = max + 1;
  }
  return d;
}
let db = emptyDb();

async function loadDb() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const r = await pool.query('SELECT data FROM app_state WHERE id=1');
    if (!r.rows[0] && process.env.MIGRATE_FROM_DATABASE_URL) {
      const old = new Pool({ connectionString: process.env.MIGRATE_FROM_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 15000 });
      try {
        const o = await old.query('SELECT data FROM app_state WHERE id=1');
        if (o.rows[0]) { db = normalizeDb(o.rows[0].data); console.log(`Reprise de l'ancienne base : ${db.customers.length} clientes, ${db.purchases.length} achats.`); return; }
      } finally { await old.end().catch(() => {}); }
    }
    db = normalizeDb(r.rows[0] ? r.rows[0].data : null);
    return;
  }
  try { if (fs.existsSync(DB_FILE)) db = normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); else db = normalizeDb(null); }
  catch (e) { console.error('Lecture des données impossible :', e.message); throw e; }
}
async function writeNow() {
  const json = JSON.stringify(db);
  if (pool) {
    await pool.query('INSERT INTO app_state(id,data,updated_at) VALUES(1,$1::jsonb,now()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', [json]);
  } else {
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, json);
    await fs.promises.rename(tmp, DB_FILE);
  }
}
// Écritures en file d'attente : jamais deux écritures en même temps, toujours dans l'ordre.
let writeChain = Promise.resolve();
function persist() {
  const p = writeChain.then(writeNow);
  writeChain = p.catch(() => {});
  return p;
}

/* ======================= Utilitaires ======================= */

const nowIso = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
function nextId(t) { return db.seq[t]++; }
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
function hashPw(p) { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(String(p), salt, 64).toString('hex')}`; }
const isLegacy = h => /^[a-f0-9]{64}$/.test(String(h || ''));
function checkPw(p, stored) {
  // Les anciens codes (v0.8.x) étaient écrits dans le code public : ils ne sont plus acceptés.
  if (!stored || !String(stored).startsWith('scrypt$')) return false;
  const [, salt, h] = String(stored).split('$');
  const a = crypto.scryptSync(String(p), salt, 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normPhone(t) { let d = String(t || '').replace(/[^\d+]/g, ''); if (d.startsWith('+33')) d = '0' + d.slice(3); else if (d.startsWith('0033')) d = '0' + d.slice(4); return d.replace(/\D/g, ''); }
function validPhone(d) { return d.startsWith('0') ? d.length === 10 : d.length >= 8 && d.length <= 15; }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
const clean = (s, max = 120) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : ''; }
let LAST_BASE = 'https://esprit-mode.onrender.com';
function baseUrl(req) { if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, ''); if (!req) return LAST_BASE; return `${req.protocol}://${req.get('host')}`.replace(/\/$/, ''); }
function cardUrl(c, req) { return `${baseUrl(req)}/carte.html?token=${encodeURIComponent(c.public_token)}`; }
function audit(user, action, detail) {
  db.audit.push({ id: nextId('audit'), at: nowIso(), by: user ? user.username : 'public', action, detail: String(detail || '').slice(0, 300) });
  if (db.audit.length > 3000) db.audit.splice(0, db.audit.length - 3000);
}
const S = () => db.settings;
const O = () => db.settings.options || DEFAULT_OPTIONS;
function voucherStatus(v) {
  if (v.status === 'used' || v.status === 'cancelled') return v.status;
  return new Date(v.expires_at).getTime() < Date.now() ? 'expired' : 'active';
}
function activeVouchers(cid) { return db.vouchers.filter(v => v.customer_id === cid && voucherStatus(v) === 'active'); }
function pointsForCents(cents, noBonus) { const mult = !noBonus && O().special_day_enabled ? Math.max(1, Number(O().special_day_multiplier) || 1) : 1; return Math.max(0, Math.floor((cents / 100) * Number(S().points_per_euro || 1) * mult)); }
function createVoucher(c, user) {
  const s = S();
  const v = { id: nextId('vouchers'), customer_id: c.id, value_cents: s.voucher_value_cents, points_used: s.threshold, created_at: nowIso(),
    expires_at: new Date(Date.now() + s.voucher_validity_days * DAY).toISOString(), status: 'active', used_at: null, used_by: null, created_by: user ? user.username : 'auto' };
  db.vouchers.push(v); c.points -= s.threshold;
  if (O().email_voucher) setTimeout(() => sendVoucherEmail(c, v), 300);
  return v;
}
function autoVouchers(c, user) {
  const made = [];
  if (!S().auto_voucher) return made;
  while (c.points >= S().threshold && made.length < 20) made.push(createVoucher(c, user));
  return made;
}
function publicVoucher(v) { return { id: v.id, value: v.value_cents / 100, created_at: v.created_at, expires_at: v.expires_at, status: voucherStatus(v), used_at: v.used_at }; }
function readCustomerInput(x, { requireEmail }) {
  const d = {
    first_name: clean(x.first_name, 60), last_name: clean(x.last_name, 60), phone: normPhone(x.phone), email: clean(x.email, 120).toLowerCase(),
    birth_date: validDate(x.birth_date), address: clean(x.address, 160), postal_code: clean(x.postal_code, 10), city: clean(x.city, 60),
    marketing_email: !!x.marketing_email, marketing_sms: !!x.marketing_sms
  };
  if (!d.first_name || !d.last_name) bad('Le prénom et le nom sont obligatoires.');
  if (!validPhone(d.phone)) bad('Le numéro de téléphone doit comporter 10 chiffres, par exemple 06 12 34 56 78.');
  if (requireEmail && !d.email) bad("L'adresse e-mail est obligatoire.");
  if (d.email && !validEmail(d.email)) bad("L'adresse e-mail semble incomplète.");
  if (d.marketing_email && !d.email) bad('Une adresse e-mail est nécessaire pour recevoir les offres par e-mail.');
  return d;
}
function phoneTaken(phone, exceptId) { return db.customers.some(c => c.phone === phone && c.id !== exceptId && !c.deleted); }
function applyConsents(c, d) {
  const t = nowIso();
  if (d.marketing_email !== !!c.marketing_email) { c.marketing_email = d.marketing_email; c.marketing_email_at = t; }
  if (d.marketing_sms !== !!c.marketing_sms) { c.marketing_sms = d.marketing_sms; c.marketing_sms_at = t; }
}
function spentEuros(cid) { return db.purchases.filter(p => p.customer_id === cid && !p.cancelled).reduce((n, p) => n + p.amount_cents, 0) / 100; }
function levelOf(c) {
  if (!O().levels_enabled) return null;
  const lv = [...(O().levels || [])].filter(l => l.name).sort((a, b) => a.min - b.min); if (!lv.length) return null;
  const spent = spentEuros(c.id); let cur = lv[0];
  for (const l of lv) if (spent >= l.min) cur = l;
  const next = lv.find(l => l.min > spent);
  return { name: cur.name, spent, next: next ? { name: next.name, remaining: Math.ceil(next.min - spent) } : null };
}
function mmdd(d) { return String(d || '').slice(5, 10); }
function birthdayIn(c, days) {
  if (!c.birth_date || !/^\d{4}-\d{2}-\d{2}$/.test(c.birth_date)) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  for (let i = 0; i <= days; i++) { const x = new Date(t); x.setDate(t.getDate() + i); if (x.toLocaleDateString('fr-CA').slice(5) === mmdd(c.birth_date)) return i; }
  return null;
}
function birthdayGivenThisYear(c) { const tag = 'Bonus anniversaire ' + new Date().getFullYear(); return db.loyalty_adjustments.some(a => a.customer_id === c.id && a.reason === tag); }
function customerSummary(c) {
  const p = db.purchases.filter(x => x.customer_id === c.id && !x.cancelled);
  return { id: c.id, first_name: c.first_name, last_name: c.last_name, phone: c.phone, email: c.email, points: c.points,
    vouchers: activeVouchers(c.id).length, last_purchase: p.reduce((m, x) => x.created_at > m ? x.created_at : m, '') || null,
    deletion_requested: !!c.deletion_requested_at, created_at: c.created_at };
}
const liveCustomers = () => db.customers.filter(c => !c.deleted);

/* ======================= Limites d'essais ======================= */

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const h = hits.get(key);
  if (!h || now - h.t > windowMs) { hits.set(key, { n: 1, t: now }); return false; }
  h.n++; return h.n > max;
}
function isBlocked(key, max, windowMs) { const h = hits.get(key); return !!h && Date.now() - h.t <= windowMs && h.n >= max; }
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 3600000) hits.delete(k); }, 600000).unref();

/* ======================= Démarrage ======================= */

async function bootstrap() {
  await loadDb();
  // Comptes : ceux de la v0.8.3 sont conservés tels quels (mêmes identifiants, mêmes mots de passe).
  let admin = db.users.find(u => String(u.username).toLowerCase() === ADMIN_USERNAME);
  if (ADMIN_PASSWORD) {
    if (ADMIN_PASSWORD.length < 10) console.warn('ADMIN_PASSWORD ignoré : 10 caractères minimum.');
    else if (!admin) { admin = { id: nextId('users'), username: ADMIN_USERNAME, display_name: 'Élie', role: 'admin', active: true, password_hash: hashPw(ADMIN_PASSWORD), created_at: nowIso() }; db.users.push(admin); }
    else { admin.role = 'admin'; admin.active = true; if (!checkPw(ADMIN_PASSWORD, admin.password_hash)) { admin.password_hash = hashPw(ADMIN_PASSWORD); admin.weak = false; } }
  }
  if (!db.users.some(u => u.role === 'admin' && u.active !== false && String(u.password_hash || '').startsWith('scrypt$'))) {
    console.error('ERREUR : ajoutez la variable ADMIN_PASSWORD (10 caractères minimum) dans Render > Environment, puis redéployez.');
    process.exit(1);
  }
  if (!db.migrations.v09) {
    // Comptes conservés (identifiants, rôles, historique) ; seuls les anciens codes, rendus publics, sont désactivés.
    for (const u of db.users) { if (u.active === undefined) u.active = true; if (isLegacy(u.password_hash)) { u.password_hash = ''; u.needs_reset = true; } }
    for (const r of db.rewards) r.active = 0; // l'ancienne récompense « 100 points = 10 € » est remplacée par la règle de la carte
    db.settings = { ...DEFAULT_SETTINGS, points_per_euro: Number(db.settings.points_per_euro) || 1 };
    for (const c of db.customers) { c.phone = normPhone(c.phone); c.points = Number(c.points) || 0; }
    db.migrations.v09 = nowIso();
  }
  db.sessions = db.sessions.filter(s => s.expires > Date.now());
  await persist();
}

/* ======================= Middlewares ======================= */

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use((req, res, next) => { const h = String((req.get && req.get('host')) || ''); if (!process.env.PUBLIC_URL && h && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(h)) LAST_BASE = `${req.protocol}://${h}`; next(); });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function auth(req, res, next) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Connexion requise' });
  const s = db.sessions.find(x => x.hash === sha(h.slice(7)) && x.expires > Date.now());
  const user = s && db.users.find(u => u.id === s.user_id && u.active !== false);
  if (!user) return res.status(401).json({ error: 'Session expirée : reconnectez-vous.' });
  req.user = { id: user.id, username: user.username, role: user.role, display_name: user.display_name || user.username };
  req.sessionHash = s.hash;
  next();
}
function allow(...roles) { return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Accès non autorisé' }); }
const adminOnly = allow('admin'), managerOnly = allow('admin', 'manager'), salesOnly = allow('admin', 'manager', 'seller');

// Enveloppe : validation → modification → enregistrement confirmé → réponse
function tx(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (res.headersSent) return;
      await persist();
      res.json(out === undefined ? { ok: true } : out);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error('Erreur :', e);
      if (!res.headersSent) res.status(503).json({ error: "L'enregistrement n'a pas pu être confirmé. Vérifiez l'historique avant de recommencer." });
    }
  };
}
function read(fn) {
  return (req, res) => {
    try { res.json(fn(req, res)); }
    catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message }); console.error(e); res.status(500).json({ error: 'Erreur inattendue.' }); }
  };
}

/* ======================= Public ======================= */

app.get('/health', (q, s) => s.json({ ok: true, service: 'esprit-mode', version: VERSION, storage: pool ? 'postgres' : 'file' }));

app.get('/api/public/config', (req, res) => res.json({
  brand: 'esprit mode', app_url: baseUrl(req), phone: 'Michelle : 06 62 55 24 87',
  stores: [{ name: 'Boutique 1', address: '59 avenue du Général de Gaulle', postal_code: '94700', city: 'Maisons-Alfort' },
    { name: 'Boutique 2', address: '47 avenue Georges Clemenceau', postal_code: '94700', city: 'Maisons-Alfort' }],
  rule: { points_per_euro: S().points_per_euro, threshold: S().threshold, voucher_value: S().voucher_value_cents / 100, validity_days: S().voucher_validity_days }
}));
const SOCIAL = { instagram: 'https://www.instagram.com/channel/AbaNU8DS6tgq9Eq6/', facebook: 'https://www.facebook.com/share/v/1Dn4Wx3Ww8/' };
app.get('/api/public/social-qr/:network', async (req, res) => {
  const url = SOCIAL[req.params.network]; if (!url) return res.status(404).end();
  try { res.type('png').send(await QRCode.toBuffer(url, { width: 360, margin: 2 })); } catch (e) { res.status(500).end(); }
});
app.get('/api/public/app-qr', async (req, res) => {
  try { res.type('png').send(await QRCode.toBuffer(baseUrl(req) + '/', { width: 520, margin: 2 })); } catch (e) { res.status(500).end(); }
});
// Manifeste personnel : l'icône installée depuis la carte ouvre directement la carte de la cliente
app.get('/api/public/manifest/:token', (req, res) => {
  const c = db.customers.find(x => x.public_token === req.params.token && !x.deleted);
  const icons = [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }];
  res.set('Content-Type', 'application/manifest+json; charset=utf-8').send(JSON.stringify({
    name: 'esprit mode', short_name: 'esprit mode', description: 'Ma carte de fidélité esprit mode', id: '/carte',
    start_url: c ? `/carte.html?token=${encodeURIComponent(c.public_token)}` : '/', scope: '/', display: 'standalone',
    background_color: '#465157', theme_color: '#465157', icons }));
});
app.get('/api/public/qr/:token', async (req, res) => {
  const c = db.customers.find(x => x.public_token === req.params.token && !x.deleted); if (!c) return res.status(404).end();
  try { res.type('png').send(await QRCode.toBuffer(cardUrl(c, req), { width: 320, margin: 2 })); } catch (e) { res.status(500).end(); }
});

app.post('/api/public/register', tx(req => {
  if (limited('reg:' + req.ip, 10, 3600000)) bad('Trop d’inscriptions depuis cet appareil. Réessayez plus tard ou demandez en boutique.', 429);
  const x = req.body || {};
  const d = readCustomerInput(x, { requireEmail: true });
  if (!x.terms_accepted) bad('Vous devez accepter les conditions et la politique de confidentialité.');
  if (phoneTaken(d.phone)) bad('Ce numéro de téléphone a déjà une carte. Demandez votre lien en boutique.', 409);
  const t = nowIso();
  const c = { id: nextId('customers'), ...d, marketing_email_at: d.marketing_email ? t : null, marketing_sms_at: d.marketing_sms ? t : null,
    terms_accepted_at: t, points: 0, public_token: newToken(), created_at: t, source: 'cliente' };
  db.customers.push(c);
  applyWelcomeBonus(c, null);
  setTimeout(() => sendWelcome(c, req), 500);
  return { token: c.public_token };
}));

function customerByToken(token) {
  const c = db.customers.find(x => x.public_token === token && !x.deleted);
  if (!c) bad('Carte introuvable', 404);
  return c;
}
app.get('/api/public/customer/token/:token', read(req => {
  const c = customerByToken(req.params.token);
  return {
    customer: { first_name: c.first_name, last_name: c.last_name, phone: c.phone, email: c.email, birth_date: c.birth_date, address: c.address,
      postal_code: c.postal_code, city: c.city, marketing_email: !!c.marketing_email, marketing_sms: !!c.marketing_sms, points: c.points,
      created_at: c.created_at, deletion_requested: !!c.deletion_requested_at },
    rule: { threshold: S().threshold, voucher_value: S().voucher_value_cents / 100, validity_days: S().voucher_validity_days, points_per_euro: S().points_per_euro, conditions: S().voucher_conditions || '' },
    redemptions: db.redemptions.filter(r => r.customer_id === c.id).map(r => ({ created_at: r.created_at, points_used: r.points_used, value: (r.value_cents || 0) / 100 })),
    level: levelOf(c), special_day: O().special_day_enabled ? { label: O().special_day_label, multiplier: O().special_day_multiplier } : null,
    vouchers: db.vouchers.filter(v => v.customer_id === c.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10).map(publicVoucher),
    history: db.purchases.filter(x => x.customer_id === c.id && !x.cancelled).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20)
      .map(x => ({ created_at: x.created_at, amount: x.amount_cents / 100, points: x.points }))
  };
}));
app.put('/api/public/customer/token/:token', tx(req => {
  if (limited('upd:' + req.ip, 30, 3600000)) bad('Trop de modifications. Réessayez plus tard.', 429);
  const c = customerByToken(req.params.token);
  const d = readCustomerInput(req.body || {}, { requireEmail: true });
  if (phoneTaken(d.phone, c.id)) bad('Ce numéro est déjà utilisé par une autre carte.', 409);
  for (const k of ['first_name', 'last_name', 'phone', 'email', 'birth_date', 'address', 'postal_code', 'city']) c[k] = d[k];
  applyConsents(c, d);
  return { ok: true };
}));
app.post('/api/public/customer/token/:token/delete-request', tx(req => {
  const c = customerByToken(req.params.token);
  c.deletion_requested_at = nowIso(); c.marketing_email = false; c.marketing_sms = false; c.marketing_email_at = c.marketing_sms_at = nowIso();
  audit(null, 'demande_suppression', `${c.first_name} ${c.last_name}`);
}));
app.get('/desinscription', async (req, res) => {
  const c = db.customers.find(x => x.public_token === String(req.query.token || '') && !x.deleted);
  let msg = 'Lien inconnu.';
  if (c) { c.marketing_email = false; c.marketing_email_at = nowIso(); try { await persist(); msg = "C'est noté : vous ne recevrez plus les offres d'esprit mode par e-mail."; } catch (e) { msg = 'Une erreur est survenue, réessayez plus tard.'; } }
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>esprit mode</title><body style="font-family:system-ui;background:#f7f3ee;padding:40px 20px;text-align:center"><h1 style="font-weight:500;letter-spacing:.08em">esprit mode</h1><p>${msg}</p></body>`);
});

/* ======================= Connexion équipe ======================= */

app.post('/api/login', tx(req => {
  const u = String((req.body || {}).username || '').trim().toLowerCase(), p = String((req.body || {}).password || '');
  const kIp = 'login-ip:' + req.ip, kU = 'login-u:' + u;
  if (isBlocked(kIp, 20, 900000) || isBlocked(kU, 5, 900000)) bad('Trop d’essais. Réessayez dans 15 minutes.', 429);
  const user = db.users.find(x => String(x.username).toLowerCase() === u && x.active !== false);
  if (!user || !checkPw(p, user.password_hash)) {
    limited(kIp, 20, 900000); limited(kU, 5, 900000);
    if (user && user.needs_reset) bad("Ce compte attend un nouveau mot de passe : Élie le définit dans Administration > Équipe.", 401);
    bad('Identifiants incorrects', 401);
  }
  hits.delete(kU);
  const token = newToken();
  db.sessions = db.sessions.filter(s => s.expires > Date.now());
  db.sessions.push({ hash: sha(token), user_id: user.id, created_at: nowIso(), expires: Date.now() + SESSION_DAYS * DAY });
  return { token, role: user.role, display_name: user.display_name || user.username };
}));
app.post('/api/logout', auth, tx(req => { db.sessions = db.sessions.filter(s => s.hash !== req.sessionHash); }));
app.get('/api/me', auth, (req, res) => { const u = db.users.find(x => x.id === req.user.id); res.json({ ...req.user, weak: !!(u && u.weak), admin_env: req.user.username === ADMIN_USERNAME && ADMIN_PASSWORD.length >= 10 }); });
app.post('/api/me/password', auth, tx(req => {
  const u = db.users.find(x => x.id === req.user.id);
  const { current, password } = req.body || {};
  if (!checkPw(current, u.password_hash)) bad('Mot de passe actuel incorrect.');
  if (String(password || '').length < 8) bad('Le nouveau mot de passe doit contenir au moins 8 caractères.');
  if (u.username === ADMIN_USERNAME && ADMIN_PASSWORD.length >= 10) bad('Ce mot de passe est fixé dans Render (variable ADMIN_PASSWORD) : changez-le là-bas.');
  u.password_hash = hashPw(password); u.weak = false;
  db.sessions = db.sessions.filter(s => s.user_id !== u.id || s.hash === req.sessionHash);
}));

/* ======================= Utilisateurs (admin) ======================= */

const ROLES = ['admin', 'manager', 'seller'];
app.get('/api/users', auth, adminOnly, read(() => db.users.map(u => ({ id: u.id, username: u.username, role: u.role, display_name: u.display_name || u.username,
  active: u.active !== false, needs_reset: !!u.needs_reset, weak: !!u.weak, protected: u.username === ADMIN_USERNAME }))));
app.post('/api/users', auth, adminOnly, tx(req => {
  const x = req.body || {};
  const username = clean(x.username, 40).toLowerCase(), password = String(x.password || ''), role = x.role;
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) bad('Identifiant : 3 à 40 caractères, lettres, chiffres, point ou tiret.');
  if (password.length < 8) bad('Le mot de passe doit contenir au moins 8 caractères.');
  if (!ROLES.includes(role)) bad('Rôle invalide.');
  if (db.users.some(u => String(u.username).toLowerCase() === username)) bad('Cet identifiant existe déjà.', 409);
  db.users.push({ id: nextId('users'), username, password_hash: hashPw(password), role, display_name: clean(x.display_name, 40) || username, active: true, created_at: nowIso() });
  audit(req.user, 'creation_utilisateur', username + ' (' + role + ')');
}));
app.put('/api/users/:id', auth, adminOnly, tx(req => {
  const u = db.users.find(x => x.id === Number(req.params.id)); if (!u) bad('Utilisateur introuvable.', 404);
  const x = req.body || {};
  if (u.username === ADMIN_USERNAME && (x.active === false || (x.role && x.role !== 'admin'))) bad('Le compte administrateur principal ne peut pas être désactivé.');
  if (x.display_name !== undefined) u.display_name = clean(x.display_name, 40) || u.username;
  if (x.role !== undefined) { if (!ROLES.includes(x.role)) bad('Rôle invalide.'); u.role = x.role; }
  if (x.active !== undefined) u.active = !!x.active;
  if (x.password) {
    if (u.username === ADMIN_USERNAME) bad('Le mot de passe du compte principal se change dans « Mon mot de passe ».');
    if (String(x.password).length < 8) bad('Le mot de passe doit contenir au moins 8 caractères.');
    u.password_hash = hashPw(x.password); u.weak = false; u.needs_reset = false;
  }
  if (x.password || x.active === false || x.role !== undefined) db.sessions = db.sessions.filter(s => s.user_id !== u.id);
  audit(req.user, 'modification_utilisateur', u.username);
}));
app.delete('/api/users/:id', auth, adminOnly, tx(req => {
  const u = db.users.find(x => x.id === Number(req.params.id)); if (!u) bad('Utilisateur introuvable.', 404);
  if (u.username === ADMIN_USERNAME || u.id === req.user.id) bad('Ce compte ne peut pas être supprimé.');
  db.users = db.users.filter(x => x !== u); db.sessions = db.sessions.filter(s => s.user_id !== u.id);
  audit(req.user, 'suppression_utilisateur', u.username);
}));

/* ======================= Clientes ======================= */

app.get('/api/customers', auth, salesOnly, read(req => {
  const q = String(req.query.q || '').trim().toLowerCase(); const digits = q.replace(/\D/g, '');
  let a = liveCustomers();
  if (q) a = a.filter(c => (digits.length >= 2 && /^[\d\s.+-]+$/.test(q) && c.phone.includes(normPhone(q))) ||
    [c.first_name, c.last_name, c.email, `${c.first_name} ${c.last_name}`].some(v => String(v || '').toLowerCase().includes(q)));
  return a.sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 100).map(customerSummary);
}));
app.post('/api/customers', auth, salesOnly, tx(req => {
  const x = req.body || {};
  const d = readCustomerInput(x, { requireEmail: true });
  if (!x.terms_accepted) bad('La cliente doit accepter les conditions et la politique de confidentialité.');
  if (phoneTaken(d.phone)) bad('Ce numéro appartient déjà à une cliente.', 409);
  const t = nowIso();
  const c = { id: nextId('customers'), ...d, marketing_email_at: d.marketing_email ? t : null, marketing_sms_at: d.marketing_sms ? t : null,
    terms_accepted_at: t, points: 0, public_token: newToken(), created_at: t, source: 'boutique', created_by: req.user.username };
  db.customers.push(c);
  applyWelcomeBonus(c, null);
  setTimeout(() => sendWelcome(c, req), 500);
  return customerSummary(c);
}));
function customerById(id) { const c = db.customers.find(x => x.id === Number(id) && !x.deleted); if (!c) bad('Cliente introuvable', 404); return c; }
app.get('/api/customers/:id/profile', auth, salesOnly, read(req => {
  const c = customerById(req.params.id);
  const purchases = db.purchases.filter(x => x.customer_id === c.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const live = purchases.filter(x => !x.cancelled);
  return {
    customer: { id: c.id, first_name: c.first_name, last_name: c.last_name, phone: c.phone, email: c.email, birth_date: c.birth_date, address: c.address,
      postal_code: c.postal_code, city: c.city, marketing_email: !!c.marketing_email, marketing_email_at: c.marketing_email_at, marketing_sms: !!c.marketing_sms,
      marketing_sms_at: c.marketing_sms_at, terms_accepted_at: c.terms_accepted_at, created_at: c.created_at, points: c.points, deletion_requested_at: c.deletion_requested_at || null },
    card_url: cardUrl(c, req),
    stats: { purchases: live.length, total_euros: live.reduce((n, x) => n + x.amount_cents, 0) / 100, points: c.points, last_purchase: live[0] ? live[0].created_at : null,
      remaining: Math.max(0, S().threshold - c.points),
      avg_basket: live.length ? Math.round(live.reduce((n, x) => n + x.amount_cents, 0) / live.length) / 100 : 0,
      frequency_days: live.length > 1 ? Math.round((new Date(live[0].created_at) - new Date(live[live.length - 1].created_at)) / DAY / (live.length - 1)) : null,
      last_store: (live[0] && live[0].store) || '' },
    level: levelOf(c),
    birthday: { in_days: birthdayIn(c, 7), given_this_year: birthdayGivenThisYear(c) },
    purchases: purchases.map(x => ({ id: x.id, created_at: x.created_at, amount: x.amount_cents / 100, points: x.points, by_user: x.by_user, store: x.store || '', cancelled: !!x.cancelled })),
    vouchers: db.vouchers.filter(v => v.customer_id === c.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(publicVoucher),
    adjustments: db.loyalty_adjustments.filter(a => a.customer_id === c.id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    redemptions: db.redemptions.filter(r => r.customer_id === c.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(r => ({ created_at: r.created_at, points_used: r.points_used, value: (r.value_cents || 0) / 100, by_user: r.by_user, name: (db.rewards.find(w => w.id === r.reward_id) || {}).name || 'Récompense' }))
  };
}));
app.put('/api/customers/:id', auth, managerOnly, tx(req => {
  const c = customerById(req.params.id);
  const d = readCustomerInput(req.body || {}, { requireEmail: true });
  if (phoneTaken(d.phone, c.id)) bad('Ce numéro est déjà utilisé par une autre cliente.', 409);
  for (const k of ['first_name', 'last_name', 'phone', 'email', 'birth_date', 'address', 'postal_code', 'city']) c[k] = d[k];
  applyConsents(c, d);
  return customerSummary(c);
}));
app.delete('/api/customers/:id', auth, adminOnly, tx(req => {
  const c = customerById(req.params.id);
  for (const p of db.purchases) if (p.customer_id === c.id) p.customer_id = null;
  for (const a of db.loyalty_adjustments) if (a.customer_id === c.id) a.customer_id = null;
  db.vouchers = db.vouchers.filter(v => v.customer_id !== c.id);
  db.customers = db.customers.filter(x => x !== c);
  audit(req.user, 'suppression_cliente', `${c.first_name} ${c.last_name}`);
}));
app.post('/api/customers/:id/loyalty', auth, managerOnly, tx(req => {
  const c = customerById(req.params.id);
  const delta = Math.trunc(Number((req.body || {}).delta)), reason = clean((req.body || {}).reason, 200);
  if (!Number.isFinite(delta) || delta === 0) bad('Variation de points invalide.');
  if (!reason) bad('Le motif est obligatoire.');
  if (c.points + delta < 0) bad('Le solde de points ne peut pas être négatif.');
  db.loyalty_adjustments.push({ id: nextId('loyalty_adjustments'), customer_id: c.id, delta, reason, created_at: nowIso(), by_user: req.user.username });
  c.points += delta;
  const made = autoVouchers(c, req.user);
  audit(req.user, 'ajustement_points', `${c.first_name} ${c.last_name} ${delta > 0 ? '+' : ''}${delta} (${reason})`);
  return { points: c.points, vouchers_created: made.map(publicVoucher) };
}));
app.post('/api/customers/:id/paper', auth, salesOnly, tx(req => {
  const c = customerById(req.params.id);
  const euros = Math.floor(Number((req.body || {}).amount));
  if (!(euros > 0) || euros > S().threshold) bad(`Indiquez le montant tamponné, entre 1 et ${S().threshold} €.`);
  const pts = pointsForCents(euros * 100);
  db.loyalty_adjustments.push({ id: nextId('loyalty_adjustments'), customer_id: c.id, delta: pts, reason: `Reprise de la carte papier (${euros} €)`, created_at: nowIso(), by_user: req.user.username });
  c.points += pts;
  const made = autoVouchers(c, req.user);
  return { points: c.points, vouchers_created: made.map(publicVoucher) };
}));

/* ======================= Achats et bons ======================= */

app.post('/api/purchases', auth, salesOnly, tx(req => {
  const x = req.body || {};
  const c = customerById(x.customer_id);
  const amount = Number(String(x.amount).replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 50000) bad('Montant invalide.');
  const ids = Array.isArray(x.voucher_ids) ? x.voucher_ids.map(Number) : [];
  const used = ids.map(id => db.vouchers.find(v => v.id === id && v.customer_id === c.id));
  if (used.some(v => !v || voucherStatus(v) !== 'active')) bad('Un des bons n’est plus utilisable. Rechargez la fiche.');
  const excl = x.excluded_amount === undefined || x.excluded_amount === '' ? 0 : Number(String(x.excluded_amount).replace(',', '.'));
  if (!Number.isFinite(excl) || excl < 0) bad('Montant soldé / en promotion invalide.');
  if (excl > amount + 0.001) bad('Le montant soldé / en promotion ne peut pas dépasser le montant payé.');
  const cents = Math.round(amount * 100), excluded_cents = Math.min(cents, Math.round(excl * 100)), points = pointsForCents(cents - excluded_cents), t = nowIso();
  for (const v of used) { v.status = 'used'; v.used_at = t; v.used_by = req.user.username; }
  const store = STORES.includes(x.store) ? x.store : '';
  const p = { id: nextId('purchases'), customer_id: c.id, amount_cents: cents, excluded_cents, points, created_at: t, by_user: req.user.username, store, vouchers_used: used.map(v => v.id) };
  db.purchases.push(p);
  c.points += points;
  const made = autoVouchers(c, req.user);
  return { id: p.id, points: c.points, added: points, excluded: excluded_cents / 100, vouchers_used: used.map(publicVoucher), vouchers_created: made.map(publicVoucher), first_name: c.first_name, last_name: c.last_name };
}));
app.post('/api/purchases/:id/cancel', auth, managerOnly, tx(req => {
  const p = db.purchases.find(x => x.id === Number(req.params.id)); if (!p || p.cancelled) bad('Achat introuvable ou déjà annulé.', 404);
  const c = p.customer_id ? db.customers.find(x => x.id === p.customer_id) : null;
  if (c && c.points - p.points < 0) bad('Impossible : ces points ont déjà servi à créer un bon. Annulez d’abord le bon correspondant.');
  if (c) c.points -= p.points;
  for (const id of p.vouchers_used || []) { const v = db.vouchers.find(x => x.id === id); if (v && v.status === 'used') { v.status = 'active'; v.used_at = null; v.used_by = null; } }
  p.cancelled = true; p.cancelled_at = nowIso(); p.cancelled_by = req.user.username;
  audit(req.user, 'annulation_achat', `#${p.id} ${(p.amount_cents / 100).toFixed(2)} €`);
  return { points: c ? c.points : null };
}));
app.get('/api/customers/:id/vouchers', auth, salesOnly, read(req => activeVouchers(customerById(req.params.id).id).map(publicVoucher)));
app.post('/api/customers/:id/vouchers', auth, managerOnly, tx(req => {
  const c = customerById(req.params.id);
  if (c.points < S().threshold) bad('La carte n’est pas encore pleine.');
  return publicVoucher(createVoucher(c, req.user));
}));
app.post('/api/vouchers/:id/use', auth, salesOnly, tx(req => {
  const v = db.vouchers.find(x => x.id === Number(req.params.id)); if (!v || voucherStatus(v) !== 'active') bad('Ce bon n’est plus utilisable.');
  v.status = 'used'; v.used_at = nowIso(); v.used_by = req.user.username;
  return publicVoucher(v);
}));
app.post('/api/vouchers/:id/cancel', auth, managerOnly, tx(req => {
  const v = db.vouchers.find(x => x.id === Number(req.params.id)); if (!v || voucherStatus(v) !== 'active') bad('Seul un bon non utilisé peut être annulé.');
  const c = db.customers.find(x => x.id === v.customer_id);
  v.status = 'cancelled'; if (c) c.points += v.points_used;
  audit(req.user, 'annulation_bon', `#${v.id}`);
  return { points: c ? c.points : null };
}));
app.get('/api/vouchers', auth, managerOnly, read(() => {
  const names = Object.fromEntries(db.customers.map(c => [c.id, c]));
  return db.vouchers.filter(v => voucherStatus(v) === 'active').sort((a, b) => a.expires_at.localeCompare(b.expires_at))
    .map(v => ({ ...publicVoucher(v), customer_id: v.customer_id, customer: names[v.customer_id] ? `${names[v.customer_id].first_name} ${names[v.customer_id].last_name}` : '' }));
}));

/* ======================= Tableau de bord et réglages ======================= */

app.get('/api/dashboard', auth, adminOnly, read(() => {
  const t = new Date(); const startToday = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const startWeek = startToday - ((t.getDay() + 6) % 7) * DAY, startMonth = new Date(t.getFullYear(), t.getMonth(), 1).getTime();
  const purchases = db.purchases.filter(x => !x.cancelled); const ts = x => new Date(x.created_at).getTime();
  const sum = from => purchases.filter(x => ts(x) >= from).reduce((n, x) => n + x.amount_cents, 0) / 100;
  const customers = liveCustomers();
  return {
    customers: customers.length, new_week: customers.filter(x => ts(x) >= startWeek).length, new_month: customers.filter(x => ts(x) >= startMonth).length,
    active_90: new Set(purchases.filter(x => ts(x) >= Date.now() - 90 * DAY).map(x => x.customer_id)).size,
    ca_today: sum(startToday), ca_week: sum(startWeek), ca_month: sum(startMonth),
    sales_today: purchases.filter(x => ts(x) >= startToday).length, sales_month: purchases.filter(x => ts(x) >= startMonth).length,
    points_distributed: purchases.reduce((n, x) => n + x.points, 0),
    vouchers_created: db.vouchers.filter(v => v.status !== 'cancelled').length, vouchers_used: db.vouchers.filter(v => v.status === 'used').length + db.redemptions.length,
    vouchers_active: db.vouchers.filter(v => voucherStatus(v) === 'active').length, vouchers_expired: db.vouchers.filter(v => voucherStatus(v) === 'expired').length,
    near_reward: customers.filter(c => c.points >= S().threshold - 50).length,
    birthdays_week: customers.filter(c => birthdayIn(c, 6) !== null).length,
    gifts_active: db.gift_cards.filter(g => giftStatus(g) === 'active').length, gifts_outstanding: db.gift_cards.filter(g => giftStatus(g) === 'active').reduce((n, g) => n + g.balance_cents, 0) / 100,
    by_store: [...STORES, ''].map(st => ({ store: st || 'Non précisée', ca_month: purchases.filter(x => (x.store || '') === st && ts(x) >= startMonth).reduce((n, x) => n + x.amount_cents, 0) / 100,
      sales_month: purchases.filter(x => (x.store || '') === st && ts(x) >= startMonth).length })).filter(r => r.store !== 'Non précisée' || r.sales_month > 0),
    deletion_requests: customers.filter(c => c.deletion_requested_at).map(c => ({ id: c.id, name: `${c.first_name} ${c.last_name}`, at: c.deletion_requested_at }))
  };
}));
app.get('/api/settings', auth, salesOnly, (req, res) => res.json({ ...S(), voucher_value: S().voucher_value_cents / 100, stores: STORES }));
app.post('/api/settings', auth, adminOnly, tx(req => {
  const x = req.body || {};
  const ppe = Number(x.points_per_euro), th = Math.floor(Number(x.threshold)), val = Number(x.voucher_value), days = Math.floor(Number(x.voucher_validity_days));
  if (!(ppe > 0 && ppe <= 100)) bad('Points par euro : entre 0,01 et 100.');
  if (!(th >= 10 && th <= 100000)) bad('Seuil de carte pleine invalide.');
  if (!(val > 0 && val <= 10000)) bad('Valeur du bon invalide.');
  if (!(days >= 1 && days <= 3650)) bad('Validité du bon : entre 1 et 3650 jours.');
  db.settings = { points_per_euro: ppe, threshold: th, voucher_value_cents: Math.round(val * 100), voucher_validity_days: days, auto_voucher: !!x.auto_voucher, voucher_conditions: clean(x.voucher_conditions, 300), options: O() };
  audit(req.user, 'reglages', JSON.stringify(db.settings));
  return { ...S(), voucher_value: S().voucher_value_cents / 100 };
}));
// Remise à zéro avant l'ouverture : efface l'historique d'essai (achats, bons, ajustements), garde clientes, équipe et réglages
app.post('/api/admin/reset', auth, adminOnly, tx(req => {
  const x = req.body || {};
  if (x.confirm !== 'EFFACER') bad('Tapez EFFACER en majuscules pour confirmer.');
  const n = { achats: db.purchases.length, bons: db.vouchers.length };
  db.purchases = []; db.vouchers = []; db.loyalty_adjustments = []; db.redemptions = [];
  for (const c of db.customers) c.points = 0;
  if (x.campaigns) { n.campagnes = db.campaigns.length; db.campaigns = []; }
  if (x.customers) { n.clientes = db.customers.length; db.customers = []; }
  if (x.gifts) { n.cheques = db.gift_cards.length; db.gift_cards = []; }
  db.email_log = {};
  audit(req.user, 'remise_a_zero', JSON.stringify(n));
  return n;
}));
/* ======================= Chèques cadeaux et avoirs ======================= */
const GIFT_KINDS = { cadeau: 'Chèque cadeau', avoir: 'Avoir' };
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newGiftCode() {
  for (;;) { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length];
    const code = `EM-${s.slice(0, 4)}-${s.slice(4)}`; if (!db.gift_cards.some(g => g.code === code)) return code; }
}
function giftStatus(g) {
  if (g.status === 'cancelled') return 'cancelled';
  if (g.balance_cents <= 0) return 'used';
  return new Date(g.expires_at).getTime() < Date.now() ? 'expired' : 'active';
}
function giftNumber(g) { return (g.kind === 'avoir' ? 'A-' : '') + String(g.number || 0).padStart(4, '0'); }
function giftUrl(g, req) { return `${baseUrl(req)}/cheque.html?t=${encodeURIComponent(g.token)}`; }
function publicGift(g) {
  return { kind: g.kind, kind_label: GIFT_KINDS[g.kind] || 'Chèque cadeau', number: g.number, number_label: giftNumber(g), code: g.code, amount: g.amount_cents / 100, balance: g.balance_cents / 100, expires_at: g.expires_at,
    recipient: g.recipient, from_name: g.from_name, note: g.kind === 'avoir' ? g.note : '', created_at: g.created_at, status: giftStatus(g) };
}
function staffGift(g, req) { return { id: g.id, ...publicGift(g), email: g.email, note: g.note, created_by: g.created_by, uses: g.uses || [], cancelled_at: g.cancelled_at || null, email_sent_at: g.email_sent_at || null, url: giftUrl(g, req), token: g.token }; }
function giftById(id) { const g = db.gift_cards.find(x => x.id === Number(id)); if (!g) bad('Chèque introuvable', 404); return g; }
function endOfDay(d) { const x = new Date(d + 'T23:59:59'); return isNaN(x) ? null : x; }
app.post('/api/gifts', auth, salesOnly, tx(req => {
  const x = req.body || {}; const kind = GIFT_KINDS[x.kind] ? x.kind : 'cadeau';
  const amount = Number(String(x.amount).replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) bad('Montant invalide (entre 1 et 5 000 €).');
  const exp = endOfDay(validDate(x.expires_on));
  if (!exp) bad("Indiquez la date de fin de validité.");
  if (exp.getTime() < Date.now()) bad('La date de fin de validité est déjà passée.');
  if (exp.getTime() > Date.now() + 3 * 366 * DAY) bad('Validité maximale : 3 ans.');
  const email = clean(x.email, 120).toLowerCase(); if (email && !validEmail(email)) bad("L'adresse e-mail semble incomplète.");
  const recipient = clean(x.recipient, 80); if (kind === 'avoir' && !recipient) bad("Indiquez au nom de quelle cliente est établi l'avoir.");
  const cents = Math.round(amount * 100);
  const number = db.gift_cards.filter(x => x.kind === kind).reduce((n, x) => Math.max(n, x.number || 0), 0) + 1;
  const g = { id: nextId('gift_cards'), kind, number, code: newGiftCode(), token: newToken(), amount_cents: cents, balance_cents: cents, recipient, from_name: clean(x.from_name, 80),
    email, note: clean(x.note, 200), store: STORES.includes(x.store) ? x.store : '', created_at: nowIso(), expires_at: exp.toISOString(), created_by: req.user.username, status: 'active', uses: [] };
  db.gift_cards.push(g);
  audit(req.user, kind === 'avoir' ? 'creation_avoir' : 'creation_cheque_cadeau', `n° ${giftNumber(g)} ${amount.toFixed(2)} €`);
  return staffGift(g, req);
}));
app.get('/api/gifts', auth, salesOnly, read(req => {
  const q = String(req.query.q || '').trim().toLowerCase(), st = String(req.query.status || '');
  let a = db.gift_cards.slice().sort((x, y) => y.created_at.localeCompare(x.created_at));
  if (q) a = a.filter(g => [g.code, giftNumber(g), g.recipient, g.from_name, g.email].some(v => String(v || '').toLowerCase().includes(q)));
  if (st) a = a.filter(g => giftStatus(g) === st);
  return a.slice(0, 200).map(g => staffGift(g, req));
}));
app.get('/api/gifts/lookup/:code', auth, salesOnly, read(req => {
  const raw = String(req.params.code || '').trim(); const tok = (raw.match(/t=([a-f0-9]{20,})/i) || [])[1];
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^EM/, '');
  // Recherche par lien / QR, par code de sécurité (EM-XXXX-XXXX) ou par numéro (0012 = chèque cadeau n° 12, A-0012 = avoir n° 12)
  const num = raw.match(/^\s*(A|AV|AVOIR)?\s*[-n°º#\s]*0*(\d{1,6})\s*$/i);
  const g = db.gift_cards.find(x => (tok && x.token === tok) || (code.length === 8 && x.code === `EM-${code.slice(0, 4)}-${code.slice(4)}`)) ||
    (num ? db.gift_cards.find(x => x.kind === (num[1] ? 'avoir' : 'cadeau') && x.number === Number(num[2])) : null);
  if (!g) bad('Aucun chèque cadeau ou avoir ne correspond à ce code.', 404);
  return staffGift(g, req);
}));
app.post('/api/gifts/:id/use', auth, salesOnly, tx(req => {
  const g = giftById(req.params.id); const st = giftStatus(g);
  if (st !== 'active') bad(st === 'expired' ? 'Ce chèque a expiré le ' + new Date(g.expires_at).toLocaleDateString('fr-FR') + '.' : st === 'used' ? 'Ce chèque a déjà été entièrement utilisé.' : 'Ce chèque a été annulé.');
  const amount = Number(String((req.body || {}).amount).replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) bad('Montant invalide.');
  const cents = Math.round(amount * 100); if (cents > g.balance_cents) bad(`Le montant dépasse le solde disponible (${(g.balance_cents / 100).toFixed(2).replace('.', ',')} €).`);
  g.balance_cents -= cents;
  g.uses.push({ at: nowIso(), amount: cents / 100, by: req.user.username, store: STORES.includes((req.body || {}).store) ? req.body.store : '' });
  audit(req.user, 'encaissement_cheque', `${g.code} ${(cents / 100).toFixed(2)} € (reste ${(g.balance_cents / 100).toFixed(2)} €)`);
  return staffGift(g, req);
}));
app.post('/api/gifts/:id/cancel', auth, managerOnly, tx(req => {
  const g = giftById(req.params.id); if (g.status === 'cancelled') bad('Déjà annulé.');
  g.status = 'cancelled'; g.cancelled_at = nowIso(); g.cancelled_by = req.user.username;
  audit(req.user, 'annulation_cheque', g.code);
  return staffGift(g, req);
}));
function giftMailHtml(g) {
  const url = giftUrl(g, null), label = GIFT_KINDS[g.kind] || 'Chèque cadeau', val = (g.amount_cents / 100).toLocaleString('fr-FR') + ' €';
  return `<div style="background:#f7f3ee;padding:24px 12px;font-family:Arial,sans-serif;color:#222"><div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:#465157;color:#fff;padding:22px;font-size:26px;letter-spacing:2px">esprit mode</div>
    <div style="padding:22px;font-size:16px;line-height:1.5">
    <p>Bonjour${g.recipient ? ' ' + eH(g.recipient) : ''},</p>
    <p>${g.kind === 'avoir' ? `Voici votre <b>avoir de ${val}</b> esprit mode.` : `Vous avez reçu un <b>chèque cadeau esprit mode de ${val}</b>${g.from_name ? ` de la part de <b>${eH(g.from_name)}</b>` : ''} !`}</p>
    <p>Il est valable jusqu'au <b>${new Date(g.expires_at).toLocaleDateString('fr-FR')}</b> dans nos deux boutiques. N° <b>${giftNumber(g)}</b> — code : <b style="letter-spacing:1px">${g.code}</b></p>
    <p><a href="${url}" style="display:inline-block;background:#465157;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none">Voir mon ${label.toLowerCase()}</a></p>
    <p style="font-size:13px;color:#697177">Présentez ce lien ou son QR code en boutique. Si le bouton ne répond pas : <a href="${url}" style="color:#465157;word-break:break-all">${url}</a></p></div>
    <div style="padding:16px 22px;font-size:12px;color:#697177;border-top:1px solid #e7ded6">esprit mode — 59 av. du Général de Gaulle et 47 av. Georges Clemenceau, 94700 Maisons-Alfort — Michelle : 06 62 55 24 87 — <a href="${baseUrl(null)}/conditions.html#cheques" style="color:#697177">Conditions</a></div></div></div>`;
}
app.post('/api/gifts/:id/email', auth, salesOnly, async (req, res) => {
  try {
    const g = giftById(req.params.id);
    const email = clean((req.body || {}).email || g.email, 120).toLowerCase();
    if (!email || !validEmail(email)) bad("Indiquez une adresse e-mail valide.");
    if (!brevoReady()) bad("L'envoi d'e-mails n'est pas activé.");
    if (emailsLeft() < 1) bad("Limite gratuite d'e-mails atteinte pour aujourd'hui. Réessayez demain.", 429);
    const label = GIFT_KINDS[g.kind] || 'Chèque cadeau';
    await brevoSend({ email, first_name: g.recipient || '', last_name: '' }, g.kind === 'avoir' ? `Votre avoir esprit mode de ${g.amount_cents / 100} €` : `Un chèque cadeau esprit mode de ${g.amount_cents / 100} € pour vous`, giftMailHtml(g));
    const k = todayKey(); db.email_log = { [k]: (Number(db.email_log[k]) || 0) + 1 };
    g.email = email; g.email_sent_at = nowIso(); audit(req.user, 'envoi_cheque', `${g.code} → ${email}`);
    await persist(); res.json(staffGift(g, req));
  } catch (e) {
    if (e instanceof HttpError) res.status(e.status).json({ error: e.message });
    else { console.error(e); res.status(502).json({ error: "L'e-mail n'a pas pu partir : " + e.message }); }
  }
});
app.get('/api/public/gift/:token', read(req => { const g = db.gift_cards.find(x => x.token === req.params.token); if (!g) bad('Chèque introuvable.', 404); return publicGift(g); }));
app.get('/api/public/gift-qr/:token', async (req, res) => {
  const g = db.gift_cards.find(x => x.token === req.params.token); if (!g) return res.status(404).end();
  try { res.type('png').send(await QRCode.toBuffer(giftUrl(g, req), { width: 320, margin: 1 })); } catch (e) { res.status(500).end(); }
});
app.get('/api/export/gifts.csv', auth, adminOnly, (req, res) => {
  audit(req.user, 'export_cheques', ''); persist().catch(() => {});
  sendCsv(res, 'esprit-mode-cheques-cadeaux-avoirs.csv', [['Type', 'Numéro', 'Code', 'Montant', 'Solde', 'Statut', 'Pour', 'De la part de / motif', 'Créé le', 'Par', 'Fin de validité', 'Encaissements'],
    ...db.gift_cards.map(g => [GIFT_KINDS[g.kind], giftNumber(g), g.code, (g.amount_cents / 100).toFixed(2).replace('.', ','), (g.balance_cents / 100).toFixed(2).replace('.', ','),
      { active: 'en cours', used: 'utilisé', expired: 'expiré', cancelled: 'annulé' }[giftStatus(g)], g.recipient, g.kind === 'avoir' ? g.note : g.from_name, g.created_at, g.created_by, g.expires_at,
      (g.uses || []).map(u => `${u.at.slice(0, 10)} ${u.amount} €`).join(' | ')])]);
});

/* ---- Options (Administration) ---- */
app.get('/api/options', auth, salesOnly, (req, res) => res.json({ ...O(), email_ready: brevoReady() }));
app.post('/api/options', auth, adminOnly, tx(req => {
  const x = req.body || {}; const o = { ...O() };
  for (const k of ['email_voucher', 'email_expiry_reminder', 'birthday_sellers_can_offer', 'birthday_auto_points', 'birthday_auto_email', 'levels_enabled', 'welcome_bonus_enabled', 'special_day_enabled', 'weekly_backup'])
    if (x[k] !== undefined) o[k] = !!x[k];
  const int = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  if (x.reminder_days !== undefined) o.reminder_days = int(x.reminder_days, 1, 180, 30);
  if (x.birthday_suggested_points !== undefined) o.birthday_suggested_points = int(x.birthday_suggested_points, 0, 1000, 20);
  if (x.welcome_bonus_points !== undefined) o.welcome_bonus_points = int(x.welcome_bonus_points, 0, 1000, 20);
  if (x.special_day_multiplier !== undefined) { const m = Number(String(x.special_day_multiplier).replace(',', '.')); o.special_day_multiplier = m >= 1 && m <= 10 ? m : 2; }
  if (x.special_day_label !== undefined) o.special_day_label = clean(x.special_day_label, 60) || 'Journée spéciale';
  if (x.backup_email !== undefined) { const e = clean(x.backup_email, 120).toLowerCase(); if (e && !validEmail(e)) bad("L'adresse de sauvegarde semble incomplète."); o.backup_email = e; }
  if (Array.isArray(x.levels)) {
    const lv = x.levels.map(l => ({ name: clean(l.name, 30), min: Math.max(0, Math.floor(Number(l.min) || 0)) })).filter(l => l.name).slice(0, 6);
    if (lv.length) { lv.sort((a, b) => a.min - b.min); lv[0].min = 0; o.levels = lv; }
  }
  db.settings.options = o;
  audit(req.user, 'options', JSON.stringify(o).slice(0, 280));
  return o;
}));
app.post('/api/admin/run-daily', auth, adminOnly, async (req, res) => { await runDaily(true); res.json({ ok: true }); });

/* ---- Anniversaires ---- */
app.get('/api/birthdays', auth, salesOnly, read(req => {
  const days = Math.min(31, Math.max(0, Number(req.query.days) || 7));
  return liveCustomers().map(c => ({ c, d: birthdayIn(c, days) })).filter(x => x.d !== null).sort((a, b) => a.d - b.d)
    .map(({ c, d }) => ({ id: c.id, first_name: c.first_name, last_name: c.last_name, phone: c.phone, birth_date: c.birth_date, in_days: d, given_this_year: birthdayGivenThisYear(c), points: c.points }));
}));
app.post('/api/customers/:id/birthday-bonus', auth, salesOnly, tx(req => {
  if (req.user.role === 'seller' && !O().birthday_sellers_can_offer) bad("Le bonus d'anniversaire est offert par Michelle ou l'administrateur.", 403);
  const c = customerById(req.params.id);
  const pts = Math.floor(Number((req.body || {}).points));
  if (!(pts > 0 && pts <= 1000)) bad('Indiquez un nombre de points entre 1 et 1000.');
  if (birthdayIn(c, 31) === null && !c.birth_date) bad("Sa date de naissance n'est pas renseignée : complétez sa fiche d'abord.");
  if (birthdayGivenThisYear(c)) bad("Le bonus d'anniversaire a déjà été offert cette année.");
  const made = giveBirthdayBonus(c, pts, req.user);
  audit(req.user, 'bonus_anniversaire', `${c.first_name} ${c.last_name} +${pts}`);
  return { points: c.points, vouchers_created: made.map(publicVoucher) };
}));

/* ---- Scan du QR code de la carte en caisse ---- */
app.get('/api/customers/by-token/:token', auth, salesOnly, read(req => {
  const c = db.customers.find(x => x.public_token === req.params.token && !x.deleted); if (!c) bad('Carte inconnue.', 404);
  return { id: c.id };
}));

/* ---- Import de clientes existantes (Administration) ---- */
function parseDateFr(s) { s = String(s || '').trim(); let m; if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`; return ''; }
app.post('/api/import', auth, adminOnly, tx(req => {
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows.slice(0, 5000) : []; const confirm = !!(req.body || {}).confirm;
  const seen = new Set(liveCustomers().map(c => c.phone)); const ok = [], dup = [], bad_ = [];
  for (const r of rows) {
    const d = { first_name: clean(r.first_name, 60), last_name: clean(r.last_name, 60), phone: normPhone(r.phone), email: clean(r.email, 120).toLowerCase(),
      birth_date: parseDateFr(r.birth_date), postal_code: clean(r.postal_code, 10), city: clean(r.city, 60), address: clean(r.address, 160),
      points: Math.max(0, Math.floor(Number(r.points) || 0)) };
    if (!d.last_name || !validPhone(d.phone) || (d.email && !validEmail(d.email))) { bad_.push(d); continue; }
    if (seen.has(d.phone)) { dup.push(`${d.first_name} ${d.last_name}`); continue; }
    seen.add(d.phone); ok.push(d);
  }
  if (confirm) {
    const t = nowIso();
    for (const d of ok) {
      const c = { id: nextId('customers'), first_name: d.first_name || '-', last_name: d.last_name, phone: d.phone, email: d.email, birth_date: d.birth_date, address: d.address,
        postal_code: d.postal_code, city: d.city, marketing_email: false, marketing_sms: false, terms_accepted_at: null, points: 0, public_token: newToken(), created_at: t, source: 'import' };
      db.customers.push(c);
      if (d.points > 0) { db.loyalty_adjustments.push({ id: nextId('loyalty_adjustments'), customer_id: c.id, delta: d.points, reason: 'Reprise du solde (import)', created_at: t, by_user: req.user.username }); c.points = d.points; autoVouchers(c, req.user); }
    }
    audit(req.user, 'import', `${ok.length} cliente(s)`);
  }
  return { ok: ok.length, duplicates: dup, invalid: bad_.length, imported: confirm };
}));

app.get('/api/audit', auth, adminOnly, read(() => db.audit.slice(-200).reverse()));

/* ======================= Exports ======================= */

function csv(rows) { const e = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; return '﻿' + rows.map(r => r.map(e).join(';')).join('\r\n'); }
function sendCsv(res, name, rows) { res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(csv(rows)); }
function customersCsv() {
  return csv([['Prénom', 'Nom', 'Téléphone', 'E-mail', 'Date de naissance', 'Adresse', 'Code postal', 'Ville', 'Points', 'Bons actifs', 'Offres e-mail', 'Offres SMS', 'Inscription', 'Suppression demandée'],
    ...liveCustomers().map(c => [c.first_name, c.last_name, c.phone, c.email, c.birth_date, c.address, c.postal_code, c.city, c.points, activeVouchers(c.id).length,
      c.marketing_email ? 'oui' : 'non', c.marketing_sms ? 'oui' : 'non', c.created_at, c.deletion_requested_at || ''])]);
}
function purchasesCsv() {
  const names = Object.fromEntries(db.customers.map(c => [c.id, c]));
  return csv([['Date', 'Prénom', 'Nom', 'Téléphone', 'Montant', 'Dont soldé/promo', 'Points', 'Boutique', 'Par', 'Annulé'],
    ...db.purchases.map(p => { const c = names[p.customer_id] || {}; return [p.created_at, c.first_name || 'anonyme', c.last_name || '', c.phone || '', (p.amount_cents / 100).toFixed(2).replace('.', ','), ((p.excluded_cents || 0) / 100).toFixed(2).replace('.', ','), p.points, p.store || '', p.by_user, p.cancelled ? 'oui' : 'non']; })]);
}
app.get('/api/export/customers.csv', auth, adminOnly, async (req, res) => {
  audit(req.user, 'export_clientes', ''); persist().catch(() => {});
  sendCsv(res, 'esprit-mode-clientes.csv', [['Prénom', 'Nom', 'Téléphone', 'E-mail', 'Date de naissance', 'Adresse', 'Code postal', 'Ville', 'Points', 'Bons actifs', 'Offres e-mail', 'Offres SMS', 'Inscription', 'Suppression demandée'],
    ...liveCustomers().map(c => [c.first_name, c.last_name, c.phone, c.email, c.birth_date, c.address, c.postal_code, c.city, c.points, activeVouchers(c.id).length,
      c.marketing_email ? 'oui' : 'non', c.marketing_sms ? 'oui' : 'non', c.created_at, c.deletion_requested_at || ''])]);
});
app.get('/api/export/purchases.csv', auth, adminOnly, async (req, res) => {
  const names = Object.fromEntries(db.customers.map(c => [c.id, c]));
  sendCsv(res, 'esprit-mode-achats.csv', [['Date', 'Prénom', 'Nom', 'Téléphone', 'Montant', 'Dont soldé/promo', 'Points', 'Boutique', 'Par', 'Annulé'],
    ...db.purchases.map(p => { const c = names[p.customer_id] || {}; return [p.created_at, c.first_name || 'anonyme', c.last_name || '', c.phone || '', (p.amount_cents / 100).toFixed(2).replace('.', ','), ((p.excluded_cents || 0) / 100).toFixed(2).replace('.', ','), p.points, p.store || '', p.by_user, p.cancelled ? 'oui' : 'non']; })]);
});

/* ======================= Campagnes (consentement obligatoire) ======================= */

const CHANNELS = ['app', 'email', 'sms', 'whatsapp', 'facebook', 'instagram'];
const AUDIENCES = { all: 'Toutes les clientes', inactive: 'Sans achat depuis 3 mois', near: 'Proches du bon (moins de 50 points)', vouchers: 'Avec un bon à utiliser',
  birthday_month: 'Anniversaire dans les 30 jours', 'store:Général de Gaulle': 'Clientes du Général de Gaulle', 'store:Clemenceau': 'Clientes de Clemenceau' };
function inAudience(c, aud) {
  if (!aud || aud === 'all') return true;
  const live = db.purchases.filter(p => p.customer_id === c.id && !p.cancelled).sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (aud === 'inactive') return !live[0] || (Date.now() - new Date(live[0].created_at)) > 90 * DAY;
  if (aud === 'near') return c.points >= S().threshold - 50;
  if (aud === 'vouchers') return activeVouchers(c.id).length > 0;
  if (aud === 'birthday_month') return birthdayIn(c, 30) !== null;
  if (aud.startsWith('store:')) return !!live[0] && live[0].store === aud.slice(6);
  return true;
}
function recipients(channel, aud) {
  const base = liveCustomers().filter(c => !c.deletion_requested_at && inAudience(c, aud));
  if (channel === 'email') return base.filter(c => c.marketing_email && c.email);
  if (channel === 'sms' || channel === 'whatsapp') return base.filter(c => c.marketing_sms && c.phone);
  return [];
}
const EMAIL_DAILY_LIMIT = 300;
const brevoReady = () => !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
const todayKey = () => new Date().toLocaleDateString('fr-CA');
const emailsLeft = () => Math.max(0, EMAIL_DAILY_LIMIT - (Number(db.email_log[todayKey()]) || 0));
app.get('/api/campaigns/audience', auth, managerOnly, read(req => ({
  audiences: AUDIENCES, audience: String(req.query.aud || 'all'),
  total: liveCustomers().filter(c => inAudience(c, String(req.query.aud || 'all'))).length,
  email: recipients('email', String(req.query.aud || 'all')).length, sms: recipients('sms', String(req.query.aud || 'all')).length, whatsapp: recipients('whatsapp', String(req.query.aud || 'all')).length,
  email_ready: brevoReady(), email_left_today: emailsLeft()
})));
app.get('/api/campaigns', auth, managerOnly, read(() => [...db.campaigns].sort((a, b) => b.created_at.localeCompare(a.created_at))));
app.post('/api/campaigns', auth, managerOnly, tx(req => {
  const x = req.body || {};
  const title = clean(x.title, 120), message = String(x.message || '').trim().slice(0, 3000);
  if (!title || !message) bad('Titre et message obligatoires.');
  const channels = Object.fromEntries(CHANNELS.map(k => [k, !!x[k]]));
  if (!CHANNELS.some(k => channels[k])) bad('Choisissez au moins un canal.');
  const audience = Object.prototype.hasOwnProperty.call(AUDIENCES, x.audience) ? x.audience : 'all';
  const counts = Object.fromEntries(['email', 'sms', 'whatsapp'].filter(k => channels[k]).map(k => [k, recipients(k, audience).length]));
  const c = { id: nextId('campaigns'), title, message, media_url: clean(x.media_url, 300), channels, audience, recipients: counts, status: 'brouillon', created_at: nowIso(), created_by: req.user.username };
  db.campaigns.push(c);
  return c;
}));
function campaignById(id) { const c = db.campaigns.find(x => x.id === Number(id)); if (!c) bad('Campagne introuvable', 404); return c; }
app.delete('/api/campaigns/:id', auth, managerOnly, tx(req => {
  const c = campaignById(req.params.id);
  db.campaigns = db.campaigns.filter(x => x !== c);
  audit(req.user, 'suppression_campagne', c.title);
}));
app.post('/api/campaigns/:id/publish', auth, managerOnly, tx(req => {
  const c = campaignById(req.params.id);
  c.channels = { ...(c.channels || {}), app: !!(req.body || {}).published };
  return c;
}));
// Liste des destinataires ayant donné leur accord, pour l'envoi manuel (SMS / WhatsApp depuis le téléphone de Michelle)
app.get('/api/campaigns/:id/recipients', auth, managerOnly, read(req => {
  const c = campaignById(req.params.id); const ch = String(req.query.channel || '');
  if (!['sms', 'whatsapp'].includes(ch)) bad('Canal invalide');
  const done = new Set(((c.manual_sent || {})[ch]) || []);
  return recipients(ch, c.audience).map(x => ({ id: x.id, first_name: x.first_name, last_name: x.last_name, phone: x.phone, done: done.has(x.id) }));
}));
app.post('/api/campaigns/:id/mark', auth, managerOnly, tx(req => {
  const c = campaignById(req.params.id); const { channel, customer_id } = req.body || {};
  if (!['sms', 'whatsapp'].includes(channel)) bad('Canal invalide');
  c.manual_sent = c.manual_sent || {}; const list = new Set(c.manual_sent[channel] || []); list.add(Number(customer_id));
  c.manual_sent[channel] = [...list];
  return { count: list.size };
}));
function emailHtml(c, cust, req) {
  const e = s => String(s || '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const msg = e(String(c.message).replace(/\{prenom\}/gi, cust.first_name)).replace(/\n/g, '<br>');
  const media = /^https:\/\//.test(c.media_url || '') ? `<p><a href="${e(c.media_url)}" style="color:#465157;font-weight:bold">Voir la photo / la vidéo</a></p>` : '';
  return `<div style="background:#f7f3ee;padding:24px 12px;font-family:Arial,sans-serif;color:#222"><div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:#465157;color:#fff;padding:22px;font-size:26px;letter-spacing:2px">esprit mode</div>
    <div style="padding:22px;font-size:16px;line-height:1.5"><h2 style="font-family:Georgia,serif;font-weight:normal;margin-top:0">${e(c.title)}</h2><p>${msg}</p>${media}
    <p><a href="${cardUrl(cust, req)}" style="display:inline-block;background:#465157;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none">Voir ma carte de fidélité</a></p><p style="font-size:13px;color:#697177">Si le bouton ne répond pas, appuyez longuement sur ce lien puis choisissez « Ouvrir » ou « Ouvrir dans Safari » :<br><a href="${cardUrl(cust, req)}" style="color:#465157;word-break:break-all">${cardUrl(cust, req)}</a></p></div>
    <div style="padding:16px 22px;font-size:12px;color:#697177;border-top:1px solid #e7ded6">esprit mode — 59 av. du Général de Gaulle et 47 av. Georges Clemenceau, 94700 Maisons-Alfort — Michelle : 06 62 55 24 87 — <a href="${baseUrl(req)}/conditions.html" style="color:#697177">Conditions d'utilisation</a><br>
    Vous recevez cet e-mail car vous avez accepté les offres d'esprit mode. <a href="${baseUrl(req)}/desinscription?token=${cust.public_token}" style="color:#697177">Se désinscrire</a></div></div></div>`;
}
async function brevoSend(to, subject, html, attachments) {
  const body = { sender: { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'esprit mode' }, to: [{ email: to.email, name: `${to.first_name || ''} ${to.last_name || ''}`.trim() || to.email }], subject, htmlContent: html };
  if (attachments && attachments.length) body.attachment = attachments;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch (e) {} throw new Error(`Brevo ${r.status} ${m}`); }
}
function welcomeHtml(c, req) {
  const e = s => String(s || '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  return `<div style="background:#f7f3ee;padding:24px 12px;font-family:Arial,sans-serif;color:#222"><div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:#465157;color:#fff;padding:22px;font-size:26px;letter-spacing:2px">esprit mode</div>
    <div style="padding:22px;font-size:16px;line-height:1.5"><p>Bonjour ${e(c.first_name)},</p><p>Bienvenue chez esprit mode ! Votre carte de fidélité est créée : 1 € dépensé = 1 point, et à ${S().threshold} points un bon d'achat de ${S().voucher_value_cents / 100} € vous est offert.</p>
    <p><a href="${cardUrl(c, req)}" style="display:inline-block;background:#465157;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none">Ouvrir ma carte de fidélité</a></p>
    <p style="font-size:13px;color:#697177">Si le bouton ne répond pas, appuyez longuement sur ce lien puis choisissez « Ouvrir » ou « Ouvrir dans Safari » :<br><a href="${cardUrl(c, req)}" style="color:#465157;word-break:break-all">${cardUrl(c, req)}</a></p>
    <p style="font-size:14px;color:#697177">Sur iPhone, ouvrez ce lien dans Safari puis Partager → « Sur l'écran d'accueil ». Sur Android, Chrome propose « Installer l'application ».</p></div>
    <div style="padding:16px 22px;font-size:12px;color:#697177;border-top:1px solid #e7ded6">esprit mode — 59 av. du Général de Gaulle et 47 av. Georges Clemenceau, 94700 Maisons-Alfort — Michelle : 06 62 55 24 87 — <a href="${baseUrl(req)}/conditions.html" style="color:#697177">Conditions d'utilisation</a></div></div></div>`;
}
// E-mail de bienvenue (message de service, pas de la publicité) : envoyé en arrière-plan si Brevo est activé
function sendWelcome(c, req) {
  if (!brevoReady() || !c.email || emailsLeft() < 1) return;
  brevoSend(c, 'Votre carte de fidélité esprit mode', welcomeHtml(c, req))
    .then(() => { const k = todayKey(); db.email_log = { [k]: (Number(db.email_log[k]) || 0) + 1 }; return persist(); })
    .catch(err => console.error('E-mail de bienvenue :', err.message));
}
/* ---- E-mails automatiques (chacun activable dans Administration > Options) ---- */
function eH(s) { return String(s || '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function mailLayout(c, inner, unsub) {
  const url = cardUrl(c, null);
  return `<div style="background:#f7f3ee;padding:24px 12px;font-family:Arial,sans-serif;color:#222"><div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:#465157;color:#fff;padding:22px;font-size:26px;letter-spacing:2px">esprit mode</div>
    <div style="padding:22px;font-size:16px;line-height:1.5">${inner}
    <p><a href="${url}" style="display:inline-block;background:#465157;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none">Ouvrir ma carte de fidélité</a></p>
    <p style="font-size:13px;color:#697177">Si le bouton ne répond pas, appuyez longuement sur ce lien puis « Ouvrir dans Safari » :<br><a href="${url}" style="color:#465157;word-break:break-all">${url}</a></p></div>
    <div style="padding:16px 22px;font-size:12px;color:#697177;border-top:1px solid #e7ded6">esprit mode — 59 av. du Général de Gaulle et 47 av. Georges Clemenceau, 94700 Maisons-Alfort — Michelle : 06 62 55 24 87 — <a href="${baseUrl(null)}/conditions.html" style="color:#697177">Conditions d'utilisation</a>${unsub ? `<br>Vous recevez cet e-mail car vous avez accepté les offres d'esprit mode. <a href="${baseUrl(null)}/desinscription?token=${c.public_token}" style="color:#697177">Se désinscrire</a>` : ''}</div></div></div>`;
}
async function mailCustomer(c, subject, html, what) {
  if (!brevoReady() || !c.email || emailsLeft() < 1) return false;
  try { await brevoSend(c, subject, html); const k = todayKey(); db.email_log = { [k]: (Number(db.email_log[k]) || 0) + 1 }; await persist(); return true; }
  catch (e) { console.error(what + ' :', e.message); return false; }
}
function sendVoucherEmail(c, v) {
  mailCustomer(c, `Carte pleine ! Votre bon d'achat de ${v.value_cents / 100} € esprit mode`, mailLayout(c,
    `<p>Bonjour ${eH(c.first_name)},</p><p><b>Votre carte est pleine !</b> Un <b>bon d'achat de ${v.value_cents / 100} €</b> vous attend dans nos boutiques, valable jusqu'au <b>${new Date(v.expires_at).toLocaleDateString('fr-FR')}</b>.</p><p>À très bientôt chez esprit mode.</p>`, false), 'E-mail carte pleine');
}
function applyWelcomeBonus(c, user) {
  const o = O(); const pts = Math.floor(Number(o.welcome_bonus_points) || 0);
  if (!o.welcome_bonus_enabled || pts <= 0) return;
  db.loyalty_adjustments.push({ id: nextId('loyalty_adjustments'), customer_id: c.id, delta: pts, reason: 'Bonus de bienvenue', created_at: nowIso(), by_user: user ? user.username : 'automatique' });
  c.points += pts;
}
function giveBirthdayBonus(c, pts, user) {
  const tag = 'Bonus anniversaire ' + new Date().getFullYear();
  db.loyalty_adjustments.push({ id: nextId('loyalty_adjustments'), customer_id: c.id, delta: pts, reason: tag, created_at: nowIso(), by_user: user ? user.username : 'automatique' });
  c.points += pts;
  return autoVouchers(c, user);
}
/* Tâches quotidiennes : anniversaires automatiques, rappels d'expiration, sauvegarde hebdomadaire.
   Elles tournent quand le serveur est éveillé (au plus une fois par jour). */
let dailyRunning = false;
async function runDaily(force) {
  if (dailyRunning) return; const today = todayKey();
  if (!force && db.meta.last_daily === today) return;
  dailyRunning = true;
  try {
    db.meta.last_daily = today; const o = O();
    for (const c of liveCustomers()) {
      if (birthdayIn(c, 0) !== 0) continue;
      if (o.birthday_auto_points && !birthdayGivenThisYear(c) && Number(o.birthday_suggested_points) > 0) giveBirthdayBonus(c, Math.floor(Number(o.birthday_suggested_points)), null);
      if (o.birthday_auto_email && c.marketing_email && !c.deletion_requested_at && c.birthday_mail_year !== new Date().getFullYear()) {
        c.birthday_mail_year = new Date().getFullYear();
        await mailCustomer(c, 'Joyeux anniversaire de la part d\'esprit mode', mailLayout(c, `<p>Bonjour ${eH(c.first_name)},</p><p>Toute l'équipe <b>esprit mode</b> vous souhaite un très joyeux anniversaire !${o.birthday_auto_points && Number(o.birthday_suggested_points) > 0 ? ` <b>${Math.floor(Number(o.birthday_suggested_points))} points</b> ont été ajoutés à votre carte.` : ''}</p><p>Michelle et l'équipe</p>`, true), 'E-mail anniversaire');
      }
    }
    if (o.email_expiry_reminder) {
      const limit = Date.now() + (Number(o.reminder_days) || 30) * DAY;
      for (const v of db.vouchers) {
        if (voucherStatus(v) !== 'active' || v.reminded_at || new Date(v.expires_at).getTime() > limit) continue;
        const c = db.customers.find(x => x.id === v.customer_id && !x.deleted); if (!c) continue;
        v.reminded_at = nowIso();
        await mailCustomer(c, `Votre bon d'achat de ${v.value_cents / 100} € expire bientôt`, mailLayout(c, `<p>Bonjour ${eH(c.first_name)},</p><p>Petit rappel : votre <b>bon d'achat de ${v.value_cents / 100} €</b> est valable jusqu'au <b>${new Date(v.expires_at).toLocaleDateString('fr-FR')}</b>. Passez nous voir pour en profiter !</p>`, false), 'Rappel expiration');
      }
    }
    if (o.weekly_backup && brevoReady() && o.backup_email && (!db.meta.last_backup || Date.now() - new Date(db.meta.last_backup).getTime() > 7 * DAY - 3600000)) {
      try {
        const b64 = t => Buffer.from(t, 'utf8').toString('base64');
        await brevoSend({ email: o.backup_email, first_name: 'esprit', last_name: 'mode' }, 'Sauvegarde hebdomadaire esprit mode — ' + new Date().toLocaleDateString('fr-FR'),
          '<p>Ci-joint la sauvegarde hebdomadaire des clientes et des achats (fichiers CSV à ouvrir avec Excel). Conservez cet e-mail.</p>',
          [{ name: 'esprit-mode-clientes-' + today + '.csv', content: b64(customersCsv()) }, { name: 'esprit-mode-achats-' + today + '.csv', content: b64(purchasesCsv()) }]);
        db.meta.last_backup = nowIso(); audit(null, 'sauvegarde_hebdo', o.backup_email);
      } catch (e) { console.error('Sauvegarde hebdomadaire :', e.message); }
    }
    await persist();
  } catch (e) { console.error('Tâches quotidiennes :', e.message); }
  finally { dailyRunning = false; }
}
setInterval(() => runDaily(false), 3600000).unref();

let sending = false;
app.post('/api/campaigns/:id/send-email', auth, managerOnly, async (req, res) => {
  try {
    if (!brevoReady()) bad("L'envoi d'e-mails n'est pas encore activé (compte Brevo à relier dans Render).");
    if (sending) bad('Un envoi est déjà en cours. Patientez.', 429);
    const c = campaignById(req.params.id);
    if (c.email_sent_at) bad('Cette campagne a déjà été envoyée par e-mail.');
    const list = recipients('email', c.audience);
    if (!list.length) bad("Aucune cliente de cette cible n'a accepté les offres par e-mail.");
    if (list.length > emailsLeft()) bad(`Limite gratuite : il reste ${emailsLeft()} e-mails aujourd'hui pour ${list.length} destinataires. Réessayez demain.`);
    sending = true;
    let ok = 0, failed = 0, lastErr = '';
    for (const cust of list) {
      try { await brevoSend(cust, c.title, emailHtml(c, cust, req)); ok++; }
      catch (e) { failed++; lastErr = e.message; if (/Brevo 40[13]/.test(e.message)) break; }
      await new Promise(r => setTimeout(r, 120));
    }
    const k = todayKey(); db.email_log = { [k]: (Number(db.email_log[k]) || 0) + ok };
    if (ok) { c.email_sent_at = nowIso(); c.email_sent_count = ok; c.status = 'envoyee'; }
    audit(req.user, 'envoi_email', `${c.title} : ${ok} envoyé(s), ${failed} échec(s)`);
    await persist();
    if (!ok) bad("Aucun e-mail n'est parti. " + (lastErr.includes('401') || lastErr.includes('403') ? 'La clé Brevo est refusée : vérifiez-la dans Render.' : lastErr), 502);
    res.json({ sent: ok, failed });
  } catch (e) {
    if (e instanceof HttpError) res.status(e.status).json({ error: e.message });
    else { console.error(e); res.status(500).json({ error: "Erreur pendant l'envoi." }); }
  } finally { sending = false; }
});
app.post('/api/campaigns/:id/status', auth, managerOnly, tx(req => {
  const c = db.campaigns.find(x => x.id === Number(req.params.id)); if (!c) bad('Campagne introuvable', 404);
  if (!['brouillon', 'prete', 'envoyee'].includes((req.body || {}).status)) bad('Statut invalide');
  c.status = req.body.status; return c;
}));
app.get('/api/campaigns/recipients.csv', auth, managerOnly, (req, res) => {
  const ch = String(req.query.channel || '');
  if (!['email', 'sms', 'whatsapp'].includes(ch)) return res.status(400).json({ error: 'Canal invalide' });
  const list = recipients(ch);
  audit(req.user, 'export_destinataires', ch + ' (' + list.length + ')'); persist().catch(() => {});
  sendCsv(res, `destinataires-${ch}.csv`, [['Prénom', 'Nom', ch === 'email' ? 'E-mail' : 'Téléphone', 'Lien de désinscription'],
    ...list.map(c => [c.first_name, c.last_name, ch === 'email' ? c.email : c.phone, ch === 'email' ? `${baseUrl(req)}/desinscription?token=${c.public_token}` : ''])]);
});

/* ======================= Vidéos de Michelle et contenus publics ======================= */

function publicVideo(v) { return { id: v.id, title: v.title, url: v.url, description: v.description, created_at: v.created_at, active: v.active !== false }; }
app.get('/api/videos', auth, managerOnly, read(() => [...db.videos].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(publicVideo)));
app.post('/api/videos', auth, managerOnly, tx(req => {
  const x = req.body || {}; const title = clean(x.title, 120), url = String(x.url || '').trim().slice(0, 500);
  if (!title) bad('Donnez un titre à la vidéo.');
  if (!/^https:\/\/[^\s<>"]+$/.test(url)) bad('Collez le lien complet de la vidéo (il commence par https://).');
  const v = { id: nextId('videos'), title, url, description: clean(x.description, 300), active: true, created_at: nowIso(), created_by: req.user.username };
  db.videos.push(v); return publicVideo(v);
}));
app.put('/api/videos/:id', auth, managerOnly, tx(req => {
  const v = db.videos.find(x => x.id === Number(req.params.id)); if (!v) bad('Vidéo introuvable', 404);
  if ((req.body || {}).active !== undefined) v.active = !!req.body.active;
  return publicVideo(v);
}));
app.delete('/api/videos/:id', auth, managerOnly, tx(req => { db.videos = db.videos.filter(x => x.id !== Number(req.params.id)); }));
app.get('/api/public/content', read(() => ({
  offers: db.campaigns.filter(c => c.channels && c.channels.app).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5)
    .map(c => ({ title: c.title, message: String(c.message).replace(/\s*\{prenom\}/gi, '').trim(), media_url: /^https:\/\//.test(c.media_url || '') ? c.media_url : '', created_at: c.created_at })),
  videos: db.videos.filter(v => v.active !== false).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 12).map(publicVideo)
})));

/* ======================= Lancement ======================= */

bootstrap()
  .then(() => { setTimeout(() => runDaily(false), 20000).unref(); return app.listen(PORT, HOST, () => console.log(`esprit mode v${VERSION} : http://${HOST}:${PORT} — stockage ${pool ? 'PostgreSQL' : 'fichier local (tests uniquement)'}`)); })
  .catch(e => { console.error('Démarrage impossible :', e); process.exit(1); });
