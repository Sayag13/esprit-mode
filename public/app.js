/* esprit mode — fonctions communes aux pages de l'équipe et des clientes */
'use strict';
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function money(v) { return Number(v || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }); }
function euros0(v) { const n = Number(v || 0); return Number.isInteger(n) ? n.toLocaleString('fr-FR') + ' €' : money(n); }
function fdate(s) { return s ? new Date(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function fdt(s) { return s ? new Date(s).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function fmtPhone(p) { return String(p || '').replace(/(\d{2})(?=\d)/g, '$1 '); }
function $(id) { return document.getElementById(id); }

function getAuth() { try { return localStorage.getItem('auth') || ''; } catch (e) { return ''; } }
function setAuth(v) { try { v ? localStorage.setItem('auth', v) : localStorage.removeItem('auth'); } catch (e) {} }

async function api(url, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}), Authorization: getAuth() } };
  if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch(url, o); } catch (e) { throw new Error('Connexion au serveur impossible. Vérifiez internet puis réessayez (le serveur peut mettre 1 minute à se réveiller).'); }
  if (r.status === 401 && !url.startsWith('/api/public')) { setAuth(''); location.href = '/login.html'; throw new Error('Session expirée'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || 'Erreur ' + r.status);
  return data;
}
async function download(url, filename) {
  const r = await fetch(url, { headers: { Authorization: getAuth() } });
  if (!r.ok) { let m = 'Export impossible'; try { m = (await r.json()).error || m; } catch (e) {} throw new Error(m); }
  const blob = await r.blob(); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function toast(msg, bad) {
  let t = $('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = bad ? 'show bad' : 'show'; clearTimeout(t._h); t._h = setTimeout(() => t.className = '', 3800);
}
async function logout() { try { await api('/api/logout', { method: 'POST' }); } catch (e) {} setAuth(''); location.href = '/login.html'; }

/* Barre de navigation de l'équipe selon le rôle */
async function staffNav(current) {
  let me;
  try { me = await api('/api/me'); } catch (e) { return null; }
  const links = [['vente', '/vente.html', 'Caisse', ['admin', 'manager', 'seller']], ['boutique', '/boutique.html', 'Clientes & communication', ['admin', 'manager']], ['admin', '/admin.html', 'Administration', ['admin']]];
  const nav = $('nav');
  if (nav) nav.innerHTML = links.filter(l => l[3].includes(me.role)).map(l => `<a href="${l[1]}"${l[0] === current ? ' aria-current="page"' : ''}>${l[2]}</a>`).join('') +
    `<a href="/compte.html"${current === 'compte' ? ' aria-current="page"' : ''}>Mon mot de passe</a><span class="who">${esc(me.display_name)}</span><button type="button" class="ghost" id="logoutBtn">Déconnexion</button>`;
  if (me.weak && current !== 'compte') { const m = document.querySelector('main'); if (m) m.insertAdjacentHTML('afterbegin', '<p class="warn">Votre mot de passe est trop simple. <a href="/compte.html">Choisissez-en un nouveau</a> (8 caractères minimum).</p>'); }
  const b = $('logoutBtn'); if (b) b.addEventListener('click', logout);
  return me;
}

/* Grille à tampons identique à la carte papier (5 colonnes de 25, 20, 10, 5 = 300) */
function stampGrid(points, threshold) {
  if (Number(threshold) !== 300) return '';
  const rows = [25, 20, 10, 5], pts = Math.min(Math.max(points, 0), 300), on = {}; let cum = 0;
  for (let c = 0; c < 5; c++) for (let r = 0; r < 4; r++) { cum += rows[r]; on[r + '-' + c] = cum <= pts; }
  let cells = '';
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) cells += `<div class="stamp${on[r + '-' + c] ? ' on' : ''}">${rows[r]}</div>`;
  return `<div class="stamps" role="img" aria-label="${pts} euros tamponnés sur 300">${cells}</div>`;
}

/* Partage de l'application : un seul lien dans le message (WhatsApp, SMS…) */
async function shareApp(msgEl) {
  const url = location.origin + '/';
  const text = "✨ esprit mode — Carte de fidélité\nDécouvrez votre carte de fidélité esprit mode, vos points et vos avantages.\n\n👉 Découvrez l'application :\n" + url;
  if (navigator.share) { try { await navigator.share({ text }); } catch (e) {} return; }
  try { await navigator.clipboard.writeText(text); if (msgEl) msgEl.textContent = 'Message copié : collez-le dans WhatsApp ou vos SMS.'; }
  catch (e) { if (msgEl) msgEl.textContent = url; }
}

/* Installation sur l'écran d'accueil (iPhone et Android) */
let _installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _installEvt = e; document.querySelectorAll('[data-install-android]').forEach(b => b.classList.remove('hidden')); });
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function browserKind() {
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|GSA\//i.test(ua);
  const otherIos = ios && /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(ua);
  return { ios, inApp, otherIos, android: /android/i.test(ua) };
}
function installBox(label) {
  if (isStandalone()) return '<p class="ok">Vous utilisez l\'application esprit mode installée sur votre téléphone.</p>';
  const k = browserKind();
  const shareIcon = '<svg width="16" height="20" viewBox="0 0 16 20" style="vertical-align:-4px" aria-label="Partager"><path d="M8 1v12M4 5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 8H2v11h12V8h-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  const head = `<div class="row" style="gap:12px;align-items:center;margin:8px 0"><img src="/icons/apple-touch-icon.png" alt="" width="56" height="56" style="border-radius:13px;flex:none"><div style="flex:1 1 200px"><b>${label}</b><div class="small muted">L'icône esprit mode apparaîtra sur votre écran d'accueil.</div></div></div>`;
  if (k.otherIos || (k.ios && k.inApp)) return head + `<p class="warn small">Cette page est ouverte dans une autre application que Safari : l'installation n'y est pas possible.</p>
    <ol class="small" style="padding-left:18px;margin:8px 0"><li>Touchez <b>Copier le lien</b> ci-dessous.</li><li>Ouvrez <b>Safari</b> (la boussole bleue), touchez la barre d'adresse puis <b>Coller et accéder</b>.</li><li>Dans Safari, touchez <b>Partager</b> ${shareIcon} (en bas, ou dans le menu <b>⋯</b>), puis <b>« Sur l'écran d'accueil »</b> et <b>Ajouter</b>.</li></ol>
    <button type="button" data-copy-url>Copier le lien</button>`;
  if (k.ios) return head + `<ol class="small" style="padding-left:18px;margin:8px 0"><li>Touchez <b>Partager</b> ${shareIcon} en bas de l'écran. S'il n'est pas visible, touchez d'abord <b>⋯</b> (trois points, en bas à droite).</li><li>Faites défiler et choisissez <b>« Sur l'écran d'accueil »</b>.</li><li>Laissez « Ouvrir en tant qu'app web » activé, puis touchez <b>Ajouter</b>.</li></ol>`;
  if (k.android && k.inApp) return head + `<p class="warn small">Cette page est ouverte dans une autre application. Touchez le menu ⋮ puis <b>« Ouvrir dans Chrome »</b>, ou copiez le lien et collez-le dans Chrome.</p><button type="button" data-copy-url>Copier le lien</button>`;
  return head + `<button type="button" class="${_installEvt ? '' : 'hidden'}" data-install-android>Installer l'application</button>
    <p class="small muted">Si le bouton n'apparaît pas : dans Chrome, touchez le menu ⋮ puis <b>« Installer l'application »</b> ou <b>« Ajouter à l'écran d'accueil »</b>.</p>`;
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy-url]'); if (!b) return;
  try { await navigator.clipboard.writeText(location.href); b.textContent = 'Lien copié ✓ — collez-le dans Safari'; }
  catch (err) { prompt('Copiez ce lien :', location.href); }
});
/* Envoi du lien de la carte à une cliente (message de service, depuis le téléphone de la boutique) */
function cardLinkButtons(c, url) {
  const intl = String(c.phone || '').replace(/\D/g, '').replace(/^0/, '33');
  const text = `Bonjour ${c.first_name}, voici votre carte de fidélité esprit mode : ${url}\nAjoutez-la à l'écran d'accueil de votre téléphone. À bientôt !`;
  const btn = 'display:inline-block;background:var(--ink);color:#fff;border-radius:10px;padding:9px 12px;text-decoration:none;font-size:14px;margin:3px';
  return `<div class="row" style="gap:4px"><a style="${btn}" href="sms:+${intl}?&body=${encodeURIComponent(text)}">Envoyer par SMS</a>
    <a style="${btn}" href="https://wa.me/${intl}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Envoyer par WhatsApp</a>
    <button type="button" class="small secondary auto" data-copy-text="${esc(url)}">Copier le lien</button></div>`;
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy-text]'); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copyText); toast('Lien copié'); } catch (err) { prompt('Copiez ce lien :', b.dataset.copyText); }
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-install-android]'); if (!b || !_installEvt) return;
  _installEvt.prompt(); try { await _installEvt.userChoice; } catch (err) {} _installEvt = null; b.classList.add('hidden');
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
