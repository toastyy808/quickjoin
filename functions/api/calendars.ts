type Notes = Record<string, string[]>;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
async function digest(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,'0')).join('')}
function validNotes(n:any):n is Notes{
 if(!n||typeof n!=='object'||Array.isArray(n))return false;
 const keys=Object.keys(n);
 if(keys.length>366)return false;
 return keys.every(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)&&!Number.isNaN(Date.parse(k))&&Array.isArray(n[k])&&n[k].length<=50&&n[k].every((s:any)=>typeof s==='string'&&s.length>0&&s.length<=2000));
}
export async function handleCalendars(req:Request,db:D1Database):Promise<Response>{
 try{
  if(!db)return reply({error:'Shared calendars are temporarily unavailable.'},503);
  if(req.method!=='GET'&&req.method!=='POST')return reply({error:'Method not allowed.'},405);
  const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return reply({error:'Request not allowed.'},403);
  if(req.method==='POST'&&!req.headers.get('content-type')?.includes('application/json'))return reply({error:'JSON required.'},415);
  let body:any={};if(req.method==='POST'){const raw=await req.text();if(raw.length>400000)return reply({error:'Calendar too large.'},413);try{body=JSON.parse(raw)}catch{return reply({error:'Invalid request.'},400)}}
  const ip=req.headers.get('cf-connecting-ip')||'local';const now=Date.now();const create=req.method==='POST'&&body.action==='create';
  const window=create?86400000:60000;const bucket=await digest(`cal:${ip}:${Math.floor(now/window)}:${create?'create':'access'}`);
  const quota=await db.prepare('INSERT INTO limits(bucket,count,expires) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(bucket,now+window).first<{count:number}>();
  if((quota?.count||0)>(create?20:180))return reply({error:'Too many requests. Please try again later.'},429);
  if(create){
   if(!validNotes(body.notes))return reply({error:'Invalid notes.'},400);
   const bytes=crypto.getRandomValues(new Uint8Array(20));const code=Array.from(bytes,x=>alphabet[x%32]).join('');const hash=await digest(code);
   await db.prepare('INSERT INTO calendars(code_hash,notes,version) VALUES (?,?,0)').bind(hash,JSON.stringify(body.notes)).run();
   await db.prepare('DELETE FROM limits WHERE expires < ?').bind(now).run();
   return reply({code:code.match(/.{4}/g)!.join('-'),notes:body.notes,version:0},201);
  }
  const code=(req.headers.get('x-calendar-code')||'').toUpperCase().replace(/[\s-]/g,'');
  if(!/^[A-HJ-NP-Z2-9]{20}$/.test(code))return reply({error:'Enter the complete 20-character calendar code.'},400);
  const hash=await digest(code);
  for(let attempt=0;attempt<5;attempt++){
   const row=await db.prepare('SELECT notes,version FROM calendars WHERE code_hash=?').bind(hash).first<{notes:string;version:number}>();
   if(!row)return reply({error:'No calendar found. Check the code and try again.'},404);
   let notes:Notes=JSON.parse(row.notes);
   if(req.method==='GET')return reply({notes,version:row.version});
   if(body.action==='save'){if(!validNotes(body.notes))return reply({error:'Invalid notes.'},400);notes=body.notes}
   else return reply({error:'Unknown action.'},400);
   const result=await db.prepare('UPDATE calendars SET notes=?,version=version+1 WHERE code_hash=? AND version=?').bind(JSON.stringify(notes),hash,row.version).run();
   if(result.meta.changes===1)return reply({notes,version:row.version+1});
  }
  return reply({error:'The calendar is busy. Please try your change again.'},409);
 }catch(e){return reply({error:'Could not reach your saved calendar. Please try again.'},503)}
}

// Cloudflare Pages Function entrypoint: serves /api/calendars with the D1 binding.
export async function onRequest(context: any) {
  return handleCalendars(context.request, context.env.DB);
}
