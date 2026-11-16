type Task = { id: string; title: string; date: string; priority: 'high'|'normal'|'low'; done: boolean };
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
async function digest(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,'0')).join('')}
function validTask(t:any):t is Task{return t&&typeof t.id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(t.id)&&typeof t.title==='string'&&t.title.trim().length>0&&t.title.length<=200&&typeof t.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(t.date)&&!Number.isNaN(Date.parse(t.date))&&['normal','high','low'].includes(t.priority)&&typeof t.done==='boolean'}
export async function handleLists(req:Request,db:D1Database):Promise<Response>{
 try{
  if(!db)return reply({error:'Shared lists are temporarily unavailable.'},503);
  if(req.method!=='GET'&&req.method!=='POST')return reply({error:'Method not allowed.'},405);
  const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return reply({error:'Request not allowed.'},403);
  if(req.method==='POST'&&!req.headers.get('content-type')?.includes('application/json'))return reply({error:'JSON required.'},415);
  let body:any={};if(req.method==='POST'){const raw=await req.text();if(raw.length>400000)return reply({error:'List too large.'},413);try{body=JSON.parse(raw)}catch{return reply({error:'Invalid request.'},400)}}
  const ip=req.headers.get('cf-connecting-ip')||'local';const now=Date.now();const create=req.method==='POST'&&body.action==='create';
  const window=create?86400000:60000;const bucket=await digest(`${ip}:${Math.floor(now/window)}:${create?'create':'access'}`);
  const quota=await db.prepare('INSERT INTO limits(bucket,count,expires) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(bucket,now+window).first<{count:number}>();
  if((quota?.count||0)>(create?20:180))return reply({error:'Too many requests. Please try again later.'},429);
  if(create){
   if(!Array.isArray(body.tasks)||body.tasks.length>1000||!body.tasks.every(validTask)||new Set(body.tasks.map((t:Task)=>t.id)).size!==body.tasks.length)return reply({error:'Invalid tasks or too many tasks (maximum 1,000).'},400);
   const bytes=crypto.getRandomValues(new Uint8Array(20));const code=Array.from(bytes,x=>alphabet[x%32]).join('');const hash=await digest(code);
   await db.prepare('INSERT INTO lists(code_hash,tasks,version) VALUES (?,?,0)').bind(hash,JSON.stringify(body.tasks)).run();
   await db.prepare('DELETE FROM limits WHERE expires < ?').bind(now).run();
   return reply({code:code.match(/.{4}/g)!.join('-'),tasks:body.tasks,version:0},201);
  }
  const code=(req.headers.get('x-list-code')||'').toUpperCase().replace(/[\s-]/g,'');
  if(!/^[A-HJ-NP-Z2-9]{20}$/.test(code))return reply({error:'Enter the complete 20-character list code.'},400);
  const hash=await digest(code);
  for(let attempt=0;attempt<5;attempt++){
   const row=await db.prepare('SELECT tasks,version FROM lists WHERE code_hash=?').bind(hash).first<{tasks:string;version:number}>();
   if(!row)return reply({error:'No list found. Check the code and try again.'},404);
   let tasks:Task[]=JSON.parse(row.tasks);
   if(req.method==='GET')return reply({tasks,version:row.version});
   if(body.action==='add'){if(!validTask(body.task))return reply({error:'Invalid task.'},400);if(!tasks.some(t=>t.id===body.task.id)){if(tasks.length>=1000)return reply({error:'This list has reached 1,000 tasks.'},400);tasks.push(body.task)}}
   else if(body.action==='check'){if(typeof body.id!=='string'||typeof body.done!=='boolean')return reply({error:'Invalid update.'},400);tasks=tasks.map(t=>t.id===body.id?{...t,done:body.done}:t)}
   else if(body.action==='delete'){if(typeof body.id!=='string')return reply({error:'Invalid task.'},400);tasks=tasks.filter(t=>t.id!==body.id)}
   else if(body.action==='clear'){if(!Array.isArray(body.ids)||body.ids.length>1000)return reply({error:'Invalid tasks.'},400);tasks=tasks.filter(t=>!(t.done&&body.ids.includes(t.id)))}
   else return reply({error:'Unknown action.'},400);
   const result=await db.prepare('UPDATE lists SET tasks=?,version=version+1 WHERE code_hash=? AND version=?').bind(JSON.stringify(tasks),hash,row.version).run();
   if(result.meta.changes===1)return reply({tasks,version:row.version+1});
  }
  return reply({error:'The list is busy. Please try your change again.'},409);
 }catch(e){return reply({error:'Could not reach your saved list. Please try again.'},503)}
}

// Cloudflare Pages Function entrypoint: serves /api/lists with the D1 binding.
export async function onRequest(context: any) {
  return handleLists(context.request, context.env.DB);
}
