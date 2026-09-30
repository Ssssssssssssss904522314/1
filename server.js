const express=require('express');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const app=express();
const PORT=process.env.PORT||10000;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'EKOOOL-ADMIN-2026';
const DATA_DIR=path.join(__dirname,'data');
const DATA_FILE=path.join(DATA_DIR,'db.json');
fs.mkdirSync(DATA_DIR,{recursive:true});
let db={};
try{db=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))||{}}catch(e){db={}};
let writeChain=Promise.resolve();
function persist(){writeChain=writeChain.then(()=>fs.promises.writeFile(DATA_FILE,JSON.stringify(db),'utf8')).catch(()=>{});return writeChain}
function col(c){return db[c]||(db[c]={})}
function adminToken(){return crypto.createHmac('sha256',ADMIN_PASSWORD).update('ekoool-admin').digest('hex')}
function isAdmin(req){return (req.headers.authorization||'')==='Bearer '+adminToken()}
app.use(express.json({limit:'12mb'}));
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET,PUT,PATCH,DELETE,POST,OPTIONS');if(req.method==='OPTIONS')return res.sendStatus(204);next()});
app.post('/api/admin/login',(req,res)=>{if(String(req.body?.password||'')!==ADMIN_PASSWORD)return res.status(401).json({error:'Неверный пароль'});res.json({token:adminToken()})});
app.get('/api/admin/check',(req,res)=>isAdmin(req)?res.json({ok:true}):res.status(401).json({error:'Unauthorized'}));
app.get('/api/doc/:collection/:id',(req,res)=>{const v=col(req.params.collection)[req.params.id];res.json({data:v??null})});
app.put('/api/doc/:collection/:id',async(req,res)=>{col(req.params.collection)[req.params.id]=req.body||{};await persist();res.json({ok:true})});
app.patch('/api/doc/:collection/:id',async(req,res)=>{const c=col(req.params.collection),id=req.params.id;c[id]={...(c[id]||{}),...(req.body||{})};await persist();res.json({ok:true})});
app.delete('/api/doc/:collection/:id',async(req,res)=>{delete col(req.params.collection)[req.params.id];await persist();res.json({ok:true})});
app.get('/api/collection/:collection',(req,res)=>{let docs=Object.entries(col(req.params.collection)).map(([id,data])=>({id,data}));let w=req.query.where;let ws=[];if(Array.isArray(w))ws=w;else if(w)ws=[w];if(ws.length){const ops=Array.isArray(req.query.op)?req.query.op:[req.query.op||'=='];const vals=Array.isArray(req.query.value)?req.query.value:[req.query.value];docs=docs.filter(d=>{for(let i=0;i<ws.length;i++){let want=vals[i];try{want=JSON.parse(want)}catch(e){}const got=d.data?.[ws[i]],op=ops[i]||'==';if(op==='=='&&got!==want)return false;if(op==='!='&&got===want)return false}return true})}res.json({docs})});
app.get('/api/health',(req,res)=>res.json({ok:true,service:'EKOOOL server',users:Object.keys(col('users')).length}));
app.use(express.static(__dirname,{index:'index.html'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log('EKOOOL server listening on '+PORT));
