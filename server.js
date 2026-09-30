const express=require('express');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {Pool}=require('pg');

const app=express();
const PORT=process.env.PORT||10000;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'EKOOOL-ADMIN-2026';

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
function isAdmin(req){return (req.headers.authorization||'')==='Bearer '+adminToken()}

app.use(express.json({limit:'12mb'}));
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET,PUT,PATCH,DELETE,POST,OPTIONS');
  if(req.method==='OPTIONS')return res.sendStatus(204);
  next();
});

app.post('/api/admin/login',(req,res)=>{
  if(String(req.body?.password||'')!==ADMIN_PASSWORD)return res.status(401).json({error:'Неверный пароль'});
  res.json({token:adminToken()});
});
app.get('/api/admin/check',(req,res)=>isAdmin(req)?res.json({ok:true}):res.status(401).json({error:'Unauthorized'}));

app.get('/api/doc/:collection/:id',async(req,res)=>{
  try{res.json({data:await getDoc(req.params.collection,req.params.id)})}
  catch(e){res.status(500).json({error:e.message})}
});
app.put('/api/doc/:collection/:id',async(req,res)=>{
  try{await putDoc(req.params.collection,req.params.id,req.body||{});res.json({ok:true})}
  catch(e){res.status(500).json({error:e.message})}
});
app.patch('/api/doc/:collection/:id',async(req,res)=>{
  try{await patchDoc(req.params.collection,req.params.id,req.body||{});res.json({ok:true})}
  catch(e){res.status(500).json({error:e.message})}
});
app.delete('/api/doc/:collection/:id',async(req,res)=>{
  try{await deleteDoc(req.params.collection,req.params.id);res.json({ok:true})}
  catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/collection/:collection',async(req,res)=>{
  try{
    let docs=await getCollection(req.params.collection);
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
    res.json({docs});
  }catch(e){res.status(500).json({error:e.message})}
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
  app.listen(PORT,'0.0.0.0',()=>console.log('EKOOOL server listening on '+PORT+' | storage: '+(usePg?'PostgreSQL':'JSON')));
}).catch(e=>{
  console.error('EKOOOL database init failed:',e);
  process.exit(1);
});
