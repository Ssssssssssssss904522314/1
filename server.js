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
  if(!pool)return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ekoool_kv(
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY(collection,id)
    )
  `);
  const n=await pool.query('SELECT COUNT(*)::int AS n FROM ekoool_kv');
  if(n.rows[0].n===0 && Object.keys(fileDb).length){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      for(const [collection,docs] of Object.entries(fileDb)){
        for(const [id,data] of Object.entries(docs||{})){
          await client.query(
            'INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [collection,id,JSON.stringify(data)]
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

function adminToken(){return crypto.createHmac('sha256',ADMIN_PASSWORD).update('ekoool-admin').digest('hex')}
function isAdmin(req){return !!ADMIN_PASSWORD&&(req.headers.authorization||'')==='Bearer '+adminToken()}
async function userAuth(req){
  const uid=String(req.headers['x-ekoool-user']||'').trim();
  const proof=String(req.headers['x-ekoool-proof']||'').trim();
  if(!uid||!proof)return null;
  const u=await getDoc('users',uid);
  return u&&u.passHash&&proof===u.passHash?{id:uid,...u}:null;
}
function publicUser(u){if(!u)return null;const x={...u};delete x.passHash;delete x.salt;x.tester=!!(u.tester||u.testerBadge);return x}
async function canWriteDoc(req,c,id,body){
  if(isAdmin(req))return true;
  const u=await userAuth(req);
  if(!u){
    if(c==='users'){
      const old=await getDoc(c,id);
      return !old&&!!body?.passHash&&!!body?.salt;
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

app.post('/api/admin/login',(req,res)=>{
  if(!ADMIN_PASSWORD)return res.status(503).json({error:'ADMIN_PASSWORD не настроен'});
  if(!adminLoginAllowed(req.ip))return res.status(429).json({error:'Слишком много попыток. Повторите позже.'});
  if(String(req.body?.password||'')!==ADMIN_PASSWORD)return res.status(401).json({error:'Неверный пароль'});
  res.json({token:adminToken()});
});
app.get('/api/admin/check',(req,res)=>isAdmin(req)?res.json({ok:true}):res.status(401).json({error:'Unauthorized'}));

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
    let docs=await getCollection(c);
    if(c==='msgs'||c==='gmsgs'||c==='gm'||c==='txs'){
      const u=await userAuth(req);
      if(!u&&!isAdmin(req))return res.status(401).json({error:'Unauthorized'});
      if(!isAdmin(req)){
        docs=docs.filter(d=>d.data?.a===u.id||d.data?.b===u.id||d.data?.uid===u.id);
      }
    }
    let w=req.query.where;
    let ws=Array.isArray(w)?w:(w?[w]:[]);
    if(ws.length){
      const ops=Array.isArray(req.query.op)?req.query.op:[req.query.op||'=='];
      const vals=Array.isArray(req.query.value)?req.query.value:[req.query.value];
      docs=docs.filter(d=>{
        for(let i=0;i<ws.length;i++){
          let want=vals[i];
          try{want=JSON.parse(want)}catch(e){}
          const got=d.data?.[ws[i]],op=ops[i]||'==';
          if(op==='=='&&got!==want)return false;
          if(op==='!='&&got===want)return false;
        }
        return true;
      });
    }
    if(c==='users'&&!isAdmin(req)){
      const u=await userAuth(req);
      docs=docs.map(d=>d.id===u?.id?d:{id:d.id,data:publicUser(d.data)});
    }
    res.json({docs});
  }catch(e){res.status(500).json({error:e.message})}
});


async function openAIText(instructions,input){
  if(!GROQ_API_KEY) throw new Error('GROQ_API_KEY не настроен');
  const messages=[{role:'system',content:instructions},...(Array.isArray(input)?input:[])];
  const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_API_KEY},
    body:JSON.stringify({model:GROQ_MODEL,messages,max_tokens:500,temperature:0.7})
  });
  const x=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(x?.error?.message||'Ошибка Groq API');
  const out=String(x?.choices?.[0]?.message?.content||'').trim();
  return out||'Извините, я не смог сформировать ответ.';
}

function botReply(id,text){
  return putDoc('msgs',id,text);
}

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
function tgKeyboard(){
  return {inline_keyboard:[
    [{text:'🟢 Состояние сервера',callback_data:'status'}],
    [{text:'💰 Баланс',callback_data:'balance'}],
    [{text:'⭐ Пополнить баланс',callback_data:'topup'}],
    [{text:'🎟 Активировать токен',callback_data:'redeem_token'}],
    [{text:'🛒 Купить аккаунт — 50 ⭐',callback_data:'buy_account'}]
  ]};
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
  const user={name:'EKOOOL Premium',photo:'',bio:'Покупной аккаунт EKOOOL',verified:false,red:true,premiumUntil:now+90*24*60*60*1000,premiumStart:now,coins:1000,username,extra:[],salt,passHash,lastSeen:now,ts:now};
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
      const ok=pc.currency==='XTR' && (
        (payload.startsWith('ekoool_donate_') && [15,25].includes(Number(pc.total_amount))) ||
        (payload.startsWith('ekoool_account_50_') && Number(pc.total_amount)===50) ||
        (payload.startsWith('ekoool_topup_') && Number(pc.total_amount)>=1 && Number(pc.total_amount)<=100000)
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
      if(String(p.invoice_payload||'').startsWith('ekoool_account_50_')){
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
      if(isTgAdmin(msg.from?.id)&&String(msg.text||'').trim().toLowerCase()==='/admin'){await tgAdminPanel(msg.chat.id);return;}
      if(isTgAdmin(msg.from?.id)&&String(msg.text||'').trim().toLowerCase()==='/service'){if(TELEGRAM_SERVICE_CHAT_ID)await tgServicePanel(TELEGRAM_SERVICE_CHAT_ID);else await tg('sendMessage',{chat_id:msg.chat.id,text:'❌ TELEGRAM_SERVICE_CHAT_ID не настроен.'});return;}
      if(isTgAdmin(msg.from?.id)&&await tgAdminToken(msg.chat.id,msg.from.id,msg.text))return;
      if(isTgAdmin(msg.from?.id)&&await tgAdminAmount(msg.chat.id,msg.from.id,msg.text))return;
      if(isTgAdmin(msg.from?.id)&&await tgAdminProcess(msg.chat.id,msg.from.id,msg.text))return;
      const text=String(msg.text||'').trim().toLowerCase();
      if(text==='/start'||text==='старт')await tgStart(msg.chat.id);
      else if(text.startsWith('/token '))await tgRedeemToken(msg.chat.id,msg.from?.id||msg.chat.id,text.slice(7));
      else if(text==='/add1234pp')await tgFreePurchasedAccount(msg.chat.id,msg.from?.id||msg.chat.id);
      else if(text==='состояние'||text.includes('состояние сервера'))await tgStatus(msg.chat.id);
      else{
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
async function coinsInvoice(chatId,coins,stars){
  const st=await getDoc('telegram_coins_state',String(chatId));
  if(!st?.uid)return ctg('sendMessage',{chat_id:chatId,text:'⚠️ Сначала привяжите аккаунт.'});
  const u=await getDoc('users',String(st.uid));
  if(!u)return ctg('sendMessage',{chat_id:chatId,text:'❌ Аккаунт не найден. Привяжите его заново.'});
  const payload='ekoool_coins_'+st.uid+'_'+coins+'_'+stars+'_'+Date.now();
  await putDoc('telegram_coins_pending',String(chatId),{uid:st.uid,coins,stars,payload,expires:Date.now()+15*60*1000});
  return ctg('sendInvoice',{chat_id:chatId,title:'ЭКОкоины EKOOOL',description:coins+' ЭКОкоинов для @'+(u.username||u.id),payload,currency:'XTR',prices:[{label:coins+' ЭКОкоинов',amount:stars}]});
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
      else if(cb.data==='coins_100')await coinsInvoice(chatId,100,5);
      else if(cb.data==='coins_500')await coinsInvoice(chatId,500,20);
      else if(cb.data==='coins_1000')await coinsInvoice(chatId,1000,35);
      else if(cb.data==='coins_2500')await coinsInvoice(chatId,2500,75);
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
  app.listen(PORT,'0.0.0.0',async()=>{console.log('EKOOOL server listening on '+PORT+' | storage: '+(usePg?'PostgreSQL':'JSON'));await setupTelegram();await setupCoinsTelegram();});
}).catch(e=>{
  console.error('EKOOOL database init failed:',e);
  process.exit(1);
});

// Render redeploy trigger
