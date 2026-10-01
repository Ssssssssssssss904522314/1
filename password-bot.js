const express=require('express');
const crypto=require('crypto');
const {Pool}=require('pg');

const app=express();
const PORT=Number(process.env.PORT||10000);
const BOT_TOKEN=String(process.env.TELEGRAM_PASSWORD_BOT_TOKEN||'').trim();
const WEBHOOK_SECRET=String(process.env.TELEGRAM_PASSWORD_BOT_WEBHOOK_SECRET||'').trim();
const WEBHOOK_URL=String(process.env.TELEGRAM_PASSWORD_BOT_WEBHOOK_URL||'').trim();
const PUBLIC_URL=String(process.env.EKOOOL_PUBLIC_URL||'https://ekool-site.onrender.com').replace(/\/$/,'');
const DATABASE_URL=String(process.env.DATABASE_URL||'').trim();
const GROQ_API_KEY=String(process.env.GROQ_API_KEY||'').trim();
const GROQ_MODEL=String(process.env.GROQ_MODEL||'openai/gpt-oss-20b').trim();
const TTL=10*60*1000;

if(!BOT_TOKEN)throw new Error('TELEGRAM_PASSWORD_BOT_TOKEN is not configured');
if(!DATABASE_URL)throw new Error('DATABASE_URL is not configured');
if(!GROQ_API_KEY)throw new Error('GROQ_API_KEY is not configured');

const pool=new Pool({connectionString:DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined,max:5});
async function initDb(){await pool.query('CREATE TABLE IF NOT EXISTS ekoool_kv(collection TEXT NOT NULL,id TEXT NOT NULL,data JSONB NOT NULL,PRIMARY KEY(collection,id))')}
async function getDoc(c,id){const r=await pool.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2',[c,String(id)]);return r.rows[0]?.data??null}
async function putDoc(c,id,data){await pool.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3) ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data',[c,String(id),JSON.stringify(data||{})])}
async function deleteDoc(c,id){await pool.query('DELETE FROM ekoool_kv WHERE collection=$1 AND id=$2',[c,String(id)])}
async function patchDoc(c,id,p){const old=await getDoc(c,id);await putDoc(c,id,{...(old||{}),...(p||{})})}
async function tg(method,body){const r=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});const x=await r.json().catch(()=>({}));if(!r.ok||!x.ok)throw new Error(x?.description||'Telegram API error');return x.result}
async function classify(text){
 const raw=String(text||'').trim();if(!raw)return{intent:'other',confidence:1};
 const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+GROQ_API_KEY},body:JSON.stringify({model:GROQ_MODEL,temperature:0,max_tokens:80,messages:[
  {role:'system',content:'Ты ИИ-классификатор Telegram-бота EKOOOL. Определи, просит ли человек восстановить пароль своего аккаунта EKOOOL, потому что забыл/не помнит пароль, потерял доступ или не может войти. Понимай смысл, разговорные фразы, опечатки и русский язык. Не реагируй только на слово «пароль», если восстановления не просят. Отвечай ТОЛЬКО JSON: {"intent":"password_reset"|"other","confidence":0..1}.'},
  {role:'user',content:raw}
 ]})});
 const x=await r.json().catch(()=>({}));if(!r.ok)throw new Error(x?.error?.message||'Groq API error');
 const m=String(x?.choices?.[0]?.message?.content||'').match(/\{[\s\S]*\}/);if(!m)return{intent:'other',confidence:0};
 try{const j=JSON.parse(m[0]);return{intent:j.intent==='password_reset'?'password_reset':'other',confidence:Math.max(0,Math.min(1,Number(j.confidence)||0))}}catch{return{intent:'other',confidence:0}}
}
function newPassword(){const a='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789',b=crypto.randomBytes(10);let o='EK';for(const x of b)o+=a[x%a.length];return o}
function hashPassword(p,s){return crypto.createHash('sha256').update(String(s)+String(p)).digest('hex')}
async function invalidateSessions(uid){const r=await pool.query('SELECT id,data FROM ekoool_kv WHERE collection=$1',['sessions']);for(const row of r.rows)if(String(row.data?.uid)===String(uid))await deleteDoc('sessions',row.id)}
async function linkTelegram(chatId,raw){
 const username=raw.replace(/^\/link\s*/i,'').replace(/^@/,'').trim().toLowerCase();
 if(!/^[a-z][a-z0-9_]{3,19}$/.test(username)){await tg('sendMessage',{chat_id:chatId,text:'Напиши так: /link @username'});return}
 const map=await getDoc('usernames',username),uid=map?.uid?String(map.uid):'';
 if(!uid){await tg('sendMessage',{chat_id:chatId,text:'❌ Такой юзернейм EKOOOL не найден.'});return}
 const token=crypto.randomBytes(24).toString('hex');
 await putDoc('telegram_link_tokens',token,{uid,chatId:String(chatId),expires:Date.now()+TTL});
 await tg('sendMessage',{chat_id:chatId,text:'🔗 Открой ссылку в браузере, где ты уже вошёл в EKOOOL:\n\n'+PUBLIC_URL+'/?telegram_link='+token+'\n\nПосле открытия Telegram будет привязан к @'+username+'. Ссылка действует 10 минут.'});
}
async function startRecovery(chatId){
 await putDoc('telegram_password_recovery',String(chatId),{step:'username',expires:Date.now()+TTL});
 await tg('sendMessage',{chat_id:chatId,text:'🔐 Восстановление пароля EKOOOL\n\nНазови свой юзернейм EKOOOL, например @username.\n\nДля безопасности Telegram должен быть заранее привязан к этому аккаунту.\nЕсли ещё не привязан: /link @username\n\nДля отмены: «отмена».'});
}
async function recover(chatId,text){
 const st=await getDoc('telegram_password_recovery',String(chatId));
 if(!st||st.expires<Date.now()){await deleteDoc('telegram_password_recovery',String(chatId));return false}
 const raw=String(text||'').trim(),low=raw.toLowerCase();
 if(['отмена','cancel'].includes(low)){await deleteDoc('telegram_password_recovery',String(chatId));await tg('sendMessage',{chat_id:chatId,text:'✅ Восстановление отменено.'});return true}
 if(st.step==='confirm'){
  if(['да','yes','ага','точно','хочу'].includes(low))await startRecovery(chatId);
  else{await deleteDoc('telegram_password_recovery',String(chatId));await tg('sendMessage',{chat_id:chatId,text:'Хорошо. Восстановление отменено.'})}
  return true;
 }
 const username=raw.replace(/^@/,'').toLowerCase();
 if(!/^[a-z][a-z0-9_]{3,19}$/.test(username)){await tg('sendMessage',{chat_id:chatId,text:'❌ Нужен юзернейм EKOOOL из английских букв, цифр и _.'});return true}
 const map=await getDoc('usernames',username),uid=map?.uid?String(map.uid):'';
 if(!uid){await tg('sendMessage',{chat_id:chatId,text:'❌ Такой юзернейм EKOOOL не найден.'});return true}
 const user=await getDoc('users',uid);
 if(!user||String(user.telegramChatId||'')!==String(chatId)){
  await deleteDoc('telegram_password_recovery',String(chatId));
  await tg('sendMessage',{chat_id:chatId,text:'🔒 Этот Telegram не привязан к @'+username+'.\n\nСначала выполни /link @'+username+', открой полученную ссылку в браузере с авторизацией EKOOOL, затем снова напиши «забыл пароль».'});
  return true;
 }
 const password=newPassword(),salt=crypto.randomBytes(8).toString('hex');
 await patchDoc('users',uid,{salt,passHash:hashPassword(password,salt),lastSeen:Date.now()});
 await invalidateSessions(uid);
 await deleteDoc('telegram_password_recovery',String(chatId));
 await tg('sendMessage',{chat_id:chatId,text:'✅ Пароль EKOOOL изменён!\n\n👤 @'+username+'\n🔐 Новый пароль: '+password+'\n\nТеперь войди в EKOOOL. Никому не передавай пароль.'});
 return true;
}
app.use(express.json());
app.get('/api/health',(req,res)=>res.json({ok:true,service:'EKOOOL password bot'}));
app.post('/api/telegram/password-webhook',async(req,res)=>{
 if(WEBHOOK_SECRET&&req.get('x-telegram-bot-api-secret-token')!==WEBHOOK_SECRET)return res.sendStatus(401);
 res.sendStatus(200);
 try{
  const msg=req.body?.message;if(!msg?.chat?.id)return;
  const chatId=msg.chat.id,raw=String(msg.text||'').trim();
  if(/^\/link(?:\s|$)/i.test(raw)){await linkTelegram(chatId,raw);return}
  if(raw==='/start'||raw==='/help'){await tg('sendMessage',{chat_id:chatId,text:'🤖 Я ИИ-бот восстановления пароля EKOOOL.\n\nНапиши обычными словами «я не помню пароль».\nДля привязки Telegram: /link @username'});return}
  const st=await getDoc('telegram_password_recovery',String(chatId));
  if(st?.expires>Date.now()){await recover(chatId,raw);return}
  if(!raw)return;
  let intent;try{intent=await classify(raw)}catch(e){console.error('AI error:',e.message);await tg('sendMessage',{chat_id:chatId,text:'🤖 ИИ временно недоступен. Попробуй ещё раз позже.'});return}
  if(intent.intent==='password_reset'&&intent.confidence>=0.78){await startRecovery(chatId);return}
  if(intent.intent==='password_reset'&&intent.confidence>=0.48){await putDoc('telegram_password_recovery',String(chatId),{step:'confirm',expires:Date.now()+TTL});await tg('sendMessage',{chat_id:chatId,text:'🤖 Я правильно понял, что ты не помнишь пароль EKOOOL и хочешь его восстановить?\n\nОтветь «да» или «нет».'});return}
  await tg('sendMessage',{chat_id:chatId,text:'Я бот восстановления доступа EKOOOL. Напиши, например: «забыл пароль» или «не могу войти в аккаунт».'});
 }catch(e){console.error('Webhook error:',e)}
});
async function setupWebhook(){if(!WEBHOOK_URL){console.log('TELEGRAM_PASSWORD_BOT_WEBHOOK_URL is not set');return}await tg('setWebhook',{url:WEBHOOK_URL,secret_token:WEBHOOK_SECRET||undefined,drop_pending_updates:false});}
initDb().then(()=>app.listen(PORT,'0.0.0.0',async()=>{console.log('EKOOOL password bot listening on '+PORT);await setupWebhook()})).catch(e=>{console.error('Password bot startup failed:',e);process.exit(1)});
