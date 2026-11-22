import { createHash } from 'node:crypto';
import { verifyMessage } from 'viem';
import { parseCreativeBrief } from './_briefing.js';
import { readFresh, update, PAY_TO, SIZE, NETWORK, redis, NS } from './_register.js';
import { Fehler, wallet } from './_werke.js';

const version = '2026-11-22';
function inspect(data, area, owner) {
  const byPosition = new Map(data.sales.map(s => [s.y * SIZE + s.x,s]));
  const cells = [];
  for (let j=0;j<area.h;j++) for(let i=0;i<area.w;i++){
    const cell = byPosition.get((area.y+j)*SIZE+area.x+i);
    if (cell ? cell.w?.toLowerCase() !== owner : owner !== PAY_TO?.toLowerCase()) throw new Fehler('Owner changed or area not owned',409);
    if (cell?.wk && data.werke?.some(work => work.id === cell.wk && work.aus)) throw new Fehler('Work under moderation',409);
    cells.push(cell);
  }
  return cells;
}
function snapshot(cells) { return JSON.stringify(cells.map(s=>s && [s.tx,s.tenure,s.wk,s.c,s.ts])); }

export async function commission(body) {
  const {x,y,w,h,ts,signature,terms} = body;
  const owner = wallet(body.wallet);
  if(!owner || terms !== version || ![x,y,w,h].every(Number.isInteger) || x<0 || y<0 || w<1 || h<1 || w>32 || h>32 || x+w>SIZE || y+h>SIZE) throw new Fehler('Invalid owner, terms or area');
  let brief;
  try { brief=parseCreativeBrief({brief:body.brief}).brief; } catch(e){throw new Fehler(e.message);}
  const message=JSON.stringify(['SalonX402/commission',NETWORK,version,owner,x,y,w,h,ts,brief]);
  if(!Number.isSafeInteger(ts) || Math.abs(Date.now()-ts)>300000 || !await verifyMessage({address:owner,message,signature}).catch(()=>false)) throw new Fehler('Invalid or expired signature',401);
  const id=createHash('sha256').update(message).digest('hex');
  const area={x,y,w,h};
  const data=(await readFresh()).data;
  if(data.editions?.[id]) return {edition:id};
  const cells=inspect(data,area,owner), before=snapshot(cells);
  const endpoint=process.env.CREATOR_GENERATE_URL, model=process.env.CREATOR_MODEL;
  if(!endpoint || !model || !redis) throw new Fehler('Creator service unavailable',503);
  if(!await redis.set(NS+'creator:'+owner,id,{nx:true,ex:60})) throw new Fehler('One interpretation per wallet per minute',429);
  const response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(40000), headers:{'content-type':'application/json',...(process.env.CREATOR_TOKEN?{authorization:'Bearer '+process.env.CREATOR_TOKEN}:{})},body:JSON.stringify({model,stream:false,format:'json',system:'You are the Salon pixel artist. Interpret the brief against the previous composition. Respond with JSON containing colors (four 6-digit RGB hex strings) and motif (waves, weave, or orbit).',prompt:JSON.stringify({brief,w,h,previousColors:cells.map(c=>c?.c||null)})})});
  if(!response.ok) throw new Fehler('Creator service unavailable',503);
  let art;
  try {art=JSON.parse((await response.json()).response);}catch{throw new Fehler('Creator returned invalid art',502);}
  if(!Array.isArray(art?.colors)||art.colors.length!==4||!art.colors.every(c=>typeof c==='string'&&/^[a-f0-9]{6}$/i.test(c))||!['waves','weave','orbit'].includes(art.motif))throw new Fehler('Creator returned invalid palette or motif',502);
  const colors=cells.map((_,k)=>{const i=k%w,j=Math.floor(k/w);const n=art.motif==='weave'?i+2*j:art.motif==='waves'?j+2*Math.sin(i/3):Math.hypot(i-w/2,j-h/2);return art.colors[(Math.floor(n)%4+4)%4].toLowerCase();});
  return update(d=>{
    if(d.editions?.[id])return {abort:true,edition:id};
    const current=inspect(d,area,owner);
    if(snapshot(current)!==before)throw new Fehler('Canvas changed during interpretation',409);
    const now=Date.now();
    d.editions||={};
    d.editions[id]={...area,colors,creator:model,ts:now,terms:version,previous:current.map(s=>s?.wk||null)};
    current.forEach((s,k)=>{
      if(!s){s={x:x+k%w,y:y+Math.floor(k/w),agent:'salon',w:owner,ts:now,lp:10000};d.sales.push(s);}
      s.c=colors[k];s.wk=id;
    });
    d.werke||=[]; d.werke.push({id,agent:'salon',w:owner,x,y,wd:w,ht:h,art:'bild',ts:now});
    return {edition:id};
  });
}
