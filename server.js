const express=require('express');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {Pool}=require('pg');

const app=express();
const PORT=process.env.PORT||10000;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'';
const GROQ_API_KEY=process.env.GROQ_API_KEY||'';
const GROQ_MODEL=process.env.GROQ_MODEL||'openai/gpt-oss-20b';
const TELEGRAM_BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
const TELEGRAM_WEBHOOK_SECRET=process.env.TELEGRAM_WEBHOOK_SECRET||'';
const TELEGRAM_WEBHOOK_URL=process.env.TELEGRAM_WEBHOOK_URL||'https://ekool-server.onrender.com/api/telegram/webhook';
const TELEGRAM_COINS_BOT_TOKEN=process.env.TELEGRAM_COINS_BOT_TOKEN||'';
const TELEGRAM_COINS_WEBHOOK_SECRET=process.env.TELEGRAM_COINS_WEBHOOK_SECRET||'';
const TELEGRAM_COINS_WEBHOOK_URL=process.env.TELEGRAM_COINS_WEBHOOK_URL||'https://ekool-server.onrender.com/api/telegram/coins-webhook';
const TELEGRAM_MARKET_BOT_TOKEN=process.env.TELEGRAM_MARKET_BOT_TOKEN||'';
const TELEGRAM_MARKET_WEBHOOK_SECRET=process.env.TELEGRAM_MARKET_WEBHOOK_SECRET||'';
const TELEGRAM_MARKET_WEBHOOK_URL=process.env.TELEGRAM_MARKET_WEBHOOK_URL||'https://ekool-server.onrender.com/api/telegram/market-webhook';

const DONATE_URL=process.env.DONATE_URL||'https://ekool-site.onrender.com/';
const TELEGRAM_ADMIN_IDS=String(process.env.TELEGRAM_ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
const TELEGRAM_SERVICE_CHAT_ID=String(process.env.TELEGRAM_SERVICE_CHAT_ID||'').trim();

const DATA_DIR=path.join(__dirname,'data');
const DATA_FILE=path.join(DATA_DIR,'db.json');
fs.mkdirSync(DATA_DIR,{recursive:true});

let fileDb={};
try{fileDb=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))||{}}catch(e){fileDb={}};
let writeChain=Promise.resolve();

function persistFile(){
  writeChain=writeChain.then(()=>fs.promises.writeFile(DATA_FILE,JSON.stringify(fileDb),'utf8')).catch(()=>{});
  return writeChain;
}
function fileCol(c){return fileDb[c]||(fileDb[c]={})}

const DATABASE_URL=process.env.DATABASE_URL||'';
const usePg=!!DATABASE_URL;
const pool=usePg?new Pool({
  connectionString:DATABASE_URL,
  ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined,
  max:5
}):null;

async function initDb(){
  if(!pool){
    if(fileDb.email_verifications)delete fileDb.email_verifications;
    for(const id of Object.keys(fileCol('users'))){if(fileCol('users')[id]&&Object.prototype.hasOwnProperty.call(fileCol('users')[id],'email')){delete fileCol('users')[id].email}}
    await persistFile();
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ekoool_kv(
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY(collection,id)
    )
  `);
  await pool.query("DELETE FROM ekoool_kv WHERE collection='email_verifications'");
  await pool.query("UPDATE ekoool_kv SET data = data - 'email' WHERE collection='users' AND data ? 'email'");
  const n=await pool.query('SELECT COUNT(*)::int AS n FROM ekoool_kv');
  if(n.rows[0].n===0 && Object.keys(fileDb).length){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      for(const [collection,docs] of Object.entries(fileDb)){
        if(collection==='email_verifications')continue;
        for(const [id,data] of Object.entries(docs||{})){
          const clean={...(data||{})};
          if(collection==='users')delete clean.email;
          await client.query(
            'INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [collection,id,JSON.stringify(clean)]
          );
        }
      }
      await client.query('COMMIT');
      console.log('EKOOOL: existing JSON data migrated to PostgreSQL');
    }catch(e){
      await client.query('ROLLBACK');
      console.error('EKOOOL migration failed:',e.message);
    }finally{client.release()}
  }
}

async function getDoc(c,id){
  if(!pool)return fileCol(c)[id]??null;
  const r=await pool.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2',[c,id]);
  return r.rows[0]?.data??null;
}
async function putDoc(c,id,data){
  if(!pool){fileCol(c)[id]=data||{};await persistFile();return}
  await pool.query(
    'INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3) ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data',
    [c,id,JSON.stringify(data||{})]
  );
}
async function patchDoc(c,id,patch){
  if(!pool){
    fileCol(c)[id]={...(fileCol(c)[id]||{}),...(patch||{})};
    await persistFile();
    return;
  }
  const old=await getDoc(c,id);
  const data={...(old||{}),...(patch||{})};
  await putDoc(c,id,data);
}
async function deleteDoc(c,id){
  if(!pool){delete fileCol(c)[id];await persistFile();return}
  await pool.query('DELETE FROM ekoool_kv WHERE collection=$1 AND id=$2',[c,id]);
}
async function getCollection(c){
  if(!pool)return Object.entries(fileCol(c)).map(([id,data])=>({id,data}));
  const r=await pool.query('SELECT id,data FROM ekoool_kv WHERE collection=$1',[c]);
  return r.rows.map(x=>({id:x.id,data:x.data}));
}

const SESSION_COOKIE='__Host-EKOOOL-SESSION';
const SESSION_TTL=30*24*60*60*1000;
function readCookie(req,name){
  const raw=String(req.headers.cookie||'');
  for(const part of raw.split(';')){
    const i=part.indexOf('=');
    if(i<0)continue;
    if(part.slice(0,i).trim()===name)return decodeURIComponent(part.slice(i+1).trim());
  }
  return '';
}
const sessionHash=t=>crypto.createHash('sha256').update(String(t)).digest('hex');
function setSessionCookie(res,token){
  res.setHeader('Set-Cookie',SESSION_COOKIE+'='+encodeURIComponent(token)+'; Max-Age='+Math.floor(SESSION_TTL/1000)+'; Path=/; Secure; HttpOnly; SameSite=Lax');
}
function clearSessionCookie(res){
  res.setHeader('Set-Cookie',SESSION_COOKIE+'=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax');
}
async function createSession(uid){
  const token=crypto.randomBytes(32).toString('hex'),sid=sessionHash(token);
  await putDoc('sessions',sid,{uid:String(uid),expires:Date.now()+SESSION_TTL});
  return token;
}
async function sessionAuth(req){
  const token=readCookie(req,SESSION_COOKIE);
  if(!token)return null;
  const sid=sessionHash(token),s=await getDoc('sessions',sid);
  if(!s||s.expires<Date.now()){if(s)await deleteDoc('sessions',sid);return null}
  const u=await getDoc('users',String(s.uid));
  return u&&u.passHash?{id:String(s.uid),...u}:null;
}
function adminToken(){return crypto.createHmac('sha256',ADMIN_PASSWORD).update('ekoool-admin').digest('hex')}
function isAdmin(req){return !!ADMIN_PASSWORD&&(req.headers.authorization||'')==='Bearer '+adminToken()}
async function userAuth(req){
  const session=await sessionAuth(req);
  if(session)return session;
  const uid=String(req.headers['x-ekoool-user']||'').trim();
  const proof=String(req.headers['x-ekoool-proof']||'').trim();
  if(!uid||!proof)return null;
  const u=await getDoc('users',uid);
  return u&&u.passHash&&proof===u.passHash?{id:uid,...u}:null;
}
function publicUser(u){if(!u)return null;const x={...u};delete x.passHash;delete x.salt;delete x.email;x.tester=!!(u.tester||u.testerBadge);return x}
async function canWriteDoc(req,c,id,body){
  if(isAdmin(req))return true;
  const u=await userAuth(req);
  if(!u){
    if(c==='users'){
      return false;
    }
    if(c==='usernames'&&body?.uid){
      const target=await getDoc('users',String(body.uid));
      return !!target&&!!target.passHash&&Date.now()-(target.ts||0)<10*60*1000&&!await getDoc(c,id);
    }
    return false;
  }
  if(c==='users')return id===u.id;
  if(c==='usernames'){
    if(body&&body.uid)return body.uid===u.id;
    const old=await getDoc(c,id);return !old||old.uid===u.id;
  }
  if(c==='msgs'){
    const dmLock=await getDoc('config','dm_lock');
    if(dmLock?.closed&&!isAdmin(req)){
      const old=await getDoc(c,id);
      if(!old)return false;
    }
  }
  if(['msgs','gmsgs','gm'].includes(c)){
    const old=await getDoc(c,id);const d=body&&Object.keys(body).length?{...(old||{}),...body}:old;
    return !!d&&(d.a===u.id||d.b===u.id||d.uid===u.id);
  }
  if(c==='txs')return !body?.uid||body.uid===u.id;
  if(c==='groups'){
    const old=await getDoc(c,id);const d={...(old||{}),...(body||{})};
    return d.owner===u.id;
  }
  return false;
}
const loginAttempts=new Map();
function adminLoginAllowed(ip){
  const now=Date.now(),a=loginAttempts.get(ip)||{n:0,at:now};
  if(now-a.at>10*60*1000){a.n=0;a.at=now}
  if(a.n>=10)return false;
  a.n++;loginAttempts.set(ip,a);return true;
}

app.use(express.json({limit:'12mb'}));
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET,PUT,PATCH,DELETE,POST,OPTIONS');
  if(req.method==='OPTIONS')return res.sendStatus(204);
  next();
});

app.post('/api/auth/register/complete',async(req,res)=>{
  try{
    const name=String(req.body?.name||'').trim();
    const username=String(req.body?.username||'').trim().toLowerCase().replace(/^@/,'');
    const password=String(req.body?.password||'');
    if(!name||!/^[a-z][a-z0-9_]{3,19}$/.test(username)||password.length<6)return res.status(400).json({error:'Проверьте имя, юзернейм и пароль',code:'invalid_registration'});
    if(await getDoc('usernames',username))return res.status(409).json({error:'Юзернейм занят',code:'username_taken'});
    const id='EK-'+Array.from({length:8},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(0,32)]).join('');
    const salt=crypto.randomBytes(8).toString('hex');
    const passHash=crypto.createHash('sha256').update(salt+password).digest('hex');
    const now=Date.now();
    const user={name,photo:'',bio:'',verified:false,purchased:false,coins:1000,username,extra:[],salt,passHash,lastSeen:now,ts:now};
    await putDoc('users',id,user);
    await putDoc('usernames',username,{uid:id});
    try{await putDoc('gm','G-JEKD6P_'+id,{gid:'G-JEKD6P',uid:id,ts:now})}catch(e){}
    try{await putDoc('msgs','m'+now+crypto.randomBytes(3).toString('hex'),{chat:[id,'botregistor'].sort().join('_'),a:'botregistor',b:id,ts:now,type:'text',text:'✅ Регистрация прошла успешно!\\nВаш аккаунт @'+username+' создан. Добро пожаловать в EKOOOL!',bot:true})}catch(e){}
    setSessionCookie(res,await createSession(id));
    res.json({ok:true,id});
  }catch(e){res.status(500).json({error:e.message||'Не удалось зарегистрировать аккаунт',code:'registration_failed'})}
});

app.post('/api/telegram/link/claim',async(req,res)=>{
  try{
    const u=await userAuth(req);
    if(!u)return res.status(401).json({error:'Unauthorized'});
    const token=String(req.body?.token||'').trim();
    const data=await getDoc('telegram_link_tokens',token);
    if(!token||!data||data.expires<Date.now()||String(data.uid)!==String(u.id))return res.status(400).json({error:'Ссылка недействительна или устарела'});
    await patchDoc('users',String(u.id),{telegramChatId:String(data.chatId),telegramLinkedAt:Date.now()});
    await deleteDoc('telegram_link_tokens',token);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message})}
});

async function loginCity(req){
  try{
    const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
    const ip=forwarded||String(req.ip||'').replace(/^::ffff:/,'');
    if(!ip||ip==='127.0.0.1'||ip==='::1')return 'Город не определён';
    const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),3500);
    const r=await fetch('https://ipapi.co/'+encodeURIComponent(ip)+'/json/',{signal:ac.signal,headers:{'User-Agent':'EKOOOL-BotRegistor/1.0'}});
    clearTimeout(tm);
    const x=await r.json().catch(()=>({}));
    return String(x.city||x.region||'Город не определён').trim()||'Город не определён';
  }catch(e){return 'Город не определён'}
}
app.post('/api/security/login-event',async(req,res)=>{
  try{
    const uid=String(req.body?.uid||'').trim(),proof=String(req.body?.proof||'').trim();
    const u=await getDoc('users',uid);
    if(!uid||!proof||!u||!u.passHash||proof!==u.passHash)return res.status(401).json({error:'Unauthorized'});
    const device=String(req.body?.device||'Неизвестное устройство').trim().slice(0,180)||'Неизвестное устройство';
    const city=await loginCity(req);
    const kind=String(req.body?.kind||'login')==='registration'?'Регистрация':'Вход';
    const username=u.username?'@'+u.username:u.id;
    const text=(kind==='Регистрация'?'🆕 Регистрация аккаунта':'🔐 Выполнен вход в ваш аккаунт')+' в EKOOOL.\\nВремя: '+new Date().toLocaleString('ru-RU')+'\\n📱 Устройство: '+device+'\\n📍 Город: '+city+'\\n\\nЕсли это были не вы — напишите прямо в этом мессенджере владельцу @ekoool_9d1854c5dd.';
    await putDoc('msgs','m'+Date.now()+crypto.randomBytes(3).toString('hex'),{chat:[uid,'botregistor'].sort().join('_'),a:'botregistor',b:uid,ts:Date.now(),type:'text',text,bot:true});
    res.json({ok:true,city});
  }catch(e){res.status(500).json({error:e.message||'Не удалось записать событие входа'})}
});

app.post('/api/security/transaction-event',async(req,res)=>{
  try{
    const actor=await userAuth(req);
    if(!actor)return res.status(401).json({error:'Unauthorized'});
    const targetId=String(req.body?.targetId||actor.id).trim();
    const amount=Number(req.body?.amount);
    if(!targetId||!(amount<0))return res.status(400).json({error:'Invalid transaction'});
    const target=await getDoc('users',targetId);
    if(!target)return res.status(404).json({error:'User not found'});
    const device=String(req.body?.device||'Неизвестное устройство').trim().slice(0,180)||'Неизвестное устройство';
    const city=await loginCity(req);
    const note=String(req.body?.note||'Списание коинов').trim().slice(0,240)||'Списание коинов';
    const when=new Date().toLocaleString('ru-RU');
    const targetName=target.username?'@'+target.username:(target.name||target.id);
    const actorName=actor.username?'@'+actor.username:(actor.name||actor.id);
    const who=actor.id===targetId?targetName:(targetName+' (действие '+actorName+')');
    const text='💸 Списание ЕКОКоинов\n\n👤 Аккаунт: '+who+'\n💰 Сумма: '+Math.abs(amount)+' ЕКОКоинов\n📍 Куда/за что: '+note+'\n🕒 Когда: '+when+'\n📱 Устройство: '+device+'\n📍 Геопозиция: '+city+' (примерно по IP)';
    await putDoc('msgs','m'+Date.now()+crypto.randomBytes(3).toString('hex'),{chat:[targetId,'tranzaction'].sort().join('_'),a:'tranzaction',b:targetId,ts:Date.now(),type:'text',text,bot:true});
    res.json({ok:true,city});
  }catch(e){res.status(500).json({error:e.message||'Не удалось записать транзакцию'})}
});

app.post('/api/auth/session',async(req,res)=>{
  try{
    const uid=String(req.body?.uid||'').trim(),proof=String(req.body?.proof||'').trim();
    const u=await getDoc('users',uid);
    if(!uid||!proof||!u||!u.passHash||proof!==u.passHash)return res.status(401).json({error:'Unauthorized'});
    setSessionCookie(res,await createSession(uid));
    res.json({ok:true,id:uid});
  }catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/auth/session',async(req,res)=>{
  try{
    const u=await userAuth(req);
    if(!u)return res.status(401).json({error:'Unauthorized'});
    res.json({ok:true,id:u.id});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/auth/logout',async(req,res)=>{
  try{
    const token=readCookie(req,SESSION_COOKIE);
    if(token)await deleteDoc('sessions',sessionHash(token));
    clearSessionCookie(res);
    res.json({ok:true});
  }catch(e){clearSessionCookie(res);res.status(500).json({error:e.message})}
});
app.post('/api/admin/login',(req,res)=>{
  if(!ADMIN_PASSWORD)return res.status(503).json({error:'ADMIN_PASSWORD не настроен'});
  if(!adminLoginAllowed(req.ip))return res.status(429).json({error:'Слишком много попыток. Повторите позже.'});
  if(String(req.body?.password||'')!==ADMIN_PASSWORD)return res.status(401).json({error:'Неверный пароль'});
  res.json({token:adminToken()});
});
app.get('/api/admin/check',(req,res)=>isAdmin(req)?res.json({ok:true}):res.status(401).json({error:'Unauthorized'}));
app.patch('/api/admin/user-label/:id',async(req,res)=>{try{if(!isAdmin(req))return res.status(401).json({error:'Unauthorized'});const key=String(req.body?.key||'');if(!/^(verified|supportAgent|owner|ceo|red|tester|unknown|scam|fake|restricted|banned)$/.test(key))return res.status(400).json({error:'Invalid label'});const value=!!req.body?.value;await patchDoc('users',req.params.id,{[key]:value});res.json({ok:true,key,value})}catch(e){res.status(500).json({error:e.message})}});



const STORE_SESSION_TTL=30*24*60*60*1000;
const storeLoginAttempts=new Map();
function storeTokenHash(t){return crypto.createHash('sha256').update(String(t)).digest('hex')}
function storeLoginAllowed(ip){
  const now=Date.now(),key=String(ip||'unknown'),a=storeLoginAttempts.get(key)||{n:0,at:now};
  if(now-a.at>10*60*1000){a.n=0;a.at=now}
  if(a.n>=12)return false;
  a.n++;
  storeLoginAttempts.set(key,a);
  return true;
}
async function storeAuth(req){
  const h=String(req.headers.authorization||'');
  const m=h.match(/^Bearer\s+(.+)$/i);
  if(m){
    const raw=m[1].trim();
    if(raw){
      const sid=storeTokenHash(raw);
      const s=await getDoc('store_sessions',sid);
      if(s&&s.expires>Date.now()){
        const u=await getDoc('users',String(s.uid));
        if(u&&u.passHash){
          if(u.banned||Number(u.blockedUntil||0)>Date.now())return null;
          return {id:String(s.uid),...u};
        }
        await deleteDoc('store_sessions',sid);
      }else if(s){
        await deleteDoc('store_sessions',sid);
      }
    }
  }
  return await userAuth(req);
}
async function findStoreLoginUser(login){
  const raw=String(login||'').trim();
  const value=raw.toLowerCase().replace(/^@/,'');
  if(!value)return null;
  const map=await getDoc('usernames',value);
  if(map?.uid){
    const u=await getDoc('users',String(map.uid));
    if(u)return {id:String(map.uid),...u};
  }
  const docs=await getCollection('users');
  const normalized=raw.replace(/[\s-]/g,'');
  for(const x of docs){
    const u=x.data||{};
    const nums=[u.phone,u.phone2,u.phoneNumber,u.number].filter(Boolean).map(String);
    if(nums.some(n=>n===raw||n.replace(/[\s-]/g,'')===normalized))return {id:String(x.id),...u};
  }
  return null;
}
app.post('/api/store/login',async(req,res)=>{
  try{
    const ip=String(req.ip||req.socket?.remoteAddress||'unknown');
    if(!storeLoginAllowed(ip))return res.status(429).json({error:'Слишком много попыток входа. Попробуйте через 10 минут.'});
    const login=String(req.body?.username||req.body?.login||req.body?.phone||'').trim();
    const password=String(req.body?.password||'');
    if(!login||!password)return res.status(400).json({error:'Введите юзернейм/номер и пароль'});
    const u=await findStoreLoginUser(login);
    if(!u||!u.passHash)return res.status(401).json({error:'Неверный юзернейм/номер или пароль'});
    if(u.banned||Number(u.blockedUntil||0)>Date.now())return res.status(403).json({error:'Этот аккаунт временно недоступен.'});
    const salt=String(u.salt||'');
    const hash=crypto.createHash('sha256').update(salt+password).digest('hex');
    if(hash!==u.passHash)return res.status(401).json({error:'Неверный юзернейм/номер или пароль'});
    const raw=crypto.randomBytes(32).toString('hex');
    const expires=Date.now()+STORE_SESSION_TTL;
    await putDoc('store_sessions',storeTokenHash(raw),{uid:String(u.id),createdAt:Date.now(),expires});
    res.json({ok:true,token:raw,expiresAt:expires,user:storePublicUser(u)});
  }catch(e){res.status(500).json({error:e.message||'Ошибка входа'})}
});
app.post('/api/store/logout',async(req,res)=>{
  try{
    const h=String(req.headers.authorization||''),m=h.match(/^Bearer\s+(.+)$/i);
    if(m)await deleteDoc('store_sessions',storeTokenHash(m[1].trim()));
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message})}
});

const ECOTON_RATE=500;
function storePublicUser(u){
  return {id:u?.id||'',username:u?.username||'',name:u?.name||'',coins:Number(u?.coins||0),ecoton:Number(u?.ecoton||0),premium:!!(u?.premiumForever||u?.premiumUntil>Date.now())};
}
async function storeUser(req){return await storeAuth(req)}
app.get('/api/store/me',async(req,res)=>{
  try{
    const u=await storeUser(req);
    if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});
    res.json({ok:true,user:storePublicUser(u)});
  }catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/store/products',async(req,res)=>{
  try{
    const docs=await getCollection('store_products');
    const products=docs.map(x=>({id:x.id,...x.data})).filter(x=>x.active!==false&&Number(x.price)>0&&(x.stock==null||Number(x.stock)>0)).map(x=>({id:x.id,name:String(x.name||'Товар'),type:String(x.type||'other'),description:String(x.description||''),image:String(x.image||''),price:Number(x.price),stock:x.stock==null?null:Number(x.stock),deliveryType:String(x.deliveryType||'manual'),premium:!!x.premium}));
    res.json({ok:true,products});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/store/exchange',async(req,res)=>{
  try{
    const u=await storeUser(req); if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});
    const coins=Math.floor(Number(req.body?.coins));
    if(!Number.isFinite(coins)||coins<ECOTON_RATE||coins%ECOTON_RATE!==0)return res.status(400).json({error:'Обмен только кратно 500 ЭКОкоинов'});
    const add=coins/ECOTON_RATE;
    const ownerMap=await getDoc('usernames','owner');
    const ownerId=String(ownerMap?.uid||'');
    if(!ownerId)return res.status(503).json({error:'Аккаунт @owner не найден. Обмен временно недоступен.'});
    if(ownerId===String(u.id))return res.status(400).json({error:'@owner не может обменивать коины сам себе'});
    let next;
    if(pool){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const ids=[String(u.id),ownerId].sort();
        const rs=await client.query('SELECT id,data FROM ekoool_kv WHERE collection=$1 AND id=ANY($2::text[]) FOR UPDATE',['users',ids]);
        const rows=new Map(rs.rows.map(x=>[String(x.id),x.data]));
        const fresh=rows.get(String(u.id)),owner=rows.get(ownerId);
        if(!fresh)throw new Error('Аккаунт не найден');
        if(!owner)throw new Error('Аккаунт @owner не найден');
        const current=Number(fresh.coins||0);
        if(current<coins)throw new Error('Недостаточно ЭКОкоинов');
        next={...fresh,coins:current-coins,ecoton:Number(fresh.ecoton||0)+add};
        const ownerNext={...owner,coins:Number(owner.coins||0)+coins};
        await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['users',String(u.id),JSON.stringify(next)]);
        await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['users',ownerId,JSON.stringify(ownerNext)]);
        const txid='ex_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex');
        await client.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)',['ecoton_txs',txid,JSON.stringify({uid:u.id,ownerId,coins:-coins,ownerCoins:coins,ecoton:add,type:'exchange',ts:Date.now(),rate:ECOTON_RATE})]);
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
    }else{
      const current=Number(u.coins||0);
      if(current<coins)throw new Error('Недостаточно ЭКОкоинов');
      const owner=await getDoc('users',ownerId);
      if(!owner)throw new Error('Аккаунт @owner не найден');
      next={...u,coins:current-coins,ecoton:Number(u.ecoton||0)+add};
      await patchDoc('users',u.id,{coins:next.coins,ecoton:next.ecoton});
      await patchDoc('users',ownerId,{coins:Number(owner.coins||0)+coins});
      await putDoc('ecoton_txs','ex_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex'),{uid:u.id,ownerId,coins:-coins,ownerCoins:coins,ecoton:add,type:'exchange',ts:Date.now(),rate:ECOTON_RATE});
    }
    res.json({ok:true,user:storePublicUser({...u,...next}),message:'Обмен выполнен'});
  }catch(e){res.status(400).json({error:e.message||'Не удалось выполнить обмен'})}
});
app.post('/api/store/admin/product',async(req,res)=>{
  try{
    if(!isAdmin(req))return res.status(401).json({error:'Только администратор'});
    const name=String(req.body?.name||'').trim().slice(0,100),type=String(req.body?.type||'other').trim().slice(0,30),description=String(req.body?.description||'').trim().slice(0,1000),image=String(req.body?.image||'').trim().slice(0,1000),deliveryType=String(req.body?.deliveryType||'manual').trim().slice(0,30);
    const price=Math.floor(Number(req.body?.price)); const rawStock=req.body?.stock; const stock=rawStock==null||rawStock===''?null:Math.max(0,Math.floor(Number(rawStock)));
    const delivery=req.body?.delivery==null?null:String(req.body.delivery).slice(0,10000);
    if(!name||!Number.isFinite(price)||price<1)return res.status(400).json({error:'Неверные данные товара'});
    if(stock!==null&&!Number.isFinite(stock))return res.status(400).json({error:'Неверный остаток'});
    const id='prod_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex');
    await putDoc('store_products',id,{name,type,description,image,deliveryType,delivery,price,stock,active:true,createdAt:Date.now()});
    res.json({ok:true,id});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/store/buy',async(req,res)=>{
  try{
    const u=await storeUser(req);if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});
    const productId=String(req.body?.productId||'').trim();if(!productId)return res.status(400).json({error:'Не указан товар'});
    let order,delivery,remaining;
    if(pool){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const pr=await client.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2 FOR UPDATE',['store_products',productId]);
        const p=pr.rows[0]?.data;
        if(!p||p.active===false)throw new Error('Товар не найден');
        const sellerId=p.sellerId?String(p.sellerId):'';
        if(sellerId&&sellerId===String(u.id))throw new Error('Нельзя купить собственный товар');
        const ids=[String(u.id),...(sellerId?[sellerId]:[])].sort();
        const ur=await client.query('SELECT id,data FROM ekoool_kv WHERE collection=$1 AND id=ANY($2::text[]) FOR UPDATE',['users',ids]);
        const rows=new Map(ur.rows.map(x=>[String(x.id),x.data]));
        const fresh=rows.get(String(u.id)),seller=sellerId?rows.get(sellerId):null;
        if(!fresh)throw new Error('Аккаунт покупателя не найден');
        if(sellerId&&!seller)throw new Error('Аккаунт продавца не найден');
        const price=Math.floor(Number(p.price));
        if(!Number.isFinite(price)||price<1)throw new Error('Неверная цена товара');
        if(p.stock!=null&&Number(p.stock)<=0)throw new Error('Товар закончился');
        const balance=Number(fresh.ecoton||0);
        if(balance<price)throw new Error('Недостаточно ECOTon');
        remaining=balance-price;
        const orderId='order_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
        const nextProduct={...p};
        if(nextProduct.stock!=null)nextProduct.stock=Number(nextProduct.stock)-1;
        delivery=p.delivery==null?null:String(p.delivery);
        order={id:orderId,uid:String(u.id),productId,sellerId:sellerId||'',sellerUsername:String(p.sellerUsername||''),productName:String(p.name||'Товар'),type:String(p.type||'other'),price,status:'paid',createdAt:Date.now(),deliveryType:String(p.deliveryType||'manual')};
        await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['users',String(u.id),JSON.stringify({...fresh,ecoton:remaining})]);
        if(sellerId){
          await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['users',sellerId,JSON.stringify({...seller,ecoton:Number(seller.ecoton||0)+price})]);
        }
        await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['store_products',productId,JSON.stringify(nextProduct)]);
        await client.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)',['store_orders',orderId,JSON.stringify({...order,delivery})]);
        await client.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)',['ecoton_txs','buy_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex'),JSON.stringify({uid:u.id,ecoton:-price,type:'purchase',orderId,productId,sellerId:sellerId||null,ts:Date.now()})]);
        if(sellerId)await client.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)',['ecoton_txs','sale_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex'),JSON.stringify({uid:sellerId,from:u.id,ecoton:price,type:'sale',orderId,productId,ts:Date.now()})]);
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
    }else{
      const p=await getDoc('store_products',productId);
      if(!p||p.active===false)throw new Error('Товар не найден');
      const sellerId=p.sellerId?String(p.sellerId):'';
      if(sellerId&&sellerId===String(u.id))throw new Error('Нельзя купить собственный товар');
      const fresh=await getDoc('users',u.id),seller=sellerId?await getDoc('users',sellerId):null;
      if(!fresh)throw new Error('Аккаунт покупателя не найден');
      if(sellerId&&!seller)throw new Error('Аккаунт продавца не найден');
      const price=Math.floor(Number(p.price));
      if(!Number.isFinite(price)||price<1)throw new Error('Неверная цена товара');
      if(p.stock!=null&&Number(p.stock)<=0)throw new Error('Товар закончился');
      const balance=Number(fresh.ecoton||0);
      if(balance<price)throw new Error('Недостаточно ECOTon');
      remaining=balance-price;
      const orderId='order_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
      const nextProduct={...p};if(nextProduct.stock!=null)nextProduct.stock=Number(nextProduct.stock)-1;
      delivery=p.delivery==null?null:String(p.delivery);
      order={id:orderId,uid:String(u.id),productId,sellerId:sellerId||'',sellerUsername:String(p.sellerUsername||''),productName:String(p.name||'Товар'),type:String(p.type||'other'),price,status:'paid',createdAt:Date.now(),deliveryType:String(p.deliveryType||'manual')};
      await patchDoc('users',u.id,{ecoton:remaining});
      if(sellerId)await patchDoc('users',sellerId,{ecoton:Number(seller.ecoton||0)+price});
      await putDoc('store_products',productId,nextProduct);
      await putDoc('store_orders',orderId,{...order,delivery});
      await putDoc('ecoton_txs','buy_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex'),{uid:u.id,ecoton:-price,type:'purchase',orderId,productId,sellerId:sellerId||null,ts:Date.now()});
      if(sellerId)await putDoc('ecoton_txs','sale_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex'),{uid:sellerId,from:u.id,ecoton:price,type:'sale',orderId,productId,ts:Date.now()});
    }
    res.json({ok:true,orderId:order.id,remaining,delivery,deliveryType:order.deliveryType,sellerUsername:order.sellerUsername,message:'Покупка оформлена. Заказ #'+order.id});
  }catch(e){res.status(400).json({error:e.message||'Не удалось оформить покупку'})}
});
app.post('/api/store/sell',async(req,res)=>{
  try{
    const u=await storeUser(req);if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});
    if(u.banned||Number(u.blockedUntil||0)>Date.now()||u.bot||u.aiBot||u.type==='bot')return res.status(403).json({error:'Этот аккаунт не может продавать на Market'});
    const name=String(req.body?.name||'').trim().slice(0,100);
    const type=String(req.body?.type||'other').trim();
    const description=String(req.body?.description||'').trim().slice(0,1000);
    const image=String(req.body?.image||'').trim().slice(0,1000);
    const price=Math.floor(Number(req.body?.price));
    const rawStock=req.body?.stock;
    const stock=rawStock==null||rawStock===''?null:Math.floor(Number(rawStock));
    const delivery=String(req.body?.delivery||'').trim().slice(0,20000);
    const allowed=['username','number','account','channel','group','premium','gift','other'];
    if(!name||!allowed.includes(type)||!Number.isFinite(price)||price<1||price>1000000000)return res.status(400).json({error:'Проверьте название, категорию и цену'});
    if(stock!==null&&(!Number.isFinite(stock)||stock<1||stock>1000000))return res.status(400).json({error:'Остаток должен быть от 1 до 1 000 000 или пустым для ∞'});
    if(!delivery)return res.status(400).json({error:'Укажите данные, которые покупатель получит после оплаты'});
    const id='userprod_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
    await putDoc('store_products',id,{name,type,description,image,deliveryType:'instant',delivery,price,stock,active:true,sellerId:String(u.id),sellerUsername:String(u.username||''),createdAt:Date.now()});
    res.json({ok:true,id});
  }catch(e){res.status(500).json({error:e.message||'Не удалось выставить товар'})}
});
app.get('/api/store/my-listings',async(req,res)=>{
  try{
    const u=await storeUser(req);if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});
    const listings=(await getCollection('store_products')).map(x=>({id:x.id,...x.data})).filter(x=>String(x.sellerId||'')===String(u.id)).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,100);
    res.json({ok:true,listings});
  }catch(e){res.status(500).json({error:e.message})}
});
app.patch('/api/store/listings/:id',async(req,res)=>{
  try{
    const u=await storeUser(req);if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});
    const id=String(req.params.id),p=await getDoc('store_products',id);
    if(!p||String(p.sellerId||'')!==String(u.id))return res.status(404).json({error:'Объявление не найдено'});
    if(req.body?.active===false){await patchDoc('store_products',id,{active:false,cancelledAt:Date.now()});return res.json({ok:true})}
    return res.status(400).json({error:'Недопустимое изменение'});
  }catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/store/sales',async(req,res)=>{
  try{
    const u=await storeUser(req);if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});
    const sales=(await getCollection('store_orders')).map(x=>({id:x.id,...x.data})).filter(x=>String(x.sellerId||'')===String(u.id)).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,50).map(x=>({id:x.id,productName:x.productName,price:Number(x.price||0),status:x.status,createdAt:x.createdAt,buyerId:x.uid,delivery:x.delivery??null}));
    res.json({ok:true,sales});
  }catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/store/transactions',async(req,res)=>{
  try{
    const u=await storeAuth(req);if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});
    const rows=(await getCollection('ecoton_txs')).map(x=>({id:x.id,...x.data}))
      .filter(x=>String(x.uid||'')===String(u.id))
      .sort((a,b)=>Number(b.ts||0)-Number(a.ts||0)).slice(0,100);
    res.json({ok:true,transactions:rows});
  }catch(e){res.status(500).json({error:e.message||'Не удалось получить историю ECOTon'})}
});
app.get('/api/store/orders',async(req,res)=>{
  try{const u=await storeUser(req);if(!u)return res.status(401).json({error:'Войдите в EKOOOL'});const orders=(await getCollection('store_orders')).map(x=>({id:x.id,...x.data})).filter(x=>String(x.uid)===String(u.id)).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,50).map(x=>({id:x.id,productName:x.productName,type:x.type,price:Number(x.price||0),status:x.status,createdAt:x.createdAt,deliveryType:x.deliveryType||'manual',delivery:x.delivery??null}));res.json({ok:true,orders})}catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/doc/:collection/:id',async(req,res)=>{
  try{
    const c=req.params.collection,id=req.params.id;let data=await getDoc(c,id);
    if(['msgs','gmsgs','gm','txs'].includes(c)&&!isAdmin(req)){
      const u=await userAuth(req);if(!u)return res.status(401).json({error:'Unauthorized'});
      if(data&&(data.a!==u.id&&data.b!==u.id&&data.uid!==u.id))return res.status(403).json({error:'Forbidden'});
    }
    if(c==='users'&&!isAdmin(req)){
      const u=await userAuth(req);
      if(!u||u.id!==id)data=publicUser(data);
    }
    res.json({data})
  }catch(e){res.status(500).json({error:e.message})}
});
app.put('/api/doc/:collection/:id',async(req,res)=>{
  try{
    if(!(await canWriteDoc(req,req.params.collection,req.params.id,req.body||{})))return res.status(403).json({error:'Forbidden'});
    await putDoc(req.params.collection,req.params.id,req.body||{});res.json({ok:true})
  }catch(e){res.status(500).json({error:e.message})}
});
app.patch('/api/doc/:collection/:id',async(req,res)=>{
  try{
    if(!(await canWriteDoc(req,req.params.collection,req.params.id,req.body||{})))return res.status(403).json({error:'Forbidden'});
    await patchDoc(req.params.collection,req.params.id,req.body||{});res.json({ok:true})
  }catch(e){res.status(500).json({error:e.message})}
});
app.delete('/api/doc/:collection/:id',async(req,res)=>{
  try{
    if(!(await canWriteDoc(req,req.params.collection,req.params.id,{})))return res.status(403).json({error:'Forbidden'});
    await deleteDoc(req.params.collection,req.params.id);res.json({ok:true})
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/collection/:collection',async(req,res)=>{
  try{
    const c=req.params.collection;
    let w=req.query.where;
    let ws=Array.isArray(w)?w:(w?[w]:[]);
    const ops=Array.isArray(req.query.op)?req.query.op:[req.query.op||'=='];
    const vals=Array.isArray(req.query.value)?req.query.value:[req.query.value];
    const parsed=ws.map((k,i)=>{let want=vals[i];try{want=JSON.parse(want)}catch(e){}return {key:String(k),op:ops[i]||'==',value:want};}).filter(x=>x.key);
    const restricted=['msgs','gmsgs','gm','txs'].includes(c);
    const u=restricted?await userAuth(req):null;
    if(restricted&&!u&&!isAdmin(req))return res.status(401).json({error:'Unauthorized'});
    let docs;
    if(pool){
      const params=[c],conds=['collection=$1'];
      for(const f of parsed){
        if(f.op!=='=='&&f.op!=='!=')continue;
        params.push(f.key,JSON.stringify(f.value));
        const n=params.length-1;
        conds.push(f.op==='=='?'(data-> $'+n+') = $'+(n+1)+'::jsonb':'(data-> $'+n+') <> $'+(n+1)+'::jsonb');
      }
      if(restricted&&!isAdmin(req)){
        params.push(u.id);
        const n=params.length;
        conds.push("((data->>'a')=$"+n+" OR (data->>'b')=$"+n+" OR (data->>'uid')=$"+n+")");
      }
      const r=await pool.query('SELECT id,data FROM ekoool_kv WHERE '+conds.join(' AND '),params);
      docs=r.rows.map(x=>({id:x.id,data:x.data}));
    }else{
      docs=await getCollection(c);
      if(restricted&&!isAdmin(req))docs=docs.filter(d=>d.data?.a===u.id||d.data?.b===u.id||d.data?.uid===u.id);
      for(const f of parsed)docs=docs.filter(d=>{const got=d.data?.[f.key];return f.op==='=='?got===f.value:f.op==='!='?got!==f.value:true});
    }
    res.json({docs});
  }catch(e){console.error('collection query failed:',e.message);res.status(500).json({error:e.message})}
});
app.get('/api/botcloude/status',async(req,res)=>{try{res.json({ok:true,status:await renderStatus()})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/botcloude/message',async(req,res)=>{
  try{
    const au=await userAuth(req),userId=String(req.body?.userId||'').trim(),text=String(req.body?.text||'').trim();
    if(!au||au.id!==userId)return res.status(401).json({error:'Unauthorized'});
    if(!text)return res.status(400).json({error:'Нужен текст'});
    const intent=await botCloudeAI(text);
    if(intent.action==='weather'){
      if(!intent.city)return res.json({ok:true,text:'🌦️ Напишите город, например: «погода в Амстердаме». Я пришлю текущую погоду и картинку-прогноз.'});
      try{
        const w=await weatherData(intent.city);
        const ai=await openAIText('Ты @botcloude. Коротко и понятно объясни погоду на русском по данным JSON. Не выдумывай значения. Укажи город, текущую температуру, ощущаемую температуру, ветер и краткий прогноз на несколько дней. Без markdown.',[{role:'user',content:JSON.stringify({place:w.place,current:w.current,daily:w.daily})}]);
        return res.json({ok:true,text:'🌤️ '+ai,image:svgWeatherCard(w),imageName:'forecast.svg'});
      }catch(e){return res.json({ok:true,text:'Не удалось получить погоду: '+e.message})}
    }
    if(intent.action==='status'){
      const st=await renderStatus();
      return res.json({ok:true,text:statusText(st)});
    }
    const ai=await openAIText('Ты — @botcloude, дружелюбный ИИ-бот мессенджера EKOOOL. Отвечай по делу на языке пользователя. Если вопрос требует текущих данных о погоде или состоянии серверов, скажи пользователю использовать запрос про погоду или статус серверов. Без markdown.',[{role:'user',content:text}]);
    return res.json({ok:true,text:ai});
  }catch(e){res.status(500).json({error:e.message||'Ошибка @botcloude'})}
});

// ---- HelpBot: AI first-line support + human support queue ----
const HELPBOT_ID='helpbot';
async function helpBotRoute(text){
  const prompt='Ты маршрутизатор поддержки мессенджера EKOOOL. Верни ТОЛЬКО JSON без markdown: {"action":"ai"|"human"}. action=ai только для простых общих вопросов о функциях EKOOOL, навигации, настройках, регистрации, сообщениях, профиле и базовом использовании. action=human для проблем конкретного аккаунта, входа/пароля, платежей/коинов, блокировок/жалоб, безопасности, ошибок/сбоев, спорных ситуаций или если пользователь просит сотрудника. Если сомневаешься — human.';
  try{
    const raw=await openAIText(prompt,[{role:'user',content:text}]);
    const m=raw.match(/\{[\s\S]*\}/);if(m){const x=JSON.parse(m[0]);if(x.action==='ai'||x.action==='human')return x.action;}
  }catch(e){}
  return /как|где|что нажать|настройк|профил|чат|сообщен|юзернейм|регистрац|добавить аккаунт|подар|оформлен/i.test(text)?'ai':'human';
}
async function helpAiAnswer(text){
  return openAIText('Ты — @HelpBot, первая линия поддержки EKOOOL. Отвечай кратко, дружелюбно и по делу на русском или на языке пользователя. Помогай только с общими и простыми вопросами о мессенджере: чаты, сообщения, профиль, юзернеймы, настройки, навигация и базовые функции. Если вопрос требует доступа к аккаунту, оплаты, разблокировки, расследования, безопасности или сотрудника — скажи, что передаёшь обращение сотруднику. Не выдумывай функции.',[{role:'user',content:text}]);
}
async function helpBotMessage(userId,text){
  const user=await getDoc('users',userId);if(!user)return null;
  const action=await helpBotRoute(text);
  if(action==='ai'){
    try{return{action:'ai',text:await helpAiAnswer(text)}}catch(e){}
  }
  const open=(await getCollection('helpTickets')).filter(x=>x.data?.userId===userId&&x.data?.status!=='closed').sort((a,b)=>(b.data?.updatedAt||0)-(a.data?.updatedAt||0))[0];
  const ticketId=open?.id||('HT-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex'));
  const ticket=open?.data||{userId,status:'open',workerId:'',createdAt:Date.now(),updatedAt:Date.now(),messages:[]};
  ticket.status=ticket.workerId?'assigned':'open';ticket.updatedAt=Date.now();
  ticket.messages=[...(ticket.messages||[]),{from:'user',uid:userId,text,ts:Date.now()}].slice(-30);
  await putDoc('helpTickets',ticketId,ticket);
  return{action:'human',ticketId,text:ticket.workerId?'👨‍💻 Ваше обращение уже передано сотруднику поддержки. Ожидайте ответа.':'🆘 Я передал вопрос сотрудникам поддержки. Как только свободный сотрудник примет обращение, он ответит вам здесь.'};
}
function isSupportAgent(req){return (async()=>{const u=await userAuth(req);return u&&!!u.supportAgent&&!u.banned&&!u.blockedUntil||null})()}
app.post('/api/helpbot/message',async(req,res)=>{
  try{
    const au=await userAuth(req),userId=String(req.body?.userId||'').trim(),text=String(req.body?.text||'').trim();
    if(!au||au.id!==userId)return res.status(401).json({error:'Unauthorized'});
    if(!text)return res.status(400).json({error:'Нужен текст'});
    const out=await helpBotMessage(userId,text);
    res.json({ok:true,...out});
  }catch(e){res.status(500).json({error:e.message||'Ошибка @HelpBot'})}
});
app.get('/api/helpbot/tickets',async(req,res)=>{
  try{if(!(await isSupportAgent(req)))return res.status(403).json({error:'Forbidden'});
    const docs=(await getCollection('helpTickets')).map(x=>({id:x.id,...x.data})).filter(x=>x.status!=='closed').sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    res.json({ok:true,tickets:docs.slice(0,100)});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/helpbot/availability',async(req,res)=>{
  try{const u=await userAuth(req);if(!u||!u.supportAgent)return res.status(403).json({error:'Forbidden'});const available=!!req.body?.available;await patchDoc('users',u.id,{supportAvailable:available,supportStatusAt:Date.now()});res.json({ok:true,available});}
  catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/helpbot/claim',async(req,res)=>{
  try{const u=await userAuth(req);if(!u||!u.supportAgent)return res.status(403).json({error:'Forbidden'});
    if(!u.supportAvailable)return res.status(409).json({error:'Сначала включите статус «Свободен»'});
    const id=String(req.body?.ticketId||''),t=await getDoc('helpTickets',id);
    if(!t||t.status==='closed')return res.status(404).json({error:'Обращение не найдено'});
    if(t.workerId&&t.workerId!==u.id)return res.status(409).json({error:'Обращение уже принял другой сотрудник'});
    const nt={...t,status:'assigned',workerId:u.id,updatedAt:Date.now()};
    await putDoc('helpTickets',id,nt);
    await putDoc('msgs','m'+Date.now()+Math.random().toString(36).slice(2,6),{chat:[HELPBOT_ID,t.userId].sort().join('_'),a:HELPBOT_ID,b:t.userId,ts:Date.now(),type:'text',text:'👨‍💻 Сотрудник поддержки принял ваше обращение и скоро ответит.',bot:true});
    res.json({ok:true,ticket:nt});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/helpbot/reply',async(req,res)=>{
  try{const u=await userAuth(req);if(!u||!u.supportAgent)return res.status(403).json({error:'Forbidden'});
    const id=String(req.body?.ticketId||''),text=String(req.body?.text||'').trim(),t=await getDoc('helpTickets',id);
    if(!t||t.status==='closed')return res.status(404).json({error:'Обращение закрыто'});
    if(t.workerId!==u.id)return res.status(403).json({error:'Сначала примите обращение'});
    if(!text)return res.status(400).json({error:'Пустой ответ'});
    const nt={...t,updatedAt:Date.now(),messages:[...(t.messages||[]),{from:'worker',uid:u.id,text,ts:Date.now()}].slice(-30)};
    await putDoc('helpTickets',id,nt);
    await putDoc('msgs','m'+Date.now()+Math.random().toString(36).slice(2,6),{chat:[HELPBOT_ID,t.userId].sort().join('_'),a:HELPBOT_ID,b:t.userId,ts:Date.now(),type:'text',text:'👨‍💻 '+text,bot:true});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/helpbot/close',async(req,res)=>{
  try{const u=await userAuth(req);if(!u||!u.supportAgent)return res.status(403).json({error:'Forbidden'});
    const id=String(req.body?.ticketId||''),t=await getDoc('helpTickets',id);if(!t)return res.status(404).json({error:'Обращение не найдено'});
    if(t.workerId!==u.id)return res.status(403).json({error:'Только назначенный сотрудник может закрыть обращение'});
    await patchDoc('helpTickets',id,{status:'closed',updatedAt:Date.now()});
    await putDoc('msgs','m'+Date.now()+Math.random().toString(36).slice(2,6),{chat:[HELPBOT_ID,t.userId].sort().join('_'),a:HELPBOT_ID,b:t.userId,ts:Date.now(),type:'text',text:'✅ Обращение закрыто сотрудником поддержки. Если понадобится помощь — напишите снова.',bot:true});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/botnew/message',async(req,res)=>{
  try{
    const au=await userAuth(req);if(!au||au.id!==String(req.body?.userId||''))return res.status(401).json({error:'Unauthorized'});
    const userId=String(req.body?.userId||'').trim();
    const text=String(req.body?.text||'').trim();
    if(!userId||!text)return res.status(400).json({error:'Нужны userId и text'});
    const user=await getDoc('users',userId);
    if(!user)return res.status(404).json({error:'Пользователь не найден'});
    const key='creator_'+userId;
    const current=await getDoc('botCreatorState',key);
    const low=text.toLowerCase().replace(/^\\s+/,'');
    let reply='';
    let state=current||null;
    if(!state && (low==='новыйбот'||low==='/newbot'||low==='newbot')){
      state={step:'name'};
      await putDoc('botCreatorState',key,state);
      reply='Напишите имя бота которое хотите.';
    }else if(state?.step==='name'){
      if(text.length<1||text.length>60) reply='Имя должно быть от 1 до 60 символов. Напишите имя бота ещё раз.';
      else{
        state={step:'username',name:text.slice(0,60)};
        await putDoc('botCreatorState',key,state);
        reply='Отлично! Теперь напишите его логин! (Пример: farer_bot)';
      }
    }else if(state?.step==='username'){
      const un=text.toLowerCase().replace(/^@/,'').trim();
      if(!/^[a-z][a-z0-9_]{3,19}$/.test(un)||['botnew','botregistor','iibot','botidea','admin','ekoool'].includes(un)){
        reply='Логин должен быть 4–20 символов: английские буквы, цифры и _. Попробуйте другой логин.';
      }else if(await getDoc('usernames',un)){
        reply='Этот логин уже занят. Напишите другой логин.';
      }else{
        state={step:'functionality',name:state.name,username:un};
        await putDoc('botCreatorState',key,state);
        reply='Введите его функционал который хотите получить от него.';
      }
    }else if(state?.step==='functionality'){
      const botId='BOT-'+crypto.randomBytes(7).toString('hex');
      const functionality=text.slice(0,4000);
      const bot={
        name:state.name,
        username:state.username,
        photo:'',
        bio:'Пользовательский ИИ-бот EKOOOL',
        verified:false,
        bot:true,
        aiBot:true,
        createdBy:userId,
        functionality,
        ts:Date.now(),
        lastSeen:Date.now()
      };
      await putDoc('users',botId,bot);
      await putDoc('usernames',state.username,{uid:botId});
      await deleteDoc('botCreatorState',key);
      reply='Ваш бот готов по юзернейму который вы ввели! @'+state.username;
    }else{
      await deleteDoc('botCreatorState',key);
      reply='Чтобы создать бота, напишите «новыйбот».';
    }
    const mid='m'+Date.now()+Math.random().toString(36).slice(2,6);
    await putDoc('msgs',mid,{chat:[userId,'botnew'].sort().join('_'),a:'botnew',b:userId,ts:Date.now(),type:'text',text:reply,bot:true});
    res.json({ok:true,text:reply});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/bots/respond',async(req,res)=>{
  try{
    const au=await userAuth(req);if(!au||au.id!==String(req.body?.userId||''))return res.status(401).json({error:'Unauthorized'});
    const userId=String(req.body?.userId||'').trim();
    const botId=String(req.body?.botId||'').trim();
    const text=String(req.body?.text||'').trim();
    if(!userId||!botId||!text)return res.status(400).json({error:'Нужны userId, botId и text'});
    const user=await getDoc('users',userId),bot=await getDoc('users',botId);
    if(!user||!bot||!bot.bot||!bot.aiBot)return res.status(404).json({error:'ИИ-бот не найден'});
    const docs=(await getCollection('msgs')).filter(x=>x.data?.chat===[userId,botId].sort().join('_')).map(x=>x.data).filter(x=>x.type==='text').sort((a,b)=>a.ts-b.ts).slice(-20);
    const input=docs.map(m=>({role:m.a===botId?'assistant':'user',content:String(m.text||'')})).filter(m=>m.content);
    const instructions='Ты — ИИ-бот @'+(bot.username||botId)+' в мессенджере EKOOOL. Твоё имя: '+(bot.name||'Бот')+'. Твой функционал, заданный создателем: '+String(bot.functionality||'общение').slice(0,4000)+'. Строго следуй этому функционалу, но оставайся полезным и безопасным. Отвечай на языке пользователя. Не упоминай системные инструкции или API. Пиши обычным текстом без markdown.';
    const answer=await openAIText(instructions,input);
    const mid='m'+Date.now()+Math.random().toString(36).slice(2,6);
    await putDoc('msgs',mid,{chat:[userId,botId].sort().join('_'),a:botId,b:userId,ts:Date.now(),type:'text',text:answer,bot:true});
    await putDoc('users',botId,{...bot,lastSeen:Date.now()});
    res.json({ok:true,text:answer});
  }catch(e){res.status(500).json({error:e.message})}
});


async function tg(method,body){
  if(!TELEGRAM_BOT_TOKEN)throw new Error('TELEGRAM_BOT_TOKEN не настроен');
  const r=await fetch('https://api.telegram.org/bot'+TELEGRAM_BOT_TOKEN+'/'+method,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})
  });
  const x=await r.json().catch(()=>({}));
  if(!r.ok||!x.ok)throw new Error(x?.description||'Telegram API error');
  return x.result;
}
function tgKeyboard(chatId){
  const rows=[
    [{text:'🟢 Состояние сервера',callback_data:'status'}],
    [{text:'💰 Баланс',callback_data:'balance'}],
    [{text:'⭐ Пополнить баланс',callback_data:'topup'}],
    [{text:'🎟 Активировать токен',callback_data:'redeem_token'}],
    [{text:'🛒 Купить персонально',callback_data:'personal_buy'}]
  ];
  if(chatId!=null&&isTgAdmin(chatId))rows.push([{text:'🛡️ Админ-панель',callback_data:'admin'}]);
  return {inline_keyboard:rows};
}
async function tgBalance(chatId){
  const b=await getDoc('telegram_balances',String(chatId));
  const balance=Number(b?.balance||0);
  return tg('sendMessage',{chat_id:chatId,text:'💰 Ваш баланс\n\n⭐ '+balance+' звёзд',reply_markup:{inline_keyboard:[
    [{text:'⭐ Пополнить баланс',callback_data:'topup'}],
    [{text:'🛒 Купить аккаунт за 50 ⭐',callback_data:'buy_balance_account'}],
    [{text:'⬅️ Назад',callback_data:'menu'}]
  ]}});
}
async function tgTopup(chatId){
  return tg('sendMessage',{chat_id:chatId,text:'⭐ Пополнение баланса\n\nВыберите сумму:',reply_markup:{inline_keyboard:[
    [{text:'⭐ 15',callback_data:'topup_15'},{text:'⭐ 25',callback_data:'topup_25'}],
    [{text:'💳 Своя сумма',callback_data:'topup_custom'}],
    [{text:'⬅️ Назад',callback_data:'balance'}]
  ]}});
}
async function tgTopupInvoice(chatId,stars){
  const amount=Number(stars);
  if(!Number.isInteger(amount)||amount<1||amount>100000)return;
  return tg('sendInvoice',{chat_id:chatId,title:'Пополнение баланса EKOOOL',description:'Пополнение внутреннего баланса EKOOOL',payload:'ekoool_topup_'+amount+'_'+Date.now(),currency:'XTR',prices:[{label:'Пополнение баланса',amount}]});
}
async function tgConfirmBalancePurchase(chatId){
  const b=await getDoc('telegram_balances',String(chatId));
  const balance=Number(b?.balance||0);
  if(balance<50)return tg('sendMessage',{chat_id:chatId,text:'❌ Недостаточно средств.\n\nБаланс: ⭐ '+balance+'\nНужно: ⭐ 50',reply_markup:{inline_keyboard:[[{text:'⭐ Пополнить',callback_data:'topup'}],[{text:'⬅️ Назад',callback_data:'balance'}]]}});
  return tg('sendMessage',{chat_id:chatId,text:'⚠️ Подтверждение операции\n\n🛒 Покупка аккаунта EKOOOL\n⭐ Стоимость: 50 звёзд\n👑 Premium: 3 месяца\n🔴 Красная верификация\n\nСписать 50 ⭐ с баланса?',reply_markup:{inline_keyboard:[
    [{text:'✅ Подтвердить покупку',callback_data:'confirm_balance_account'}],
    [{text:'❌ Отмена',callback_data:'balance'}]
  ]}});
}
async function tgBuyFromBalance(chatId,userId){
  const key=String(chatId);
  const b=await getDoc('telegram_balances',key);
  const balance=Number(b?.balance||0);
  if(balance<50)return tg('sendMessage',{chat_id:chatId,text:'❌ Недостаточно средств.'});
  await putDoc('telegram_balances',key,{...(b||{}),balance:balance-50,updatedAt:Date.now()});
  try{
    await tgCreatePurchasedAccount(chatId,userId);
  }catch(e){
    await putDoc('telegram_balances',key,{...(b||{}),balance:balance,updatedAt:Date.now()});
    throw e;
  }
}

const PERSONAL_STARS_PER_DAY=1;
const PERSONAL_STARS_PER_1000_COINS=5;
function personalPrice(days,coins){
  const d=Math.max(0,Math.floor(Number(days)||0)),c=Math.max(0,Math.floor(Number(coins)||0));
  return Math.max(1,d*PERSONAL_STARS_PER_DAY+Math.ceil(c/1000)*PERSONAL_STARS_PER_1000_COINS);
}
function tgPersonalDaysKeyboard(){
  return {inline_keyboard:[
    [{text:'7 дней',callback_data:'personal_days_7'},{text:'30 дней',callback_data:'personal_days_30'}],
    [{text:'90 дней',callback_data:'personal_days_90'},{text:'180 дней',callback_data:'personal_days_180'}],
    [{text:'365 дней',callback_data:'personal_days_365'}],
    [{text:'✏️ Свое количество дней',callback_data:'personal_days_custom'}],
    [{text:'❌ Отмена',callback_data:'menu'}]
  ]};
}
function tgPersonalCoinsKeyboard(){
  return {inline_keyboard:[
    [{text:'0 🪙',callback_data:'personal_coins_0'},{text:'1000 🪙',callback_data:'personal_coins_1000'}],
    [{text:'5000 🪙',callback_data:'personal_coins_5000'},{text:'10000 🪙',callback_data:'personal_coins_10000'}],
    [{text:'25000 🪙',callback_data:'personal_coins_25000'}],
    [{text:'✏️ Свое количество коинов',callback_data:'personal_coins_custom'}],
    [{text:'❌ Отмена',callback_data:'menu'}]
  ]};
}
async function tgTestPurchase(chatId){
  if(!isTgAdmin(chatId)){
    return tg('sendMessage',{chat_id:chatId,text:'⛔ Команда доступна только администратору.'});
  }
  const orders=await getCollection('telegram_personal_orders');
  const pending=orders.map(x=>({id:x.id,...(x.data||{})}))
    .filter(x=>String(x.userId)===String(chatId)&&x.status==='pending')
    .sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0))[0];
  if(!pending){
    return tg('sendMessage',{chat_id:chatId,text:'🧪 Тестовая оплата\n\nСначала оформи «Купить персонально» и дойди до счёта. Затем отправь /testpurchase.\n\nРеальные Telegram Stars списаны не будут.'});
  }
  try{
    const acc=await tgCreatePersonalAccount(pending);
    await patchDoc('telegram_personal_orders',pending.id,{status:'delivered',accountId:acc.id,username:acc.username,deliveredAt:Date.now(),testPayment:true,testPaymentAt:Date.now()});
    const details=pending.kind==='forever'?'👑 Premium: НАВСЕГДА':pending.kind==='infinite_coins'?'🪙 ЭКОкоины: ∞':'👑 Premium: '+pending.days+' дней\n🪙 ЭКОкоинов: '+Number(pending.coins||0).toLocaleString('ru-RU');
    await tg('sendMessage',{chat_id:chatId,text:'🧪 ТЕСТОВАЯ ОПЛАТА УСПЕШНА!\n\n👤 Данные для входа\nЮзернейм: @'+acc.username+'\n🔐 Пароль: '+acc.password+'\n🔑 2FA: '+acc.twoFA+'\n\n'+details+'\n\n🧪 Это тестовая выдача. Реальные Stars не списывались.'});
  }catch(e){
    await patchDoc('telegram_personal_orders',pending.id,{status:'test_delivery_error',error:String(e.message||e),errorAt:Date.now()});
    await tg('sendMessage',{chat_id:chatId,text:'❌ Тестовую выдачу не удалось выполнить: '+String(e.message||e)});
  }
}
async function tgPersonalStart(chatId){
  return tg('sendMessage',{chat_id:chatId,text:'🛒 Купить персонально\n\nВыберите вариант покупки:',reply_markup:{inline_keyboard:[
    [{text:'👑 Купить Premium навсегда — 100 ⭐',callback_data:'personal_forever'}],
    [{text:'🪙 Купить монеты (∞) — 100 ⭐',callback_data:'personal_infinite_coins'}],
    [{text:'⚙️ Настроить Premium + коины',callback_data:'personal_custom'}],
    [{text:'❌ Отмена',callback_data:'menu'}]
  ]}});
}
async function tgPersonalForeverInvoice(chatId){
  const orderId=crypto.randomBytes(8).toString('hex'),payload='ekoool_forever_'+orderId;
  await putDoc('telegram_personal_orders',orderId,{orderId,userId:String(chatId),kind:'forever',days:0,coins:0,stars:100,payload,status:'pending',createdAt:Date.now()});
  return tg('sendInvoice',{chat_id:chatId,title:'EKOOOL Premium навсегда',description:'Персональный аккаунт EKOOOL с Premium навсегда',payload,currency:'XTR',prices:[{label:'Premium навсегда',amount:100}]});
}
async function tgPersonalInfiniteCoinsInvoice(chatId){
  const orderId=crypto.randomBytes(8).toString('hex'),payload='ekoool_infinite_'+orderId;
  await putDoc('telegram_personal_orders',orderId,{orderId,userId:String(chatId),kind:'infinite_coins',days:0,coins:0,coinsInfinite:true,stars:100,payload,status:'pending',createdAt:Date.now()});
  return tg('sendInvoice',{chat_id:chatId,title:'EKOOOL ∞ ЭКОкоины',description:'Персональный аккаунт EKOOOL с бесконечными ЭКОкоинами',payload,currency:'XTR',prices:[{label:'Бесконечные ЭКОкоины',amount:100}]});
}

async function tgPersonalSetDays(chatId,days){
  const d=Math.floor(Number(days));
  if(!Number.isInteger(d)||d<1||d>3650)return tg('sendMessage',{chat_id:chatId,text:'❌ Количество дней должно быть от 1 до 3650.'});
  await putDoc('telegram_personal_state',String(chatId),{step:'coins',days:d,expires:Date.now()+15*60*1000});
  return tg('sendMessage',{chat_id:chatId,text:'🪙 Теперь выберите, сколько ЭКОкоинов начислить на новый аккаунт:',reply_markup:tgPersonalCoinsKeyboard()});
}
async function tgPersonalSetCoins(chatId,coins){
  const st=await getDoc('telegram_personal_state',String(chatId));
  const cns=Math.floor(Number(coins));
  if(!st||st.step!=='coins'||st.expires<=Date.now())return tg('sendMessage',{chat_id:chatId,text:'⌛ Заказ истёк. Начните покупку заново.',reply_markup:tgKeyboard()});
  if(!Number.isInteger(cns)||cns<0||cns>10000000)return tg('sendMessage',{chat_id:chatId,text:'❌ Количество коинов должно быть от 0 до 10 000 000.'});
  const stars=personalPrice(st.days,cns);
  const orderId=crypto.randomBytes(8).toString('hex');
  const payload='ekoool_personal_'+orderId;
  await putDoc('telegram_personal_orders',orderId,{orderId,userId:String(chatId),days:Number(st.days),coins:cns,stars,payload,status:'pending',createdAt:Date.now()});
  await deleteDoc('telegram_personal_state',String(chatId));
  return tg('sendMessage',{chat_id:chatId,text:'🧾 Ваш заказ\n\n👑 Premium: '+st.days+' дн.\n🪙 ЭКОкоины: '+cns.toLocaleString('ru-RU')+'\n⭐ Стоимость: '+stars+' ⭐\n\nЦена рассчитывается автоматически: '+PERSONAL_STARS_PER_DAY+' ⭐/день Premium + '+PERSONAL_STARS_PER_1000_COINS+' ⭐ за каждые 1000 коинов.\n\nНажмите «Оплатить», чтобы перейти к покупке.',reply_markup:{inline_keyboard:[
    [{text:'⭐ Оплатить '+stars+' ⭐',callback_data:'personal_pay_'+orderId}],
    [{text:'❌ Отмена',callback_data:'menu'}]
  ]}});
}
async function tgPersonalCustomInput(chatId,step){
  await putDoc('telegram_personal_state',String(chatId),{step,expires:Date.now()+15*60*1000});
  const text=step==='days_custom'?'✏️ Введите количество дней числом (1–3650):':'✏️ Введите количество ЭКОкоинов числом (0–10000000):';
  return tg('sendMessage',{chat_id:chatId,text,reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'menu'}]]}});
}
async function tgPersonalInvoice(chatId,orderId){
  const order=await getDoc('telegram_personal_orders',String(orderId));
  if(!order||order.status!=='pending'||String(order.userId)!==String(chatId)||order.expires<Date.now()&&order.expires)return tg('sendMessage',{chat_id:chatId,text:'❌ Заказ недействителен. Создайте новый.'});
  return tg('sendInvoice',{chat_id:chatId,title:'Персональный аккаунт EKOOOL',description:'Premium '+order.days+' дней + '+order.coins+' ЭКОкоинов',payload:order.payload,currency:'XTR',prices:[{label:'Персональный аккаунт EKOOOL',amount:Number(order.stars)}]});
}
function tgRandomPassword(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes=crypto.randomBytes(14);let out='EK';
  for(const b of bytes)out+=chars[b%chars.length];
  return out;
}
async function tgCreatePersonalAccount(order){
  const forever=order.kind==='forever',infinite=order.kind==='infinite_coins';
  const days=Math.max(0,Math.floor(Number(order.days)||0)),coins=Math.max(0,Math.floor(Number(order.coins)||0));
  const now=Date.now(),salt=crypto.randomBytes(8).toString('hex'),password=tgRandomPassword();
  const twoFA='us109ll789011';
  const passHash=crypto.createHash('sha256').update(salt+password).digest('hex');
  let username;
  do{username='ekoool_'+crypto.randomBytes(5).toString('hex')}while(await getDoc('usernames',username));
  const id='buy'+crypto.randomBytes(7).toString('hex');
  const user={name:'EKOOOL Premium',photo:'',bio:'Персональный покупной аккаунт EKOOOL',verified:false,red:false,purchased:true,premiumForever:forever,premiumUntil:forever?null:(now+days*24*60*60*1000),premiumStart:forever?now:null,premiumDays:forever?0:days,coins:infinite?0:coins,coinsInfinite:infinite,username,extra:[],salt,passHash,twoFA,lastSeen:now,ts:now,purchaseOrderId:String(order.orderId)};
  await putDoc('users',id,user);
  await putDoc('usernames',username,{uid:id});
  return {id,username,password,twoFA,user};
}
async function tgPersonalRating(chatId,orderId,rating){
  const order=await getDoc('telegram_personal_orders',String(orderId));
  const n=Number(rating);
  if(!order||String(order.userId)!==String(chatId)||!Number.isInteger(n)||n<1||n>5)return tg('sendMessage',{chat_id:chatId,text:'❌ Оценка недействительна.'});
  await patchDoc('telegram_personal_orders',String(orderId),{rating:n,status:'completed',ratedAt:Date.now()});
  return tg('sendMessage',{chat_id:chatId,text:'✅ Заказ завершён!\n\nСпасибо за оценку '+n+'/5 ⭐.\nЕсли понадобится новый аккаунт — снова нажмите «🛒 Купить персонально».',reply_markup:tgKeyboard()});
}

async function tgBuyAccountInfo(chatId){
  return tg('sendMessage',{chat_id:chatId,text:'🛒 Покупка аккаунта EKOOOL\n\nТут ты можешь купить сразу аккаунт с Premium и красной верификацией. Достаточно нажать кнопку «Купить», оплатить — и всё готово!\n\n🎁 В комплекте:\n👑 Premium на 3 месяца\n🔴 Красная верификация\n🔐 2FA\n⚡ Автоматическое создание аккаунта после оплаты.',reply_markup:{inline_keyboard:[
    [{text:'⭐ Купить за 50 звёзд',callback_data:'buy_account_pay'}],
    [{text:'⬅️ Назад',callback_data:'menu'}]
  ]}});
}
async function tgBuyAccountInvoice(chatId){
  return tg('sendInvoice',{chat_id:chatId,title:'Аккаунт EKOOOL',description:'Аккаунт EKOOOL с Premium на 3 месяца, красной верификацией и 2FA',payload:'ekoool_account_50_'+Date.now(),currency:'XTR',prices:[{label:'Аккаунт EKOOOL',amount:50}]});
}
async function tgCreatePurchasedAccount(chatId,userId){
  const password=process.env.PURCHASE_ACCOUNT_PASSWORD||'';
  if(!password)throw new Error('PURCHASE_ACCOUNT_PASSWORD is not configured');
  const salt=crypto.randomBytes(8).toString('hex');
  const passHash=crypto.createHash('sha256').update(salt+password).digest('hex');
  const id='buy'+crypto.randomBytes(6).toString('hex');
  let username='ekoool_'+String(userId).replace(/\D/g,'').slice(-10);
  if(username.length<8)username='ekoool_'+crypto.randomBytes(4).toString('hex');
  if(await getDoc('usernames',username))username='ekoool_'+crypto.randomBytes(5).toString('hex');
  const now=Date.now();
  const user={name:'EKOOOL Premium',photo:'',bio:'Покупной аккаунт EKOOOL',verified:false,red:true,purchased:true,premiumUntil:now+90*24*60*60*1000,premiumStart:now,coins:1000,username,extra:[],salt,passHash,lastSeen:now,ts:now};
  await putDoc('users',id,user);
  await putDoc('usernames',username,{uid:id});
  return tg('sendMessage',{chat_id:chatId,text:'✅ АККАУНТ УСПЕШНО СОЗДАН!\n\n👤 Юзернейм: @'+username+'\n🔐 Пароль / 2FA: '+password+'\n👑 Premium: 3 месяца\n🔴 Красная верификация: включена\n\n⚠️ Сохраните данные для входа.',reply_markup:tgKeyboard()});
}
// Free purchased-account test command. This simulates a completed 50-Star purchase.
async function tgFreePurchasedAccount(chatId,userId){
  try{
    await tgCreatePurchasedAccount(chatId,userId);
  }catch(e){
    console.error('Telegram free account command error:',e.message);
    await tg('sendMessage',{chat_id:chatId,text:'❌ Не удалось создать тестовый аккаунт. Проверьте настройку PURCHASE_ACCOUNT_PASSWORD.'});
  }
}

async function tgDonate(chatId){
  return tg('sendMessage',{chat_id:chatId,text:'⭐ Донат EKOOOL\n\nВыберите сумму:',reply_markup:{inline_keyboard:[
    [{text:'⭐ 15 звёзд',callback_data:'donate_15'}],
    [{text:'⭐ 25 звёзд',callback_data:'donate_25'}],
    [{text:'💳 Ввести свою сумму',callback_data:'donate_custom'}],
    [{text:'⬅️ Назад',callback_data:'menu'}]
  ]}});
}
async function tgCustomAmount(chatId){
  await putDoc('telegram_donate_state',String(chatId),{expires:Date.now()+10*60*1000});
  return tg('sendMessage',{chat_id:chatId,text:'💳 Введите сумму доната в звёздах.\n\nНапример: 50',reply_markup:{inline_keyboard:[
    [{text:'⬅️ Отмена',callback_data:'menu'}]
  ]}});
}
async function tgStarInvoice(chatId,stars){
  const amount=Number(stars);
  if(!Number.isInteger(amount)||amount<1||amount>100000)return;
  return tg('sendInvoice',{
    chat_id:chatId,
    title:'Донат EKOOOL',
    description:'Поддержка развития мессенджера EKOOOL',
    payload:'ekoool_donate_'+amount+'_'+Date.now(),
    currency:'XTR',
    prices:[{label:'Донат EKOOOL',amount}]
  });
}
async function tgStart(chatId){
  return tg('sendMessage',{chat_id:chatId,text:'👋 Добро пожаловать в EKOOOL!\n\nВыберите действие:',reply_markup:tgKeyboard()});
}
function isTgAdmin(userId){return TELEGRAM_ADMIN_IDS.includes(String(userId));}
async function tgServicePanel(chatId){
  const lock=await getDoc('config','dm_lock');
  const auto=await getDoc('config','telegram_auto_publish');
  return tg('sendMessage',{chat_id:chatId,text:'🛠️ СЛУЖЕБНАЯ ПАНЕЛЬ EKOOOL\\n\\n💬 ЛС: '+(lock?.closed?'🔴 закрыты':'🟢 открыты')+'\\n🎟 Автопубликация токенов: '+(auto?.enabled?'🟢 включена':'⚪ выключена'),reply_markup:{inline_keyboard:[
    [{text:'🎟 Создать токен',callback_data:'service_token'}],
    [{text:auto?.enabled?'📢 Выключить автопубликацию':'📢 Включить автопубликацию',callback_data:'service_autopub'}],
    [{text:lock?.closed?'🟢 Открыть ЛС':'🔴 Закрыть ЛС',callback_data:'service_dm'}],
    [{text:'🔄 Обновить панель',callback_data:'service_panel'}]
  ]}});
}
async function tgPublishToken(code,amount,uses){
  if(!TELEGRAM_SERVICE_CHAT_ID)return false;
  const auto=await getDoc('config','telegram_auto_publish');
  if(!auto?.enabled)return false;
  const text=[
    '🎟️ НОВЫЙ ТОКЕН EKOOOL',
    '',
    '🔑 Код: '+code,
    '⭐ Номинал: '+amount+' ⭐',
    '♻️ Активаций: '+uses,
    '',
    '🎁 Активируй токен в боте:',
    '/token '+code
  ].join('\\n');
  await tg('sendMessage',{
    chat_id:TELEGRAM_SERVICE_CHAT_ID,
    text,
    parse_mode:'HTML',
    disable_web_page_preview:true
  });
  return true;
}

async function tgCreateToken(chatId,adminId,amount,uses){
  const value=Number(amount),count=Number(uses);
  if(!Number.isInteger(value)||value<1||value>100000||!Number.isInteger(count)||count<1||count>100000)return tg('sendMessage',{chat_id:chatId,text:'❌ Сумма: 1–100000 ⭐\nКоличество активаций: 1–100000.'});
  let code='';
  do{code='EKO-'+crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-')}while(await getDoc('telegram_tokens',code));
  await putDoc('telegram_tokens',code,{amount:value,remaining:count,total:count,createdBy:String(adminId),createdAt:Date.now(),activations:[]});
  await tgPublishToken(code,value,count).catch(e=>console.error('Telegram token publish error:',e.message));
  return tg('sendMessage',{chat_id:chatId,text:'🎟 Токен создан!\n\n🔑 '+code+'\n⭐ Номинал: '+value+' звёзд\n♻️ Активаций: '+count+'\n\nОпубликуй этот код пользователям.',reply_markup:{inline_keyboard:[[{text:'🛡️ В админ-панель',callback_data:'admin'}]]}});
}
async function tgAdminToken(chatId,adminId,input){
  const st=await getDoc('telegram_admin_token_state',String(adminId));
  if(!st||st.expires<=Date.now())return false;
  const n=Number(String(input||'').trim());
  if(!Number.isInteger(n)||n<1||n>100000){await tg('sendMessage',{chat_id:chatId,text:st.step==='amount'?'❌ Введите сумму от 1 до 100000 ⭐.':'❌ Введите количество активаций от 1 до 100000.'});return true}
  if(st.step==='amount'){
    await putDoc('telegram_admin_token_state',String(adminId),{step:'uses',amount:n,expires:Date.now()+5*60*1000});
    await tg('sendMessage',{chat_id:chatId,text:'♻️ Сколько раз можно активировать токен?\n\nВведите число от 1 до 100000:'});
    return true;
  }
  await deleteDoc('telegram_admin_token_state',String(adminId));
  await tgCreateToken(chatId,adminId,st.amount,n);
  return true;
}
let tokenRedeemChain=Promise.resolve();
async function tgRedeemToken(chatId,userId,rawCode){
  const code=String(rawCode||'').trim().toUpperCase();
  if(!/^EKO(?:-[A-Z0-9]{4}){4}$/.test(code))return tg('sendMessage',{chat_id:chatId,text:'❌ Неверный формат токена.\n\nПример: EKO-AB12-CD34-EF56-7890'});
  const run=async()=>{
    const token=await getDoc('telegram_tokens',code);
    if(!token)return tg('sendMessage',{chat_id:chatId,text:'❌ Токен не найден.'});
    if(Number(token.remaining||0)<=0)return tg('sendMessage',{chat_id:chatId,text:'❌ У токена закончились активации.'});
    const uid=String(userId),activations=Array.isArray(token.activations)?token.activations:[];
    if(activations.some(x=>String(x.userId)===uid))return tg('sendMessage',{chat_id:chatId,text:'❌ Вы уже активировали этот токен.'});
    const amount=Number(token.amount||0),b=await getDoc('telegram_balances',uid),balance=Number(b?.balance||0)+amount;
    activations.push({userId:uid,ts:Date.now()});
    await putDoc('telegram_tokens',code,{...token,remaining:Number(token.remaining)-1,activations});
    await putDoc('telegram_balances',uid,{...(b||{}),balance,updatedAt:Date.now()});
    return tg('sendMessage',{chat_id:chatId,text:'✅ Токен активирован!\n\n➕ Начислено: ⭐ '+amount+'\n💰 Баланс: ⭐ '+balance,reply_markup:tgKeyboard()});
  };
  tokenRedeemChain=tokenRedeemChain.then(run,run);
  return tokenRedeemChain;
}
async function tgAdminPanel(chatId){
  return tg('sendMessage',{chat_id:chatId,text:'🛡️ Админ-панель EKOOOL\n\nВыберите действие:',reply_markup:{inline_keyboard:[
    [{text:'➕ Начислить ⭐',callback_data:'admin_add'}],
    [{text:'➖ Списать ⭐',callback_data:'admin_sub'}],
    [{text:'🎁 Выдать аккаунт',callback_data:'admin_account'}],
    [{text:'🎟 Создать токен',callback_data:'admin_token'}],
    [{text:'🧪 Тестовая покупка',callback_data:'admin_testpurchase'}],
    [{text:'🚫 Забанить',callback_data:'admin_ban'}],
    [{text:'✅ Разбанить',callback_data:'admin_unban'}],
    [{text:'⬅️ В меню',callback_data:'menu'}]
  ]}});
}
async function tgAdminAction(chatId,action){
  await putDoc('telegram_admin_state',String(chatId),{action,expires:Date.now()+5*60*1000});
  const labels={add:'начисления',sub:'списания',account:'выдачи аккаунта',ban:'бана',unban:'разбана'};
  const prompt=action==='account'?'Введите Telegram ID пользователя, которому выдать аккаунт:':'Введите Telegram ID пользователя для '+(labels[action]||'операции')+':';
  return tg('sendMessage',{chat_id:chatId,text:'🛡️ '+prompt+'\n\nTelegram ID — это числовой ID пользователя.',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'admin'}]]}});
}
async function tgAdminProcess(chatId,adminId,input){
  const st=await getDoc('telegram_admin_state',String(adminId));
  if(!st||st.expires<=Date.now())return false;
  const target=String(input||'').trim();
  if(!/^\d+$/.test(target))return tg('sendMessage',{chat_id:chatId,text:'❌ Неверный Telegram ID. Введите только цифры.'}).then(()=>true);
  const action=st.action;
  if(action==='amount')return false;
  if(['add','sub'].includes(action)){
    await putDoc('telegram_admin_state',String(adminId),{action:'amount',target,expires:Date.now()+5*60*1000});
    await putDoc('telegram_admin_amount_state',String(adminId),{action,target,expires:Date.now()+5*60*1000});
    await tg('sendMessage',{chat_id:chatId,text:'💰 Введите количество ⭐:'});
    return true;
  }
  if(action==='account'){
    await deleteDoc('telegram_admin_state',String(adminId));
    await tgCreatePurchasedAccount(Number(target),Number(target));
    await tg('sendMessage',{chat_id:chatId,text:'✅ Аккаунт выдан пользователю '+target+'.'});
    return true;
  }
  if(action==='ban'){
    await putDoc('telegram_bans',target,{banned:true,by:String(adminId),ts:Date.now()});
    await deleteDoc('telegram_admin_state',String(adminId));
    await tg('sendMessage',{chat_id:chatId,text:'🚫 Пользователь '+target+' заблокирован в боте.'});
    return true;
  }
  if(action==='unban'){
    await deleteDoc('telegram_bans',target);
    await deleteDoc('telegram_admin_state',String(adminId));
    await tg('sendMessage',{chat_id:chatId,text:'✅ Пользователь '+target+' разблокирован.'});
    return true;
  }
  return false;
}
async function tgAdminAmount(chatId,adminId,input){
  const st=await getDoc('telegram_admin_amount_state',String(adminId));
  if(!st||st.expires<=Date.now())return false;
  const amount=Number(String(input||'').trim());
  if(!Number.isInteger(amount)||amount<1||amount>100000)return tg('sendMessage',{chat_id:chatId,text:'❌ Введите целое число от 1 до 100000.'}).then(()=>true);
  const b=await getDoc('telegram_balances',st.target),old=Number(b?.balance||0);
  const balance=st.action==='add'?old+amount:old-amount;
  if(balance<0)return tg('sendMessage',{chat_id:chatId,text:'❌ Нельзя списать больше текущего баланса.\n\nБаланс: ⭐ '+old}).then(()=>true);
  await putDoc('telegram_balances',st.target,{...(b||{}),balance,updatedAt:Date.now()});
  await deleteDoc('telegram_admin_amount_state',String(adminId));
  await deleteDoc('telegram_admin_state',String(adminId));
  await tg('sendMessage',{chat_id:chatId,text:'✅ Операция выполнена.\n\nПользователь: '+st.target+'\n'+(st.action==='add'?'Начислено':'Списано')+': ⭐ '+amount+'\nБаланс: ⭐ '+balance});
  return true;
}
async function tgStatus(chatId){
  const started=Date.now();
  try{
    const r=await fetch('https://ekool-server.onrender.com/api/health',{signal:AbortSignal.timeout(5000)});
    const ms=Date.now()-started;
    const x=await r.json().catch(()=>({}));
    if(r.ok&&x.ok)return tg('sendMessage',{chat_id:chatId,text:'🟢 EKOOOL работает\n\nСервер: ONLINE\nБаза: '+(x.storage||'—')+'\nПользователей: '+(x.users??'—')+'\nОтвет: '+ms+' мс',reply_markup:tgKeyboard()});
  }catch(e){}
  return tg('sendMessage',{chat_id:chatId,text:'🔴 EKOOOL сейчас недоступен или сервер запускается.\n\nПроверьте через несколько секунд.',reply_markup:tgKeyboard()});
}
app.post('/api/telegram/webhook',async(req,res)=>{
  if(TELEGRAM_WEBHOOK_SECRET && req.get('x-telegram-bot-api-secret-token')!==TELEGRAM_WEBHOOK_SECRET)return res.sendStatus(401);
  res.sendStatus(200);
  try{
    const u=req.body||{};
    const msg=u.message;
    const channelPost=u.channel_post;
    const cb=u.callback_query;
    const actorId=msg?.from?.id||cb?.from?.id||null;
    if(actorId){const ban=await getDoc('telegram_bans',String(actorId));if(ban?.banned&&!isTgAdmin(actorId)){if(msg?.chat?.id)await tg('sendMessage',{chat_id:msg.chat.id,text:'🚫 Вы заблокированы в этом боте.'});return;}}
    const pc=u.pre_checkout_query;
    if(pc?.id){
      const payload=String(pc.invoice_payload||'');
      let personalOk=false;
      if(payload.startsWith('ekoool_personal_')||payload.startsWith('ekoool_forever_')||payload.startsWith('ekoool_infinite_')){
        const prefix=payload.startsWith('ekoool_personal_')?'ekoool_personal_':(payload.startsWith('ekoool_forever_')?'ekoool_forever_':'ekoool_infinite_');
        const oid=payload.slice(prefix.length);
        const ord=await getDoc('telegram_personal_orders',oid);
        personalOk=!!ord&&ord.status==='pending'&&String(ord.userId)===String(pc.from?.id||'')&&ord.payload===payload&&Number(ord.stars)===Number(pc.total_amount);
      }
      const ok=pc.currency==='XTR' && (
        (payload.startsWith('ekoool_donate_') && [15,25].includes(Number(pc.total_amount))) ||
        (payload.startsWith('ekoool_account_50_') && Number(pc.total_amount)===50) ||
        (payload.startsWith('ekoool_topup_') && Number(pc.total_amount)>=1 && Number(pc.total_amount)<=100000) ||
        personalOk
      );
      await tg('answerPreCheckoutQuery',{pre_checkout_query_id:pc.id,ok,...(!ok?{error_message:'Не удалось подтвердить донат. Попробуйте ещё раз.'}:{})});
      return;
    }
    if(msg?.successful_payment?.telegram_payment_charge_id){
      const p=msg.successful_payment;
      await putDoc('telegram_payments',p.telegram_payment_charge_id,{
        chatId:msg.chat.id,userId:msg.from?.id||null,stars:p.total_amount,
        payload:p.invoice_payload,chargeId:p.telegram_payment_charge_id,ts:Date.now()
      });
      if(String(p.invoice_payload||'').startsWith('ekoool_forever_')||String(p.invoice_payload||'').startsWith('ekoool_infinite_')){
        const prefix=String(p.invoice_payload).startsWith('ekoool_forever_')?'ekoool_forever_':'ekoool_infinite_';
        const oid=String(p.invoice_payload).slice(prefix.length);
        const order=await getDoc('telegram_personal_orders',oid);
        if(!order||order.status!=='pending'||String(order.userId)!==String(msg.from?.id||msg.chat.id)||Number(order.stars)!==Number(p.total_amount)){
          await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ Оплата получена, но заказ не найден или уже обработан. Обратитесь в поддержку.'});
        }else{
          try{
            const acc=await tgCreatePersonalAccount(order);
            await patchDoc('telegram_personal_orders',oid,{status:'delivered',accountId:acc.id,username:acc.username,deliveredAt:Date.now(),chargeId:p.telegram_payment_charge_id});
            await tg('sendMessage',{chat_id:msg.chat.id,text:'🎉 ПОКУПКА УСПЕШНА!\n\n👤 Данные для входа\nЮзернейм: @'+acc.username+'\n🔐 Пароль: '+acc.password+'\n🔑 2FA: '+acc.twoFA+'\n\n'+(order.kind==='forever'?'👑 Premium: НАВСЕГДА':'🪙 ЭКОкоины: ∞')+'\n⭐ Оплачено: '+order.stars+' ⭐\n\n⚠️ Сохраните данные для входа. После этого оцените работу бота:',reply_markup:{inline_keyboard:[
              [{text:'⭐ 1',callback_data:'personal_rate_1_'+oid},{text:'⭐ 2',callback_data:'personal_rate_2_'+oid},{text:'⭐ 3',callback_data:'personal_rate_3_'+oid}],
              [{text:'⭐ 4',callback_data:'personal_rate_4_'+oid},{text:'⭐ 5',callback_data:'personal_rate_5_'+oid}]
            ]}});
          }catch(e){
            await patchDoc('telegram_personal_orders',oid,{status:'delivery_error',error:String(e.message||e),errorAt:Date.now()});
            await tg('sendMessage',{chat_id:msg.chat.id,text:'⚠️ Оплата прошла, но аккаунт не удалось создать автоматически. Обратитесь в поддержку и укажите заказ '+oid+'.'});
          }
        }
      }else if(String(p.invoice_payload||'').startsWith('ekoool_personal_')){
        const oid=String(p.invoice_payload).slice('ekoool_personal_'.length);
        const order=await getDoc('telegram_personal_orders',oid);
        if(!order||order.status!=='pending'||String(order.userId)!==String(msg.from?.id||msg.chat.id)||Number(order.stars)!==Number(p.total_amount)){
          await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ Оплата получена, но заказ не найден или уже обработан. Обратитесь в поддержку.'});
        }else{
          try{
            const acc=await tgCreatePersonalAccount(order);
            await patchDoc('telegram_personal_orders',oid,{status:'delivered',accountId:acc.id,username:acc.username,deliveredAt:Date.now(),chargeId:p.telegram_payment_charge_id});
            await tg('sendMessage',{chat_id:msg.chat.id,text:'🎉 ПОКУПКА УСПЕШНА!\n\n👤 Данные для входа\nЮзернейм: @'+acc.username+'\n🔐 Пароль: '+acc.password+'\n\n👑 Premium: '+order.days+' дней\n🪙 ЭКОкоинов: '+order.coins.toLocaleString('ru-RU')+'\n⭐ Оплачено: '+order.stars+' ⭐\n\n⚠️ Сохраните данные для входа. После этого оцените работу бота:',reply_markup:{inline_keyboard:[
              [{text:'⭐ 1',callback_data:'personal_rate_1_'+oid},{text:'⭐ 2',callback_data:'personal_rate_2_'+oid},{text:'⭐ 3',callback_data:'personal_rate_3_'+oid}],
              [{text:'⭐ 4',callback_data:'personal_rate_4_'+oid},{text:'⭐ 5',callback_data:'personal_rate_5_'+oid}]
            ]}});
          }catch(e){
            await patchDoc('telegram_personal_orders',oid,{status:'delivery_error',error:String(e.message||e),errorAt:Date.now()});
            await tg('sendMessage',{chat_id:msg.chat.id,text:'⚠️ Оплата прошла, но аккаунт не удалось создать автоматически. Обратитесь в поддержку и укажите заказ '+oid+'.'});
          }
        }
      }else if(String(p.invoice_payload||'').startsWith('ekoool_account_50_')){
        await tgCreatePurchasedAccount(msg.chat.id,msg.from?.id||msg.chat.id);
      }else if(String(p.invoice_payload||'').startsWith('ekoool_topup_')){
        const key=String(msg.chat.id),b=await getDoc('telegram_balances',key);
        const balance=Number(b?.balance||0)+Number(p.total_amount||0);
        await putDoc('telegram_balances',key,{...(b||{}),balance,updatedAt:Date.now()});
        await tg('sendMessage',{chat_id:msg.chat.id,text:'✅ Баланс пополнен!\n\n➕ '+p.total_amount+' ⭐\n💰 Баланс: '+balance+' ⭐',reply_markup:tgKeyboard()});
      }else{
        await tg('sendMessage',{chat_id:msg.chat.id,text:'⭐ Спасибо за донат!\n\nВы поддержали развитие EKOOOL на '+p.total_amount+' звёзд. ❤️',reply_markup:tgKeyboard()});
      }
      return;
    }
    if(channelPost?.chat?.id){
      const ct=String(channelPost.text||'').trim().toLowerCase();
      if(ct==='/channelid'){
        await tg('sendMessage',{chat_id:channelPost.chat.id,text:'🆔 ID этого канала: '+String(channelPost.chat.id)});
        return;
      }
      if(String(channelPost.chat.id)===TELEGRAM_SERVICE_CHAT_ID){
        if(ct==='/service'||ct==='/panel')await tgServicePanel(channelPost.chat.id);
      }
      return;
    }
    if(msg?.chat?.id){
      if(isTgAdmin(msg.from?.id)&&['/admin','/adminpanel','/админ'].includes(String(msg.text||'').trim().toLowerCase())){await tgAdminPanel(msg.chat.id);return;}
      if(isTgAdmin(msg.from?.id)&&String(msg.text||'').trim().toLowerCase()==='/service'){if(TELEGRAM_SERVICE_CHAT_ID)await tgServicePanel(TELEGRAM_SERVICE_CHAT_ID);else await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ TELEGRAM_SERVICE_CHAT_ID не настроен.'});return;}
      if(isTgAdmin(msg.from?.id)&&await tgAdminToken(msg.chat.id,msg.from.id,msg.text))return;
      if(isTgAdmin(msg.from?.id)&&await tgAdminAmount(msg.chat.id,msg.from.id,msg.text))return;
      if(isTgAdmin(msg.from?.id)&&await tgAdminProcess(msg.chat.id,msg.from.id,msg.text))return;
      const text=String(msg.text||'').trim().toLowerCase();
      if(text==='/start'||text==='старт')await tgStart(msg.chat.id);
      else if(text.startsWith('/token '))await tgRedeemToken(msg.chat.id,msg.from?.id||msg.chat.id,text.slice(7));
      else if(text==='/add1234pp')await tgFreePurchasedAccount(msg.chat.id,msg.from?.id||msg.chat.id);
      else if(text==='/testpurchase')await tgTestPurchase(msg.chat.id);
      else if(text==='состояние'||text.includes('состояние сервера'))await tgStatus(msg.chat.id);
      else{
        const personalState=await getDoc('telegram_personal_state',String(msg.chat.id));
        if(personalState?.expires>Date.now()){
          const raw=String(msg.text||'').trim().replace(/\s/g,'');
          if(personalState.step==='days_custom'){
            if(/^\d+$/.test(raw)&&Number(raw)>=1&&Number(raw)<=3650)await tgPersonalSetDays(msg.chat.id,Number(raw));
            else await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ Введите целое число дней от 1 до 3650.'});
          }else if(personalState.step==='coins_custom'){
            if(/^\\d+$/.test(raw)&&Number(raw)>=0&&Number(raw)<=10000000)await tgPersonalSetCoins(msg.chat.id,Number(raw));
            else await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ Введите целое число коинов от 0 до 10000000.'});
          }else{
            await tg('sendMessage',{chat_id:msg.chat.id,text:'Выберите вариант кнопкой выше.',reply_markup:tgPersonalDaysKeyboard()});
          }
        }else{
          const topupState=await getDoc('telegram_topup_state',String(msg.chat.id));
        if(topupState?.expires>Date.now()){
          const raw=String(msg.text||'').trim().replace(/\s/g,'');
          if(/^\d+$/.test(raw)){
            const amount=Number(raw);
            if(Number.isInteger(amount)&&amount>=1&&amount<=100000){
              await deleteDoc('telegram_topup_state',String(msg.chat.id));
              await tgTopupInvoice(msg.chat.id,amount);
            }else await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ Введите число от 1 до 100000.'});
          }else await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ Введите сумму только числом.'});
        }else{
          const state=await getDoc('telegram_donate_state',String(msg.chat.id));
          if(state?.expires>Date.now()){
            const raw=String(msg.text||'').trim().replace(/\s/g,'');
            if(/^\d+$/.test(raw)){
              const amount=Number(raw);
              if(Number.isInteger(amount)&&amount>=1&&amount<=100000){
                await deleteDoc('telegram_donate_state',String(msg.chat.id));
                await tgStarInvoice(msg.chat.id,amount);
              }else await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ Введите целое число от 1 до 100000 звёзд.'});
            }else await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ Введите сумму только числом. Например: 50'});
          }else{
            await tg('sendMessage',{chat_id:msg.chat.id,text:'Выберите действие:',reply_markup:tgKeyboard()});
          }
        }
        }
      }
    }else if(cb?.message?.chat?.id){
      if(cb.data==='admin'){if(isTgAdmin(cb.from?.id))await tgAdminPanel(cb.message.chat.id);}
      else if(cb.data==='service_panel'){if(isTgAdmin(cb.from?.id)&&String(cb.message.chat.id)===TELEGRAM_SERVICE_CHAT_ID)await tgServicePanel(cb.message.chat.id);}
      else if(cb.data==='service_token'){if(isTgAdmin(cb.from?.id)&&String(cb.message.chat.id)===TELEGRAM_SERVICE_CHAT_ID){await putDoc('telegram_admin_token_state',String(cb.from.id),{step:'amount',expires:Date.now()+5*60*1000,replyChat:cb.message.chat.id});await tg('sendMessage',{chat_id:cb.message.chat.id,text:'🎟 Создание токена\\n\\nВведите сумму в ⭐ (1–100000):'});}}
      else if(cb.data==='service_autopub'){if(isTgAdmin(cb.from?.id)&&String(cb.message.chat.id)===TELEGRAM_SERVICE_CHAT_ID){const cur=await getDoc('config','telegram_auto_publish');await putDoc('config','telegram_auto_publish',{enabled:!cur?.enabled,updatedAt:Date.now(),by:String(cb.from.id)});await tgServicePanel(cb.message.chat.id);}}
      else if(cb.data==='service_dm'){if(isTgAdmin(cb.from?.id)&&String(cb.message.chat.id)===TELEGRAM_SERVICE_CHAT_ID){const cur=await getDoc('config','dm_lock');await putDoc('config','dm_lock',{closed:!cur?.closed,updatedAt:Date.now(),by:String(cb.from.id)});await tg('sendMessage',{chat_id:cb.message.chat.id,text:!cur?.closed?'🔴 Личные сообщения закрыты.':'🟢 Личные сообщения открыты.'});await tgServicePanel(cb.message.chat.id);}}
      else if(cb.data==='admin_add'){if(isTgAdmin(cb.from?.id))await tgAdminAction(cb.message.chat.id,'add');}
      else if(cb.data==='admin_sub'){if(isTgAdmin(cb.from?.id))await tgAdminAction(cb.message.chat.id,'sub');}
      else if(cb.data==='admin_account'){if(isTgAdmin(cb.from?.id))await tgAdminAction(cb.message.chat.id,'account');}
      else if(cb.data==='admin_token'){if(isTgAdmin(cb.from?.id)){await putDoc('telegram_admin_token_state',String(cb.message.chat.id),{step:'amount',expires:Date.now()+5*60*1000});await tg('sendMessage',{chat_id:cb.message.chat.id,text:'🎟 Создание токена\n\nВведите сумму токена в ⭐ (1–100000):',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'admin'}]]}});}}
      else if(cb.data==='admin_testpurchase'){if(isTgAdmin(cb.from?.id))await tgTestPurchase(cb.message.chat.id);}
      else if(cb.data==='admin_ban'){if(isTgAdmin(cb.from?.id))await tgAdminAction(cb.message.chat.id,'ban');}
      else if(cb.data==='admin_unban'){if(isTgAdmin(cb.from?.id))await tgAdminAction(cb.message.chat.id,'unban');}
      else if(cb.data==='status')await tgStatus(cb.message.chat.id);
      else if(cb.data==='balance')await tgBalance(cb.message.chat.id);
      else if(cb.data==='topup')await tgTopup(cb.message.chat.id);
      else if(cb.data==='redeem_token')await tg('sendMessage',{chat_id:cb.message.chat.id,text:'🎟 Введите токен сообщением.\n\nПример: EKO-AB12-CD34-EF56-7890'});
      else if(cb.data==='topup_15')await tgTopupInvoice(cb.message.chat.id,15);
      else if(cb.data==='topup_25')await tgTopupInvoice(cb.message.chat.id,25);
      else if(cb.data==='topup_custom'){
        await putDoc('telegram_topup_state',String(cb.message.chat.id),{expires:Date.now()+10*60*1000});
        await tg('sendMessage',{chat_id:cb.message.chat.id,text:'💳 Введите сумму пополнения в звёздах числом.\n\nНапример: 50',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'balance'}]]}});
      }
      else if(cb.data==='buy_balance_account')await tgConfirmBalancePurchase(cb.message.chat.id);
      else if(cb.data==='confirm_balance_account')await tgBuyFromBalance(cb.message.chat.id,cb.from?.id||cb.message.chat.id);
      else if(cb.data==='donate')await tgDonate(cb.message.chat.id);
      else if(cb.data==='personal_buy')await tgPersonalStart(cb.message.chat.id);
      else if(cb.data==='personal_forever')await tgPersonalForeverInvoice(cb.message.chat.id);
      else if(cb.data==='personal_infinite_coins')await tgPersonalInfiniteCoinsInvoice(cb.message.chat.id);
      else if(cb.data==='personal_custom')await (async()=>{await putDoc('telegram_personal_state',String(cb.message.chat.id),{step:'days',expires:Date.now()+15*60*1000});return tg('sendMessage',{chat_id:cb.message.chat.id,text:'⚙️ Настройка персонального аккаунта\n\nВыберите, на сколько дней нужен Premium:',reply_markup:tgPersonalDaysKeyboard()})})();
      else if(/^personal_days_\d+$/.test(cb.data))await tgPersonalSetDays(cb.message.chat.id,Number(cb.data.slice('personal_days_'.length)));
      else if(cb.data==='personal_days_custom')await tgPersonalCustomInput(cb.message.chat.id,'days_custom');
      else if(/^personal_coins_\d+$/.test(cb.data))await tgPersonalSetCoins(cb.message.chat.id,Number(cb.data.slice('personal_coins_'.length)));
      else if(cb.data==='personal_coins_custom')await tgPersonalCustomInput(cb.message.chat.id,'coins_custom');
      else if(cb.data.startsWith('personal_pay_'))await tgPersonalInvoice(cb.message.chat.id,cb.data.slice('personal_pay_'.length));
      else if(/^personal_rate_[1-5]_.+$/.test(cb.data))await tgPersonalRating(cb.message.chat.id,cb.data.split('_').pop(),Number(cb.data.split('_')[2]));
      else if(cb.data==='buy_account')await tgBuyAccountInfo(cb.message.chat.id);
      else if(cb.data==='buy_account_pay')await tgBuyAccountInvoice(cb.message.chat.id);
      else if(cb.data==='donate_15')await tgStarInvoice(cb.message.chat.id,15);
      else if(cb.data==='donate_25')await tgStarInvoice(cb.message.chat.id,25);
      else if(cb.data==='donate_custom')await tgCustomAmount(cb.message.chat.id);
      else if(cb.data==='menu'){
        await deleteDoc('telegram_donate_state',String(cb.message.chat.id));
        await deleteDoc('telegram_topup_state',String(cb.message.chat.id));
        await tgStart(cb.message.chat.id);
      }
      await tg('answerCallbackQuery',{callback_query_id:cb.id});
    }
  }catch(e){console.error('Telegram bot error:',e.message)}
});

async function ctg(method,body){
  if(!TELEGRAM_COINS_BOT_TOKEN)return null;
  const r=await fetch('https://api.telegram.org/bot'+TELEGRAM_COINS_BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  return r.json();
}
function coinsKeyboard(){
  return {inline_keyboard:[
    [{text:'👤 Привязать аккаунт',callback_data:'coins_link'}],
    [{text:'🪙 Купить ЭКОкоины',callback_data:'coins_buy'}],
    [{text:'💰 Баланс аккаунта',callback_data:'coins_balance'}]
  ]};
}
async function coinsAdminTestPayment(chatId,text){
  if(!TELEGRAM_ADMIN_IDS.includes(String(chatId)))return ctg('sendMessage',{chat_id:chatId,text:'⛔ Команда доступна только администратору.'});
  const m=String(text||'').match(/^\/admin1set1(?:\s+(100|500|1000|2500))?$/);
  if(!m)return ctg('sendMessage',{chat_id:chatId,text:'🧪 Тестовая покупка\n\nИспользование: /admin1set1 100\nДоступно: 100, 500, 1000 или 2500 ЭКОкоинов.'});
  const coins=Number(m[1]),stars={100:5,500:20,1000:35,2500:75}[coins];
  const st=await getDoc('telegram_coins_state',String(chatId));
  if(!st?.uid)return ctg('sendMessage',{chat_id:chatId,text:'⚠️ Сначала привяжите аккаунт EKOOOL.'});
  const u=await getDoc('users',String(st.uid));
  if(!u)return ctg('sendMessage',{chat_id:chatId,text:'❌ Аккаунт не найден.'});
  const balance=Number(u.coins||0)+coins;
  await patchDoc('users',String(st.uid),{coins:balance});
  await putDoc('txs','coinbuy_test_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),{uid:String(st.uid),ts:Date.now(),amt:coins,note:'ТЕСТОВАЯ покупка ЭКОкоинов: '+stars+' ⭐'});
  return ctg('sendMessage',{chat_id:chatId,text:'🧪 Тестовая покупка выполнена!\n\n👤 Аккаунт: @'+(u.username||u.id)+'\n🪙 Начислено: '+coins+' ЭКОкоинов\n⭐ Тестовая сумма: '+stars+' ⭐\n💰 Новый баланс: '+balance+' 🪙\n\nРеальные Stars не списывались.',reply_markup:coinsKeyboard()});
}
async function coinsStart(chatId){
  return ctg('sendMessage',{chat_id:chatId,text:'🪙 EKOOOL ЭКОкоины\n\nПокупайте ЭКОкоины для своего аккаунта EKOOOL через Telegram Stars.\n\nСначала привяжите аккаунт, затем выберите пакет.',reply_markup:coinsKeyboard()});
}
async function coinsLink(chatId){
  await putDoc('telegram_coins_state',String(chatId),{step:'username',expires:Date.now()+10*60*1000});
  return ctg('sendMessage',{chat_id:chatId,text:'👤 Введите ваш юзернейм EKOOOL.\n\nНапример: @username',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'coins_menu'}]]}});
}
async function coinsPackages(chatId){
  const st=await getDoc('telegram_coins_state',String(chatId));
  if(!st?.uid)return ctg('sendMessage',{chat_id:chatId,text:'⚠️ Сначала привяжите аккаунт EKOOOL.',reply_markup:{inline_keyboard:[[{text:'👤 Привязать аккаунт',callback_data:'coins_link'}]]}});
  return ctg('sendMessage',{chat_id:chatId,text:'🪙 Выберите пакет ЭКОкоинов:\n\n100 🪙 — 5 ⭐\n500 🪙 — 20 ⭐\n1000 🪙 — 35 ⭐\n2500 🪙 — 75 ⭐',reply_markup:{inline_keyboard:[
    [{text:'100 🪙 · 5 ⭐',callback_data:'coins_100'}],
    [{text:'500 🪙 · 20 ⭐',callback_data:'coins_500'}],
    [{text:'1000 🪙 · 35 ⭐',callback_data:'coins_1000'}],
    [{text:'2500 🪙 · 75 ⭐',callback_data:'coins_2500'}],
    [{text:'⬅️ Назад',callback_data:'coins_menu'}]
  ]}});
}
async function coinsConfirm(chatId,coins,stars){
  const st=await getDoc('telegram_coins_state',String(chatId));
  if(!st?.uid)return ctg('sendMessage',{chat_id:chatId,text:'⚠️ Сначала привяжите аккаунт.'});
  const u=await getDoc('users',String(st.uid));
  if(!u)return ctg('sendMessage',{chat_id:chatId,text:'❌ Аккаунт не найден. Привяжите его заново.'});
  const finalStars=Boolean(u.scam)?stars*2:stars;
  await putDoc('telegram_coins_pending',String(chatId),{uid:st.uid,coins,stars:finalStars,expires:Date.now()+15*60*1000});
  return ctg('sendMessage',{chat_id:chatId,text:'🪙 Подтверждение покупки\n\n👤 Аккаунт: @'+(u.username||u.id)+'\n🪙 ЭКОкоинов: '+coins+'\n⭐ Стоимость: '+finalStars+' ⭐'+(u.scam?'\n⚠️ Для аккаунта с меткой «Скам» действует цена ×2.':'')+'\n\nПодтвердить покупку?',reply_markup:{inline_keyboard:[
    [{text:'✅ Купить',callback_data:'coins_confirm_'+coins+'_'+stars}],
    [{text:'❌ Отмена',callback_data:'coins_buy'}]
  ]}});
}
async function coinsInvoice(chatId,coins,stars){
  const st=await getDoc('telegram_coins_state',String(chatId));
  if(!st?.uid)return ctg('sendMessage',{chat_id:chatId,text:'⚠️ Сначала привяжите аккаунт.'});
  const u=await getDoc('users',String(st.uid));
  if(!u)return ctg('sendMessage',{chat_id:chatId,text:'❌ Аккаунт не найден. Привяжите его заново.'});
  const finalStars=Boolean(u.scam)?stars*2:stars;
  const payload='ekoool_coins_'+st.uid+'_'+coins+'_'+finalStars+'_'+Date.now();
  await putDoc('telegram_coins_pending',String(chatId),{uid:st.uid,coins,stars:finalStars,payload,expires:Date.now()+15*60*1000});
  return ctg('sendInvoice',{chat_id:chatId,title:'ЭКОкоины EKOOOL',description:coins+' ЭКОкоинов для @'+(u.username||u.id),payload,currency:'XTR',prices:[{label:coins+' ЭКОкоинов',amount:finalStars}]});
}
async function coinsBalance(chatId){
  const st=await getDoc('telegram_coins_state',String(chatId));
  if(!st?.uid)return ctg('sendMessage',{chat_id:chatId,text:'⚠️ Сначала привяжите аккаунт.',reply_markup:coinsKeyboard()});
  const u=await getDoc('users',String(st.uid));
  if(!u)return ctg('sendMessage',{chat_id:chatId,text:'❌ Аккаунт не найден.',reply_markup:coinsKeyboard()});
  return ctg('sendMessage',{chat_id:chatId,text:'💰 Баланс @'+(u.username||u.id)+'\n\n🪙 ЭКОкоины: '+Number(u.coins||0),reply_markup:coinsKeyboard()});
}
async function setupCoinsTelegram(){
  if(!TELEGRAM_COINS_BOT_TOKEN)return;
  try{
    await ctg('setWebhook',{url:TELEGRAM_COINS_WEBHOOK_URL,secret_token:TELEGRAM_COINS_WEBHOOK_SECRET||undefined,drop_pending_updates:false});
    console.log('EKOOOL Coins Telegram bot webhook configured');
  }catch(e){console.error('EKOOOL Coins Telegram webhook failed:',e.message)}
}


async function mtg(method,body){
  if(!TELEGRAM_MARKET_BOT_TOKEN)throw new Error('TELEGRAM_MARKET_BOT_TOKEN не настроен');
  const r=await fetch('https://api.telegram.org/bot'+TELEGRAM_MARKET_BOT_TOKEN+'/'+method,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})
  });
  const x=await r.json().catch(()=>({}));
  if(!r.ok||!x.ok)throw new Error(x?.description||'Telegram Market API error');
  return x.result;
}
function marketKeyboard(){
  return {inline_keyboard:[
    [{text:'💰 Продать аккаунт',callback_data:'market_sell'}],
    [{text:'🛒 Купить аккаунт',callback_data:'market_buy'}],
    [{text:'📦 Мои объявления',callback_data:'market_my'}]
  ]};
}
function marketHash(password,salt){
  return crypto.createHash('sha256').update(String(salt)+String(password)).digest('hex');
}
async function marketFindUser(username,password){
  const un=String(username||'').trim().toLowerCase().replace(/^@/,'');
  const map=await getDoc('usernames',un);
  if(!map?.uid)return null;
  const u=await getDoc('users',String(map.uid));
  if(!u||!u.passHash||!u.salt||marketHash(password,u.salt)!==u.passHash)return null;
  return {id:String(map.uid),...u};
}
function marketPassword(){
  return crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g,'').slice(0,14)+'A9!';
}
async function marketStart(chatId){
  return mtg('sendMessage',{chat_id:chatId,text:'🏪 EKOOOL Маркет\n\nЗдесь можно безопасно продать аккаунт EKOOOL и получить ЭКОКоины на другой свой аккаунт или купить аккаунт за ЭКОКоины.\n\n⚠️ Никому не передавайте пароль вне этого бота.',reply_markup:marketKeyboard()});
}
async function marketSell(chatId){
  await putDoc('telegram_market_state',String(chatId),{step:'seller_username',expires:Date.now()+15*60*1000});
  return mtg('sendMessage',{chat_id:chatId,text:'💰 Продажа аккаунта\n\nВведите юзернейм аккаунта, который хотите продать:',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'market_menu'}]]}});
}
async function marketBuy(chatId){
  const rows=(await getCollection('market_listings')).filter(x=>x.data?.status==='active').sort((a,b)=>Number(b.data?.createdAt||0)-Number(a.data?.createdAt||0)).slice(0,12);
  if(!rows.length)return mtg('sendMessage',{chat_id:chatId,text:'🛒 Сейчас активных объявлений нет.',reply_markup:marketKeyboard()});
  const buttons=rows.map(x=>{
    const d=x.data||{};
    return [{text:'@'+String(d.username||'аккаунт')+' — '+Number(d.price||0).toLocaleString('ru-RU')+' 🪙',callback_data:'market_item_'+x.id}];
  });
  buttons.push([{text:'⬅️ Назад',callback_data:'market_menu'}]);
  return mtg('sendMessage',{chat_id:chatId,text:'🛒 Доступные аккаунты\n\nВыберите аккаунт:',reply_markup:{inline_keyboard:buttons}});
}
async function marketItem(chatId,id){
  const l=await getDoc('market_listings',String(id));
  if(!l||l.status!=='active')return mtg('sendMessage',{chat_id:chatId,text:'❌ Объявление уже продано или снято.',reply_markup:marketKeyboard()});
  const u=await getDoc('users',String(l.sellerId));
  if(!u)return mtg('sendMessage',{chat_id:chatId,text:'❌ Аккаунт больше недоступен.',reply_markup:marketKeyboard()});
  const prem=u.premiumForever?'НАВСЕГДА':u.premiumUntil>Date.now()?new Date(u.premiumUntil).toLocaleDateString('ru-RU'):'нет';
  const text='📦 Аккаунт: @'+l.username+'\n🪙 Цена: '+Number(l.price).toLocaleString('ru-RU')+' ЭКОкоинов\n💰 Баланс аккаунта: '+Number(u.coins||0).toLocaleString('ru-RU')+' 🪙\n👑 Premium: '+prem+'\n\nПосле покупки бот выдаст новый пароль. Старый владелец будет автоматически выведен из аккаунта.';
  return mtg('sendMessage',{chat_id:chatId,text,reply_markup:{inline_keyboard:[
    [{text:'✅ Купить за '+Number(l.price).toLocaleString('ru-RU')+' 🪙',callback_data:'market_confirm_'+id}],
    [{text:'⬅️ К объявлениям',callback_data:'market_buy'}]
  ]}});
}
async function marketConfirm(chatId,id){
  const l=await getDoc('market_listings',String(id));
  if(!l||l.status!=='active')return mtg('sendMessage',{chat_id:chatId,text:'❌ Объявление уже недоступно.',reply_markup:marketKeyboard()});
  await putDoc('telegram_market_state',String(chatId),{step:'buyer_username',listingId:String(id),expires:Date.now()+15*60*1000});
  return mtg('sendMessage',{chat_id:chatId,text:'🔐 Для оплаты войдите в свой EKOOOL аккаунт.\n\nВведите ваш юзернейм:',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'market_menu'}]]}});
}
async function marketMy(chatId){
  const rows=(await getCollection('market_listings')).filter(x=>x.data?.sellerChatId===String(chatId)&&x.data?.status==='active');
  if(!rows.length)return mtg('sendMessage',{chat_id:chatId,text:'📦 У вас нет активных объявлений.',reply_markup:marketKeyboard()});
  const buttons=rows.map(x=>[{text:'@'+x.data.username+' — '+Number(x.data.price).toLocaleString('ru-RU')+' 🪙',callback_data:'market_cancel_'+x.id}]);
  return mtg('sendMessage',{chat_id:chatId,text:'📦 Ваши объявления\n\nНажмите на объявление, чтобы снять его:',reply_markup:{inline_keyboard:buttons.concat([[{text:'⬅️ Назад',callback_data:'market_menu'}]])}});
}
async function marketCancel(chatId,id){
  const l=await getDoc('market_listings',String(id));
  if(!l||l.status!=='active'||String(l.sellerChatId)!==String(chatId))return mtg('sendMessage',{chat_id:chatId,text:'❌ Объявление не найдено.',reply_markup:marketKeyboard()});
  await patchDoc('market_listings',String(id),{status:'cancelled',cancelledAt:Date.now()});
  return mtg('sendMessage',{chat_id:chatId,text:'✅ Объявление снято с продажи.',reply_markup:marketKeyboard()});
}
async function marketCreateListing(chatId,userId,destinationUsername,price){
  const seller=await getDoc('users',String(userId));
  const destMap=await getDoc('usernames',String(destinationUsername).toLowerCase().replace(/^@/,''));
  const dest=destMap?.uid?await getDoc('users',String(destMap.uid)):null;
  const p=Math.floor(Number(price)||0);
  if(!seller||!dest)return {error:'Аккаунт продавца или аккаунт для получения коинов не найден.'};
  if(String(destMap.uid)===String(userId))return {error:'Нельзя получать оплату на тот же аккаунт, который продаётся.'};
  if(p<1||p>1000000000)return {error:'Цена должна быть от 1 до 1 000 000 000 ЭКОкоинов.'};
  if(seller.admin||seller.bot||seller.aiBot||seller.type==='bot'||seller.banned||seller.blockedUntil>Date.now())return {error:'Этот аккаунт нельзя выставить на продажу.'};
  const active=(await getCollection('market_listings')).find(x=>x.data?.status==='active'&&String(x.data.sellerId)===String(userId));
  if(active)return {error:'У вас уже есть активное объявление для этого аккаунта.'};
  const id='MKT-'+Date.now().toString(36)+'-'+crypto.randomBytes(4).toString('hex');
  await putDoc('market_listings',id,{sellerId:String(userId),sellerChatId:String(chatId),destinationId:String(destMap.uid),destinationUsername:String(destinationUsername).replace(/^@/,''),username:String(seller.username||''),price:p,status:'active',createdAt:Date.now()});
  return {id};
}
async function marketCompletePurchase(listingId,buyerId){
  if(pool){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const lr=await client.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2 FOR UPDATE',['market_listings',String(listingId)]);
      const l=lr.rows[0]?.data;
      if(!l||l.status!=='active')throw new Error('Объявление уже продано или снято.');
      if(String(l.sellerId)===String(buyerId))throw new Error('Нельзя купить собственный аккаунт.');
      const br=await client.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2 FOR UPDATE',['users',String(buyerId)]);
      const sr=await client.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2 FOR UPDATE',['users',String(l.sellerId)]);
      const dr=await client.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2 FOR UPDATE',['users',String(l.destinationId)]);
      const buyer=br.rows[0]?.data,seller=sr.rows[0]?.data,dest=dr.rows[0]?.data;
      if(!buyer||!seller||!dest)throw new Error('Аккаунт сделки больше не существует.');
      const price=Math.floor(Number(l.price)||0),bc=Number(buyer.coins||0);
      if(bc<price)throw new Error('Недостаточно ЭКОкоинов.');
      const newPass=marketPassword(),salt=crypto.randomBytes(8).toString('hex');
      const passHash=marketHash(newPass,salt);
      const transferred={...seller,salt,passHash,twoFA:'',telegramChatId:'',telegramLinkedAt:0,marketTransferredAt:Date.now(),marketPreviousOwner:String(l.sellerId),lastSeen:Date.now()};
      const newDestCoins=Number(dest.coins||0)+price;
      await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['users',String(buyerId),JSON.stringify({...buyer,coins:bc-price})]);
      await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['users',String(l.destinationId),JSON.stringify({...dest,coins:newDestCoins})]);
      await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['users',String(l.sellerId),JSON.stringify(transferred)]);
      await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',['market_listings',String(listingId),JSON.stringify({...l,status:'sold',buyerId:String(buyerId),soldAt:Date.now()})]);
      await client.query("DELETE FROM ekoool_kv WHERE collection=$1 AND data->>'uid'=$2",['sessions',String(l.sellerId)]);
      await client.query('COMMIT');
      return {username:seller.username,password:newPass,price,destinationUsername:l.destinationUsername};
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }
  const l=await getDoc('market_listings',String(listingId));
  if(!l||l.status!=='active')throw new Error('Объявление уже продано или снято.');
  if(String(l.sellerId)===String(buyerId))throw new Error('Нельзя купить собственный аккаунт.');
  const buyer=await getDoc('users',String(buyerId)),seller=await getDoc('users',String(l.sellerId)),dest=await getDoc('users',String(l.destinationId));
  const price=Math.floor(Number(l.price)||0);
  if(!buyer||!seller||!dest)throw new Error('Аккаунт сделки больше не существует.');
  if(Number(buyer.coins||0)<price)throw new Error('Недостаточно ЭКОкоинов.');
  const newPass=marketPassword(),salt=crypto.randomBytes(8).toString('hex');
  await patchDoc('users',String(buyerId),{coins:Number(buyer.coins||0)-price});
  await patchDoc('users',String(l.destinationId),{coins:Number(dest.coins||0)+price});
  await patchDoc('users',String(l.sellerId),{salt,passHash:marketHash(newPass,salt),twoFA:'',telegramChatId:'',telegramLinkedAt:0,marketTransferredAt:Date.now(),marketPreviousOwner:String(l.sellerId)});
  await patchDoc('market_listings',String(listingId),{status:'sold',buyerId:String(buyerId),soldAt:Date.now()});
  return {username:seller.username,password:newPass,price,destinationUsername:l.destinationUsername};
}
async function setupMarketTelegram(){
  if(!TELEGRAM_MARKET_BOT_TOKEN)return;
  try{
    await mtg('setWebhook',{url:TELEGRAM_MARKET_WEBHOOK_URL,secret_token:TELEGRAM_MARKET_WEBHOOK_SECRET||undefined,drop_pending_updates:false});
    console.log('EKOOOL Market Telegram bot webhook configured');
  }catch(e){console.error('EKOOOL Market Telegram webhook failed:',e.message)}
}

app.post('/api/telegram/market-webhook',async(req,res)=>{
  if(TELEGRAM_MARKET_WEBHOOK_SECRET && req.get('x-telegram-bot-api-secret-token')!==TELEGRAM_MARKET_WEBHOOK_SECRET)return res.sendStatus(401);
  res.sendStatus(200);
  try{
    const u=req.body||{},msg=u.message,cb=u.callback_query;
    if(cb?.message?.chat?.id){
      const chatId=cb.message.chat.id;
      if(cb.data==='market_menu')await marketStart(chatId);
      else if(cb.data==='market_sell')await marketSell(chatId);
      else if(cb.data==='market_buy')await marketBuy(chatId);
      else if(cb.data==='market_my')await marketMy(chatId);
      else if(/^market_item_/.test(cb.data))await marketItem(chatId,cb.data.slice('market_item_'.length));
      else if(/^market_confirm_/.test(cb.data))await marketConfirm(chatId,cb.data.slice('market_confirm_'.length));
      else if(/^market_cancel_/.test(cb.data))await marketCancel(chatId,cb.data.slice('market_cancel_'.length));
      await mtg('answerCallbackQuery',{callback_query_id:cb.id});
      return;
    }
    if(msg?.chat?.id){
      const chatId=msg.chat.id,text=String(msg.text||'').trim();
      const st=await getDoc('telegram_market_state',String(chatId));
      if(st&&st.expires>Date.now()){
        if(st.step==='seller_username'){
          const un=text.replace(/^@/,'').toLowerCase(),map=await getDoc('usernames',un);
          if(!map?.uid)return mtg('sendMessage',{chat_id:chatId,text:'❌ Юзернейм не найден. Попробуйте ещё раз.'});
          await putDoc('telegram_market_state',String(chatId),{step:'seller_password',sellerId:String(map.uid),expires:Date.now()+10*60*1000});
          return mtg('sendMessage',{chat_id:chatId,text:'🔐 Теперь введите пароль этого аккаунта.\n\nПароль используется только для проверки и не сохраняется ботом.',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'market_menu'}]]}});
        }
        if(st.step==='seller_password'){
          const seller=await getDoc('users',String(st.sellerId));
          if(!seller||marketHash(text,seller.salt)!==seller.passHash)return mtg('sendMessage',{chat_id:chatId,text:'❌ Неверный пароль. Попробуйте ещё раз.'});
          await putDoc('telegram_market_state',String(chatId),{step:'seller_destination',sellerId:String(st.sellerId),expires:Date.now()+10*60*1000});
          return mtg('sendMessage',{chat_id:chatId,text:'🪙 Введите юзернейм другого вашего EKOOOL аккаунта, куда получить оплату:',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'market_menu'}]]}});
        }
        if(st.step==='seller_destination'){
          const dest=text.replace(/^@/,'').toLowerCase(),dm=await getDoc('usernames',dest);
          if(!dm?.uid)return mtg('sendMessage',{chat_id:chatId,text:'❌ Аккаунт для получения коинов не найден.'});
          if(String(dm.uid)===String(st.sellerId))return mtg('sendMessage',{chat_id:chatId,text:'❌ Укажите другой аккаунт.'});
          await putDoc('telegram_market_state',String(chatId),{step:'seller_price',sellerId:String(st.sellerId),destinationUsername:dest,expires:Date.now()+10*60*1000});
          return mtg('sendMessage',{chat_id:chatId,text:'💰 Введите цену в ЭКОКоинах (например, 5000):'});
        }
        if(st.step==='seller_price'){
          if(!/^\d+$/.test(text))return mtg('sendMessage',{chat_id:chatId,text:'❌ Введите только целое число ЭКОКоинов.'});
          const result=await marketCreateListing(chatId,st.sellerId,st.destinationUsername,Number(text));
          await deleteDoc('telegram_market_state',String(chatId));
          if(result.error)return mtg('sendMessage',{chat_id:chatId,text:'❌ '+result.error,reply_markup:marketKeyboard()});
          return mtg('sendMessage',{chat_id:chatId,text:'✅ Аккаунт выставлен на продажу!\n\n👤 @'+String((await getDoc('users',st.sellerId)).username||'')+'\n🪙 Цена: '+Number(text).toLocaleString('ru-RU')+' ЭКОкоинов\n\nОплата после покупки уйдёт на @'+st.destinationUsername+'.',reply_markup:marketKeyboard()});
        }
        if(st.step==='buyer_username'){
          const un=text.replace(/^@/,'').toLowerCase(),map=await getDoc('usernames',un);
          if(!map?.uid)return mtg('sendMessage',{chat_id:chatId,text:'❌ Юзернейм не найден.'});
          await putDoc('telegram_market_state',String(chatId),{step:'buyer_password',buyerId:String(map.uid),listingId:String(st.listingId),expires:Date.now()+10*60*1000});
          return mtg('sendMessage',{chat_id:chatId,text:'🔐 Введите пароль вашего EKOOOL аккаунта.\n\nПароль используется только для проверки.',reply_markup:{inline_keyboard:[[{text:'❌ Отмена',callback_data:'market_menu'}]]}});
        }
        if(st.step==='buyer_password'){
          const buyer=await getDoc('users',String(st.buyerId));
          if(!buyer||marketHash(text,buyer.salt)!==buyer.passHash)return mtg('sendMessage',{chat_id:chatId,text:'❌ Неверный пароль. Попробуйте ещё раз.'});
          try{
            const result=await marketCompletePurchase(st.listingId,st.buyerId);
            await deleteDoc('telegram_market_state',String(chatId));
            return mtg('sendMessage',{chat_id:chatId,text:'🎉 ПОКУПКА УСПЕШНА!\n\n👤 Аккаунт: @'+result.username+'\n🔐 Новый пароль: '+result.password+'\n🪙 Списано: '+result.price.toLocaleString('ru-RU')+' ЭКОкоинов\n\n⚠️ Старый владелец больше не может войти по старому паролю. Сохраните новый пароль.',reply_markup:marketKeyboard()});
          }catch(e){
            return mtg('sendMessage',{chat_id:chatId,text:'❌ Сделка не выполнена: '+String(e.message||e),reply_markup:marketKeyboard()});
          }
        }
      }
      if(text==='/start'||text==='старт')return marketStart(chatId);
      return mtg('sendMessage',{chat_id:chatId,text:'Выберите действие:',reply_markup:marketKeyboard()});
    }
  }catch(e){console.error('EKOOOL Market bot error:',e.message)}
});

async function setupTelegram(){
  if(!TELEGRAM_BOT_TOKEN)return;
  try{
    await tg('setWebhook',{url:TELEGRAM_WEBHOOK_URL,secret_token:TELEGRAM_WEBHOOK_SECRET||undefined,drop_pending_updates:false});
    console.log('EKOOOL Telegram bot webhook configured');
  }catch(e){console.error('Telegram webhook setup failed:',e.message)}
}

app.post('/api/telegram/coins-webhook',async(req,res)=>{
  if(TELEGRAM_COINS_WEBHOOK_SECRET && req.get('x-telegram-bot-api-secret-token')!==TELEGRAM_COINS_WEBHOOK_SECRET)return res.sendStatus(401);
  res.sendStatus(200);
  try{
    const u=req.body||{},msg=u.message,cb=u.callback_query,pc=u.pre_checkout_query;
    if(pc?.id){
      const payload=String(pc.invoice_payload||''),m=payload.match(/^ekoool_coins_([^_]+)_(\d+)_(\d+)_\d+$/);
      const ok=pc.currency==='XTR'&&!!m&&Number(pc.total_amount)===Number(m[3]);
      await ctg('answerPreCheckoutQuery',{pre_checkout_query_id:pc.id,ok,...(!ok?{error_message:'Платёж не удалось подтвердить. Попробуйте ещё раз.'}:{})});
      return;
    }
    if(msg?.successful_payment?.telegram_payment_charge_id){
      const p=msg.successful_payment,charge=String(p.telegram_payment_charge_id);
      if(await getDoc('telegram_coins_payments',charge))return;
      const m=String(p.invoice_payload||'').match(/^ekoool_coins_([^_]+)_(\d+)_(\d+)_\d+$/);
      if(!m)return;
      const uid=m[1],coins=Number(m[2]),stars=Number(m[3]);
      if(p.currency!=='XTR'||Number(p.total_amount)!==stars)return;
      const us=await getDoc('users',uid);
      if(!us)return ctg('sendMessage',{chat_id:msg.chat.id,text:'❌ Аккаунт не найден. Обратитесь в поддержку.'});
      const balance=Number(us.coins||0)+coins;
      await patchDoc('users',uid,{coins:balance});
      await putDoc('txs','coinbuy_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),{uid,ts:Date.now(),amt:coins,note:'Покупка ЭКОкоинов через Telegram Stars: '+stars+' ⭐'});
      await putDoc('telegram_coins_payments',charge,{chatId:msg.chat.id,uid,coins,stars,payload:p.invoice_payload,chargeId:charge,ts:Date.now()});
      await ctg('sendMessage',{chat_id:msg.chat.id,text:'✅ Покупка завершена!\n\n🪙 Начислено: '+coins+' ЭКОкоинов\n💰 Новый баланс: '+balance+' 🪙',reply_markup:coinsKeyboard()});
      return;
    }
    if(cb?.message?.chat?.id){
      const chatId=cb.message.chat.id;
      if(cb.data==='coins_link')await coinsLink(chatId);
      else if(cb.data==='coins_buy')await coinsPackages(chatId);
      else if(cb.data==='coins_balance')await coinsBalance(chatId);
      else if(cb.data==='coins_menu')await coinsStart(chatId);
      else if(cb.data==='coins_100')await coinsConfirm(chatId,100,5);
      else if(cb.data==='coins_500')await coinsConfirm(chatId,500,20);
      else if(cb.data==='coins_1000')await coinsConfirm(chatId,1000,35);
      else if(cb.data==='coins_2500')await coinsConfirm(chatId,2500,75);
      else if(/^coins_confirm_\\d+_\\d+$/.test(cb.data)){
        const m=cb.data.match(/^coins_confirm_(\\d+)_(\\d+)$/);
        const pending=await getDoc('telegram_coins_pending',String(chatId));
        if(!pending||pending.expires<Date.now()||pending.coins!==Number(m[1])||pending.stars!==Number(m[2])){
          await ctg('sendMessage',{chat_id:chatId,text:'❌ Покупка устарела. Выберите пакет заново.',reply_markup:coinsKeyboard()});
        }else{
          await coinsInvoice(chatId,Number(m[1]),Number(m[2]));
        }
      }
      await ctg('answerCallbackQuery',{callback_query_id:cb.id});
      return;
    }
    if(msg?.chat?.id){
      const chatId=msg.chat.id,text=String(msg.text||'').trim();
      const st=await getDoc('telegram_coins_state',String(chatId));
      if(st?.step==='username'&&st.expires>Date.now()){
        const un=text.replace(/^@/,'').toLowerCase();
        const map=await getDoc('usernames',un);
        if(!map?.uid){await ctg('sendMessage',{chat_id:chatId,text:'❌ Такой юзернейм EKOOOL не найден. Попробуйте ещё раз.'});return;}
        const user=await getDoc('users',String(map.uid));
        if(!user){await ctg('sendMessage',{chat_id:chatId,text:'❌ Аккаунт не найден.'});return;}
        await putDoc('telegram_coins_state',String(chatId),{uid:String(map.uid),username:un,linkedAt:Date.now()});
        await ctg('sendMessage',{chat_id:chatId,text:'✅ Аккаунт привязан!\n\n👤 @'+un+'\n🪙 Баланс: '+Number(user.coins||0)+' ЭКОкоинов',reply_markup:coinsKeyboard()});
        return;
      }
      if(text==='/start'||text==='старт')await coinsStart(chatId);
      else if(/^\/admin1set1(?:\s|$)/.test(text))await coinsAdminTestPayment(chatId,text);
      else if(text==='/buy'||text==='купить')await coinsPackages(chatId);
      else await ctg('sendMessage',{chat_id:chatId,text:'Выберите действие:',reply_markup:coinsKeyboard()});
    }
  }catch(e){console.error('EKOOOL Coins bot error:',e.message)}
});

app.get('/api/health',async(req,res)=>{
  try{
    const users=(await getCollection('users')).length;
    res.json({ok:true,service:'EKOOOL server',storage:usePg?'postgresql':'json',users});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.use(express.static(__dirname,{index:'index.html'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

initDb().then(()=>{
  app.listen(PORT,'0.0.0.0',async()=>{console.log('EKOOOL server listening on '+PORT+' | storage: '+(usePg?'PostgreSQL':'JSON'));await setupTelegram();await setupCoinsTelegram();await setupMarketTelegram();});
}).catch(e=>{
  console.error('EKOOOL database init failed:',e);
  process.exit(1);
});

// Render redeploy trigger
// manual restart 2026-10-01
