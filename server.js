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
const DONATE_URL=process.env.DONATE_URL||'https://ekool-site.onrender.com/';

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
    [{text:'💰 Задонатить',url:DONATE_URL}]
  ]};
}
async function tgStart(chatId){
  return tg('sendMessage',{chat_id:chatId,text:'👋 Добро пожаловать в EKOOOL!\n\nВыберите действие:',reply_markup:tgKeyboard()});
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
    const cb=u.callback_query;
    if(msg?.chat?.id){
      const text=String(msg.text||'').trim().toLowerCase();
      if(text==='/start'||text==='старт')await tgStart(msg.chat.id);
      else if(text==='состояние'||text.includes('состояние сервера'))await tgStatus(msg.chat.id);
      else await tg('sendMessage',{chat_id:msg.chat.id,text:'Выберите действие:',reply_markup:tgKeyboard()});
    }else if(cb?.message?.chat?.id){
      if(cb.data==='status')await tgStatus(cb.message.chat.id);
      await tg('answerCallbackQuery',{callback_query_id:cb.id});
    }
  }catch(e){console.error('Telegram bot error:',e.message)}
});
async function setupTelegram(){
  if(!TELEGRAM_BOT_TOKEN)return;
  try{
    await tg('setWebhook',{url:TELEGRAM_WEBHOOK_URL,secret_token:TELEGRAM_WEBHOOK_SECRET||undefined,drop_pending_updates:false});
    console.log('EKOOOL Telegram bot webhook configured');
  }catch(e){console.error('Telegram webhook setup failed:',e.message)}
}

app.get('/api/health',async(req,res)=>{
  try{
    const users=(await getCollection('users')).length;
    res.json({ok:true,service:'EKOOOL server',storage:usePg?'postgresql':'json',users});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.use(express.static(__dirname,{index:'index.html'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

initDb().then(()=>{
  app.listen(PORT,'0.0.0.0',async()=>{console.log('EKOOOL server listening on '+PORT+' | storage: '+(usePg?'PostgreSQL':'JSON'));await setupTelegram();});
}).catch(e=>{
  console.error('EKOOOL database init failed:',e);
  process.exit(1);
});
