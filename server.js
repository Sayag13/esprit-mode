const express=require('express');
const path=require('path');
const crypto=require('crypto');
const QRCode=require('qrcode');
const fs=require('fs');
const {Pool}=require('pg');

const app=express();
const PORT=Number(process.env.PORT||3000),HOST='0.0.0.0';
const DATA_DIR=process.env.DATA_DIR||(fs.existsSync('/var/data')?'/var/data':__dirname);
try{fs.mkdirSync(DATA_DIR,{recursive:true})}catch(e){console.error('DATA_DIR:',e.message)}
const DB_FILE=process.env.DB_FILE||path.join(DATA_DIR,'esprit-mode-data.json');
const DATABASE_URL=String(process.env.DATABASE_URL||'').trim();
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false},max:3,idleTimeoutMillis:30000,connectionTimeoutMillis:10000}):null;

let db={customers:[],purchases:[],users:[],rewards:[],redemptions:[],campaigns:[],seq:{customers:1,purchases:1,users:1,rewards:1,redemptions:1,campaigns:1}};

function normalizeDb(x){
  const base={customers:[],purchases:[],users:[],rewards:[],redemptions:[],campaigns:[],seq:{customers:1,purchases:1,users:1,rewards:1,redemptions:1,campaigns:1}};
  const d={...base,...(x||{})};
  d.customers=Array.isArray(d.customers)?d.customers:[];
  d.purchases=Array.isArray(d.purchases)?d.purchases:[];
  d.users=Array.isArray(d.users)?d.users:[];
  d.rewards=Array.isArray(d.rewards)?d.rewards:[];
  d.redemptions=Array.isArray(d.redemptions)?d.redemptions:[];
  d.campaigns=Array.isArray(d.campaigns)?d.campaigns:[];
  d.seq={...base.seq,...(d.seq||{})};
  return d;
}

async function loadDb(){
  if(pool){
    await pool.query(`CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    const r=await pool.query('SELECT data FROM app_state WHERE id=1');
    if(r.rows[0]?.data){db=normalizeDb(r.rows[0].data);return;}
    db=normalizeDb(db);
    await pool.query('INSERT INTO app_state(id,data) VALUES(1,$1::jsonb) ON CONFLICT(id) DO NOTHING',[JSON.stringify(db)]);
    return;
  }
  try{if(fs.existsSync(DB_FILE))db=normalizeDb(JSON.parse(fs.readFileSync(DB_FILE,'utf8')))}catch(e){console.error('DB read:',e.message)}
}

function save(){
  if(pool){
    pool.query('INSERT INTO app_state(id,data,updated_at) VALUES(1,$1::jsonb,now()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()',[JSON.stringify(db)]).catch(e=>console.error('Postgres write:',e.message));
    return;
  }
  try{fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2))}catch(e){console.error('DB write:',e.message)}
}

function id(t){return db.seq[t]++}
function hash(p){return crypto.createHash('sha256').update(String(p)).digest('hex')}
function token(){return crypto.randomBytes(18).toString('hex')}

async function bootstrap(){
  await loadDb();
  let changed=false;

  // Comptes professionnels initiaux demandés pour la boutique.
  // Les mots de passe sont stockés uniquement sous forme de hash SHA-256.
  const staff=[
    {username:'admin',password:'1326',role:'admin',display_name:'Élie'},
    {username:'mimi',password:'0912',role:'manager',display_name:'Michelle'},
    {username:'elodiev',password:'9459',role:'seller',display_name:'Vendeuse 1'},
    {username:'elodier',password:'9447',role:'seller',display_name:'Vendeuse 2'}
  ];
  for(const wanted of staff){
    const existing=db.users.find(x=>x.username===wanted.username);
    if(existing){
      if(existing.password_hash!==hash(wanted.password)||existing.role!==wanted.role||existing.display_name!==wanted.display_name){
        existing.password_hash=hash(wanted.password);
        existing.role=wanted.role;
        existing.display_name=wanted.display_name;
        changed=true;
      }
    }else{
      db.users.push({id:id('users'),username:wanted.username,password_hash:hash(wanted.password),role:wanted.role,display_name:wanted.display_name});
      changed=true;
    }
  }

  if(!db.rewards.length){db.rewards.push({id:id('rewards'),name:'Bon de 10 €',points_cost:100,value_cents:1000,active:1});changed=true}
  if(changed){
    if(pool){
      await pool.query('INSERT INTO app_state(id,data,updated_at) VALUES(1,$1::jsonb,now()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()',[JSON.stringify(db)]);
    }else save();
  }
}

app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(q,s)=>s.json({ok:true,service:'esprit-mode',version:'0.7.4',storage:pool?'postgres':'file'}));

function auth(req,res,next){const h=req.headers.authorization||'';if(!h.startsWith('Basic '))return res.status(401).set('WWW-Authenticate','Basic realm="Esprit Mode"').json({error:'Connexion requise'});const raw=Buffer.from(h.slice(6),'base64').toString(),i=raw.indexOf(':'),u=raw.slice(0,i),p=raw.slice(i+1),user=db.users.find(x=>x.username===u&&x.password_hash===hash(p));if(!user)return res.status(401).set('WWW-Authenticate','Basic realm="Esprit Mode"').json({error:'Identifiants incorrects'});req.user={id:user.id,username:user.username,role:user.role,display_name:user.display_name||user.username};next()}
function allow(...roles){return (req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:'Accès non autorisé'})}
const adminOnly=allow('admin'),managerOnly=allow('admin','manager'),salesOnly=allow('admin','manager','seller');
function publicUrl(t,req){return `${(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'')}/carte.html?token=${encodeURIComponent(t)}`}

app.get('/api/me',auth,(req,res)=>res.json({id:req.user.id,username:req.user.username,role:req.user.role,display_name:req.user.display_name}));
app.post('/api/public/register',(req,res)=>{const x=req.body||{};if(!x.first_name||!x.last_name||!x.phone)return res.status(400).json({error:'Prénom, nom et téléphone sont obligatoires'});if(db.customers.some(c=>c.phone===String(x.phone).trim()))return res.status(409).json({error:'Ce numéro de téléphone est déjà enregistré.'});const c={id:id('customers'),first_name:String(x.first_name).trim(),last_name:String(x.last_name).trim(),phone:String(x.phone).trim(),email:String(x.email||'').trim(),birth_date:String(x.birth_date||''),marketing_email:!!x.marketing_email,marketing_sms:!!x.marketing_sms,points:0,public_token:token(),created_at:new Date().toISOString()};db.customers.push(c);save();res.json({token:c.public_token,customer:c})});
app.get('/api/public/customer/token/:token',(req,res)=>{const c=db.customers.find(x=>x.public_token===req.params.token);if(!c)return res.status(404).json({error:'Carte introuvable'});res.json({customer:c,history:db.purchases.filter(x=>x.customer_id===c.id).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,20).map(x=>({...x,amount:x.amount_cents/100})),rewards:db.rewards.filter(x=>x.active)});});
app.get('/api/customers',auth,salesOnly,(req,res)=>{const q=String(req.query.q||'').toLowerCase();let a=db.customers;if(q)a=a.filter(c=>[c.first_name,c.last_name,c.phone,c.email].some(v=>String(v).toLowerCase().includes(q)));res.json(a.sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,100))});
app.post('/api/customers',auth,managerOnly,(req,res)=>{const x=req.body||{};if(!x.first_name||!x.last_name||!x.phone)return res.status(400).json({error:'Prénom, nom et téléphone obligatoires'});if(db.customers.some(c=>c.phone===x.phone))return res.status(409).json({error:'Ce numéro existe déjà'});const c={id:id('customers'),first_name:x.first_name,last_name:x.last_name,phone:x.phone,email:x.email||'',birth_date:x.birth_date||'',marketing_email:!!x.marketing_email,marketing_sms:!!x.marketing_sms,points:0,public_token:token(),created_at:new Date().toISOString()};db.customers.push(c);save();res.json(c)});
app.get('/api/customers/:id/history',auth,salesOnly,(req,res)=>res.json(db.purchases.filter(x=>x.customer_id===Number(req.params.id)).sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(x=>({...x,amount:x.amount_cents/100}))));
app.post('/api/purchases',auth,salesOnly,(req,res)=>{const customer_id=Number(req.body.customer_id),amount=Number(req.body.amount),c=db.customers.find(x=>x.id===customer_id);if(!c||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Montant invalide'});const cents=Math.round(amount*100),points=Math.floor(cents/100);db.purchases.push({id:id('purchases'),customer_id,amount_cents:cents,points,created_at:new Date().toISOString(),by_user:req.user.username});c.points+=points;save();res.json(c)});
app.get('/api/rewards',auth,salesOnly,(req,res)=>res.json(db.rewards.filter(x=>x.active)));app.post('/api/rewards',auth,adminOnly,(req,res)=>{const p=Number(req.body.points_cost),v=Math.round(Number(req.body.value_euros)*100);if(!req.body.name||p<=0||v<=0)return res.status(400).json({error:'Données invalides'});const r={id:id('rewards'),name:req.body.name,points_cost:p,value_cents:v,active:1};db.rewards.push(r);save();res.json(r)});
app.post('/api/redemptions',auth,salesOnly,(req,res)=>{const c=db.customers.find(x=>x.id===Number(req.body.customer_id)),r=db.rewards.find(x=>x.id===Number(req.body.reward_id)&&x.active);if(!c||!r)return res.status(404).json({error:'Cliente ou récompense introuvable'});if(c.points<r.points_cost)return res.status(400).json({error:'Points insuffisants'});db.redemptions.push({id:id('redemptions'),customer_id:c.id,reward_id:r.id,points_used:r.points_cost,value_cents:r.value_cents,created_at:new Date().toISOString(),by_user:req.user.username});c.points-=r.points_cost;save();res.json(c)});
app.get('/api/stats',auth,adminOnly,(req,res)=>{const total=db.purchases.reduce((n,x)=>n+x.amount_cents,0)/100;res.json({customers:db.customers.length,sales:db.purchases.length,total,points:db.customers.reduce((n,x)=>n+x.points,0)})});
app.get('/api/export.csv',auth,adminOnly,(req,res)=>{const esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';const csv='\ufeff'+['Prénom;Nom;Téléphone;E-mail;Date de naissance;Points;Inscription',...db.customers.map(r=>[r.first_name,r.last_name,r.phone,r.email,r.birth_date,r.points,r.created_at].map(esc).join(';'))].join('\n');res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="esprit-mode-clientes.csv"').send(csv)});
app.get('/api/users',auth,adminOnly,(req,res)=>res.json(db.users.map(x=>({id:x.id,username:x.username,role:x.role,display_name:x.display_name||x.username}))));
app.post('/api/users',auth,adminOnly,(req,res)=>{const {username,password,role='seller',display_name=''}=req.body;if(!username||!password||!['admin','manager','seller'].includes(role))return res.status(400).json({error:'Identifiants ou rôle invalides'});if(db.users.some(x=>x.username===username))return res.status(409).json({error:'Cet utilisateur existe déjà'});if(role==='seller'&&db.users.filter(x=>x.role==='seller').length>=2)return res.status(400).json({error:'Maximum 2 comptes vendeuse autorisés.'});db.users.push({id:id('users'),username,password_hash:hash(password),role,display_name:display_name||username});save();res.json({ok:true})});
app.get('/api/qr/:id',auth,salesOnly,async(req,res)=>{const c=db.customers.find(x=>x.id===Number(req.params.id));if(!c)return res.status(404).end();try{const png=await QRCode.toBuffer(publicUrl(c.public_token,req),{width:320,margin:2});res.type('png').send(png)}catch(e){res.status(500).json({error:'QR indisponible'})}});
app.get('/api/campaigns',auth,managerOnly,(req,res)=>res.json(db.campaigns.sort((a,b)=>b.created_at.localeCompare(a.created_at))));
app.post('/api/campaigns',auth,managerOnly,(req,res)=>{const x=req.body||{};if(!x.title||!x.message)return res.status(400).json({error:'Titre et message obligatoires'});const c={id:id('campaigns'),title:String(x.title).trim(),message:String(x.message).trim(),media_url:String(x.media_url||'').trim(),channels:{email:!!x.email,sms:!!x.sms,whatsapp:!!x.whatsapp,facebook:!!x.facebook,instagram:!!x.instagram},status:'brouillon',created_at:new Date().toISOString(),created_by:req.user.username};db.campaigns.push(c);save();res.json(c)});
app.post('/api/campaigns/:id/status',auth,managerOnly,(req,res)=>{const c=db.campaigns.find(x=>x.id===Number(req.params.id));if(!c)return res.status(404).json({error:'Campagne introuvable'});if(!['brouillon','prete'].includes(req.body.status))return res.status(400).json({error:'Statut invalide'});c.status=req.body.status;save();res.json(c)});

bootstrap().then(()=>app.listen(PORT,HOST,()=>console.log(`Esprit Mode v0.7.4: http://${HOST}:${PORT} storage=${pool?'postgres':'file'}`))).catch(e=>{console.error('Startup:',e);process.exit(1)});
