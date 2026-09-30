const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({limit:'15mb'}));
const DATA_DIR=path.join(__dirname,'data');
const DB_FILE=path.join(DATA_DIR,'db.json');
fs.mkdirSync(DATA_DIR,{recursive:true});
if(!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({},null,2));
let db=JSON.parse(fs.readFileSync(DB_FILE,'utf8')||'{}');
const sessions=new Map();
const save=()=>fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2));
const uid=()=> 'EK-'+crypto.randomBytes(6).toString('base64url').replace(/[-_]/g,'').slice(0,8).toUpperCase();
const token=()=>crypto.randomBytes(32).toString('hex');
const hash=(password,salt)=>crypto.createHash('sha256').update(String(salt)+String(password)).digest('hex');
const cleanUser=(id,u)=>{if(!u)return null; const x={id,...u}; delete x.passHash; delete x.salt; return x};
const getUser=(id)=>db.users?.[id];
const auth=(req,res,next)=>{const h=req.headers.authorization||'';const t=h.startsWith('Bearer ')?h.slice(7):'';const sid=sessions.get(t);if(!sid)return res.status(401).json({error:'unauthorized'});const u=getUser(sid);if(!u)return res.status(401).json({error:'unauthorized'});req.token=t;req.userId=sid;req.user=u;req.isAdmin=!!u.admin||u.owner===true;next()};
const ensure=(c)=>{if(!db[c])db[c]={};return db[c]};

app.get('/api/health',(_req,res)=>res.json({ok:true,name:'EKOOOL',version:'server-1'}));
app.post('/api/auth/register',(req,res)=>{
  try{const {name,username,password}=req.body||{};const un=String(username||'').trim().toLowerCase().replace(/^@/,'');
    if(!name||!password||password.length<6)return res.status(400).json({error:'Введите имя и пароль минимум 6 символов'});
    if(!/^[a-z][a-z0-9_]{3,19}$/.test(un))return res.status(400).json({error:'Юзернейм: 4–20 символов, английские буквы, цифры и _, начинается с буквы'});
    const reserved=['botregistor','iibot','botidea','admin','ekoool']; if(reserved.includes(un))return res.status(400).json({error:'Этот юзернейм зарезервирован'});
    const users=ensure('users'), usernames=ensure('usernames'); if(usernames[un])return res.status(409).json({error:'Юзернейм занят'});
    const id=uid(),salt=crypto.randomBytes(8).toString('hex');
    const u={name:String(name).trim(),photo:'',bio:'',verified:false,coins:0,username:un,extra:[],salt,passHash:hash(password,salt),lastSeen:Date.now(),ts:Date.now()};
    const adminName=String(process.env.ADMIN_USERNAME||'').toLowerCase().replace(/^@/,''); if(Object.keys(users).length===0 || (adminName&&un===adminName)){u.admin=true;u.owner=true;}
    users[id]=u;usernames[un]={uid:id};save();
    const t=token();sessions.set(t,id);res.json({token:t,user:cleanUser(id,u)});
  }catch(e){console.error(e);res.status(500).json({error:'server_error'})}
});
app.post('/api/auth/login',(req,res)=>{
  try{const {username,password}=req.body||{};const q=String(username||'').trim().toLowerCase().replace(/^@/,'');let id=q;
    if(db.usernames?.[q])id=db.usernames[q].uid; else if(/^\+?777\d{7}$/.test(q.replace(/[\s()-]/g,''))){const n=q.replace(/\D/g,'');id=db.numbers?.[n]?.uid;}
    const u=getUser(id);if(!u)return res.status(401).json({error:'Неверный юзернейм или пароль'});
    if(u.passHash!==hash(password,u.salt))return res.status(401).json({error:'Неверный юзернейм или пароль'});
    u.lastSeen=Date.now();save();const t=token();sessions.set(t,id);res.json({token:t,user:cleanUser(id,u)});
  }catch(e){console.error(e);res.status(500).json({error:'server_error'})}
});
app.post('/api/auth/logout',auth,(req,res)=>{sessions.delete(req.token);res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>res.json({user:cleanUser(req.userId,req.user),isAdmin:req.isAdmin}));
app.get('/api/auth/username/:username',(req,res)=>{const un=String(req.params.username).toLowerCase();res.json({exists:!!db.usernames?.[un]})});

app.use('/api/db',auth);
app.get('/api/db/doc/:collection/:id',(req,res)=>{const v=db[req.params.collection]?.[req.params.id]; if(!v)return res.json({exists:false});const data=req.params.collection==='users'?cleanUser(req.params.id,v):v;res.json({exists:true,id:req.params.id,data});});
app.post('/api/db/doc/:collection/:id',(req,res)=>{const c=req.params.collection,i=req.params.id;if(c==='users'&&!req.isAdmin)return res.status(403).json({error:'forbidden'});ensure(c)[i]=req.body||{};save();res.json({ok:true});});
app.patch('/api/db/doc/:collection/:id',(req,res)=>{const c=req.params.collection,i=req.params.id;if(c==='users'&&req.userId!==i&&!req.isAdmin)return res.status(403).json({error:'forbidden'});if(!ensure(c)[i])return res.status(404).json({error:'not_found'});Object.assign(ensure(c)[i],req.body||{});save();res.json({ok:true});});
app.delete('/api/db/doc/:collection/:id',(req,res)=>{const c=req.params.collection,i=req.params.id;if(db[c])delete db[c][i];save();res.json({ok:true});});
app.get('/api/db/collection/:collection',(req,res)=>{const c=req.params.collection, rows=Object.entries(db[c]||{});const wh=[];for(const [k,v] of Object.entries(req.query)){if(k.startsWith('where_'))wh.push([k.slice(6),v]);}
  const docs=rows.filter(([id,v])=>wh.every(([k,x])=>String(v?.[k])===String(x))).map(([id,v])=>({id,data:c==='users'?cleanUser(id,v):v}));res.json({docs,empty:!docs.length});
});

// Only the owner/admin can perform privileged mutations. The original UI remains responsible for showing the controls.
app.patch('/api/db/doc/users/:id',(req,res,next)=>{next()});

app.use(express.static(__dirname,{index:'EKOOOL.html'}));
const port=process.env.PORT||3000;
app.listen(port,()=>console.log(`EKOOOL server listening on ${port}`));
