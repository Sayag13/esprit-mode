const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'esprit-mode.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
 id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
 phone TEXT NOT NULL UNIQUE, email TEXT, birth_date TEXT, marketing_email INTEGER NOT NULL DEFAULT 0,
 marketing_sms INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0,
 public_token TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchases (
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
 points INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(customer_id) REFERENCES customers(id)
);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'seller');
CREATE TABLE IF NOT EXISTS rewards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, points_cost INTEGER NOT NULL, value_cents INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS redemptions (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, reward_id INTEGER NOT NULL, points_used INTEGER NOT NULL, value_cents INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(customer_id) REFERENCES customers(id), FOREIGN KEY(reward_id) REFERENCES rewards(id));
`);
try { db.prepare('ALTER TABLE customers ADD COLUMN public_token TEXT UNIQUE').run(); } catch(e) {}
for (const c of db.prepare('SELECT id FROM customers WHERE public_token IS NULL').all()) db.prepare('UPDATE customers SET public_token=? WHERE id=?').run(crypto.randomBytes(18).toString('hex'), c.id);
if (!db.prepare('SELECT id FROM users LIMIT 1').get()) db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run('admin', hash(process.env.ADMIN_PASSWORD || 'changer-moi'), 'admin');
if (!db.prepare('SELECT id FROM rewards LIMIT 1').get()) db.prepare('INSERT INTO rewards(name,points_cost,value_cents) VALUES(?,?,?)').run('Bon de 10 €', 100, 1000);

function hash(p){ return crypto.createHash('sha256').update(String(p)).digest('hex'); }
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health',(req,res)=>res.json({ok:true,service:'esprit-mode'}));
function auth(req,res,next){
 const h=req.headers.authorization||'';
 if(!h.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate','Basic realm="Esprit Mode"').json({error:'Connexion requise'});
 const raw=Buffer.from(h.slice(6),'base64').toString(); const i=raw.indexOf(':'); const u=raw.slice(0,i), p=raw.slice(i+1);
 const user=db.prepare('SELECT id,username,role FROM users WHERE username=? AND password_hash=?').get(u,hash(p));
 if(!user) return res.status(401).set('WWW-Authenticate','Basic realm="Esprit Mode"').json({error:'Identifiants incorrects'}); req.user=user; next();
}
function adminOnly(req,res,next){ if(req.user.role!=='admin') return res.status(403).json({error:'Accès administrateur requis'}); next(); }
function publicUrl(token, req){
 const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
 return `${base.replace(/\/$/, '')}/carte.html?token=${encodeURIComponent(token)}`;
}

// Public customer registration
app.post('/api/public/register', (req,res)=>{
 const {first_name,last_name,phone,email='',birth_date='',marketing_email=0,marketing_sms=0}=req.body||{};
 if(!first_name||!last_name||!phone) return res.status(400).json({error:'Prénom, nom et téléphone sont obligatoires'});
 try {
  const token=crypto.randomBytes(18).toString('hex');
  const info=db.prepare(`INSERT INTO customers(first_name,last_name,phone,email,birth_date,marketing_email,marketing_sms,public_token) VALUES(?,?,?,?,?,?,?,?)`).run(first_name.trim(),last_name.trim(),phone.trim(),email.trim(),birth_date,!!marketing_email,!!marketing_sms,token);
  res.json({token, customer: db.prepare('SELECT id,first_name,last_name,phone,email,points,public_token FROM customers WHERE id=?').get(info.lastInsertRowid)});
 } catch(e){ res.status(409).json({error:'Ce numéro de téléphone est déjà enregistré. Demandez à la boutique de retrouver votre carte.'}); }
});
app.get('/api/public/customer/token/:token',(req,res)=>{
 const c=db.prepare('SELECT id,first_name,last_name,phone,email,points,public_token,created_at FROM customers WHERE public_token=?').get(req.params.token);
 if(!c) return res.status(404).json({error:'Carte introuvable'});
 const history=db.prepare('SELECT amount_cents/100.0 AS amount, points, created_at FROM purchases WHERE customer_id=? ORDER BY created_at DESC LIMIT 20').all(c.id);
 const rewards=db.prepare('SELECT id,name,points_cost,value_cents FROM rewards WHERE active=1 ORDER BY points_cost').all();
 res.json({customer:c,history,rewards});
});
app.get('/api/public/customer/:phone',(req,res)=>{ const c=db.prepare('SELECT id,first_name,last_name,phone,email,points,public_token FROM customers WHERE phone=?').get(req.params.phone); if(!c)return res.status(404).json({error:'Cliente introuvable'}); res.json(c); });

app.post('/api/customers',auth,(req,res)=>{
 const {first_name,last_name,phone,email='',birth_date='',marketing_email=0,marketing_sms=0}=req.body;
 if(!first_name||!last_name||!phone) return res.status(400).json({error:'Prénom, nom et téléphone obligatoires'});
 try{ const token=crypto.randomBytes(18).toString('hex'); const info=db.prepare(`INSERT INTO customers(first_name,last_name,phone,email,birth_date,marketing_email,marketing_sms,public_token) VALUES(?,?,?,?,?,?,?,?)`).run(first_name,last_name,phone,email,birth_date,!!marketing_email,!!marketing_sms,token); res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid)); } catch(e){res.status(409).json({error:'Ce numéro existe déjà'});}
});
app.get('/api/customers',auth,(req,res)=>{ const q=(req.query.q||'').trim(); const rows=q?db.prepare(`SELECT * FROM customers WHERE first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY last_name,first_name LIMIT 100`).all(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`):db.prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT 100').all(); res.json(rows); });
app.get('/api/customers/:id/history',auth,(req,res)=>res.json(db.prepare('SELECT id,amount_cents/100.0 AS amount,points,created_at FROM purchases WHERE customer_id=? ORDER BY created_at DESC').all(req.params.id)));
app.post('/api/purchases',auth,(req,res)=>{
 const {customer_id,amount}=req.body; const cents=Math.round(Number(amount)*100); if(!customer_id||!Number.isFinite(cents)||cents<=0)return res.status(400).json({error:'Montant invalide'}); const points=Math.floor(cents/100);
 const tx=db.transaction(()=>{db.prepare('INSERT INTO purchases(customer_id,amount_cents,points) VALUES(?,?,?)').run(customer_id,cents,points); db.prepare('UPDATE customers SET points=points+? WHERE id=?').run(points,customer_id);}); tx(); res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id));
});
app.get('/api/rewards',auth,(req,res)=>res.json(db.prepare('SELECT * FROM rewards ORDER BY points_cost').all()));
app.post('/api/rewards',auth,adminOnly,(req,res)=>{const {name,points_cost,value_euros}=req.body;const p=Number(points_cost),v=Math.round(Number(value_euros)*100);if(!name||p<=0||v<=0)return res.status(400).json({error:'Données invalides'});const r=db.prepare('INSERT INTO rewards(name,points_cost,value_cents) VALUES(?,?,?)').run(name,p,v);res.json(db.prepare('SELECT * FROM rewards WHERE id=?').get(r.lastInsertRowid));});
app.post('/api/redemptions',auth,(req,res)=>{const {customer_id,reward_id}=req.body;const c=db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id),r=db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').get(reward_id);if(!c||!r)return res.status(404).json({error:'Cliente ou récompense introuvable'});if(c.points<r.points_cost)return res.status(400).json({error:'Points insuffisants'});const tx=db.transaction(()=>{db.prepare('INSERT INTO redemptions(customer_id,reward_id,points_used,value_cents) VALUES(?,?,?,?)').run(c.id,r.id,r.points_cost,r.value_cents);db.prepare('UPDATE customers SET points=points-? WHERE id=?').run(r.points_cost,c.id);});tx();res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(c.id));});
app.get('/api/stats',auth,(req,res)=>{const customers=db.prepare('SELECT COUNT(*) n FROM customers').get().n;const sales=db.prepare('SELECT COALESCE(SUM(amount_cents),0)/100.0 total,COUNT(*) n FROM purchases').get();const points=db.prepare('SELECT COALESCE(SUM(points),0) n FROM customers').get().n;res.json({customers,sales:sales.n,total:sales.total,points});});
app.get('/api/export.csv',auth,(req,res)=>{const rows=db.prepare('SELECT first_name,last_name,phone,email,birth_date,points,created_at FROM customers ORDER BY last_name,first_name').all();const esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';const csv='\ufeff'+['Prénom;Nom;Téléphone;E-mail;Date de naissance;Points;Inscription',...rows.map(r=>[r.first_name,r.last_name,r.phone,r.email,r.birth_date,r.points,r.created_at].map(esc).join(';'))].join('\n');res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="esprit-mode-clientes.csv"').send(csv);});
app.get('/api/users',auth,adminOnly,(req,res)=>res.json(db.prepare('SELECT id,username,role FROM users ORDER BY username').all()));
app.post('/api/users',auth,adminOnly,(req,res)=>{const {username,password,role='seller'}=req.body;if(!username||!password||!['admin','seller'].includes(role))return res.status(400).json({error:'Identifiants invalides'});try{db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(username,hash(password),role);res.json({ok:true});}catch(e){res.status(409).json({error:'Cet utilisateur existe déjà'});}});
app.get('/api/qr/:id',auth,async (req,res)=>{ const c=db.prepare('SELECT public_token FROM customers WHERE id=?').get(req.params.id); if(!c) return res.status(404).end(); const data=publicUrl(c.public_token, req); try { const png=await QRCode.toBuffer(data,{type:'png',width:400,margin:2}); res.type('png').send(png); } catch(e) { res.status(500).json({error:'QR code impossible à générer'}); } });

app.listen(PORT,HOST,()=>console.log(`Esprit Mode: http://${HOST}:${PORT}`));
