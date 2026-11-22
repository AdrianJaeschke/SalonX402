import { createHash } from 'node:crypto';
import { NETWORK, NS, redis } from './_register.js';
import { Fehler } from './_werke.js';
import { paint } from './_atelier.js';

import { compile, toHex } from '../public/formel.js';

const specialists = ['Iris Vale', 'Jasper Reed', 'Rowan Grey'];

function renderLayers(plan, cells) {
  const {w,h}=plan.area;
  const colors=cells.map(cell=>cell?.c || '888888');
  for(const layer of plan.layers) {
    const color=compile(layer.color), mask=compile(layer.mask);
    for(let k=0;k<colors.length;k++){
      const i=k%w, j=Math.floor(k/w);
      const coords=[(i+.5)/w,(j+.5)/h,i,j,w,h,0];
      const amount=(mask(...coords)&255)/255*layer.opacity;
      const ink=toHex(color(...coords));
      colors[k]=[0,2,4].map(offset=>{
        const base=parseInt(colors[k].slice(offset,offset+2),16);
        const target=parseInt(ink.slice(offset,offset+2),16);
        return Math.round(base+(target-base)*amount).toString(16).padStart(2,'0');
      }).join('');
    }
  }
  return colors;
}

const prefix='salon-concept:';
const key=id=>NS+'concept:v1:'+id;
export async function loadConcept(id) {
  if(!/^[a-f0-9]{64}$/.test(id)) throw new Fehler('Invalid concept id');
  const p=redis && await redis.get(key(id));
  if(!p) throw new Fehler('Concept expired or unavailable',404);
  return p;
}

export async function commissionArt(brief,area,cells) {
  if(!brief.startsWith(prefix)) return paint(brief,area.w,area.h,cells);
  const id=brief.slice(prefix.length), plan=await loadConcept(id);
  for(const k of ['x','y','w','h']) if(area[k]!==plan.area[k])throw new Fehler('Concept belongs to another area',409);
  if(plan.renderer==='formula-1')return {colors:renderLayers(plan,cells),artist:'Atelier · '+plan.title,version:'concept-2',seed:id,concept:plan};
  const colors=cells.map(s=>s?.c||'888888');
  for(const layer of plan.layers) {
    const instruction=layer.artist==='Weberei'?'weave':'tide';
    const result=paint(instruction+' '+layer.palette+' '+layer.pace+' '+id+' '+plan.layers.indexOf(layer),area.w,area.h,cells);
    for(let i=0;i<colors.length;i++){
      const x=(i%area.w+.5)/area.w, y=(Math.floor(i/area.w)+.5)/area.h;
      if(layer.region==='left'&&x>=.5 ||layer.region==='right'&&x<.5 ||layer.region==='center'&&Math.hypot(x-.5,y-.5)>.36)continue;
      colors[i]=[0,2,4].map(j=>Math.round(parseInt(colors[i].slice(j,j+2),16)*(1-layer.opacity)+parseInt(result.colors[i].slice(j,j+2),16)*layer.opacity).toString(16).padStart(2,'0')).join('');
    }
  }
  return {colors,artist:'Atelier · '+plan.title,version:'concept-1',seed:id,concept:plan};
}

export async function designConcept({area,brief,parent,owner,cells,ts}) {
  const token=process.env.CONCEPT_GATEWAY_KEY;
  if(!redis || !token)throw new Fehler('Concept Artist is not configured',503);
  const prior=parent?await loadConcept(parent):null;
  if(prior && Object.keys(area).some(k=>prior.area[k]!==area[k]))throw new Fehler('Revision area mismatch',409);
  const day=new Date().toISOString().slice(0,10);
  const limit=Number(process.env.CONCEPT_DAILY_CALLS || 10);
  if(!Number.isSafeInteger(limit)||limit<=0)throw new Fehler('Concept Artist paused',503);
  const requestId=createHash('sha256').update(JSON.stringify([owner,area,brief,parent,ts])).digest('hex');
  if(!await redis.set(key(requestId)+':requested',1,{nx:true,ex:600}))throw new Fehler('Request already received',409);
  const quota=key(day)+':calls';
  const model=process.env.CONCEPT_MODEL || 'openai/gpt-6.2-astra';
  const creatorModel=process.env.CREATOR_MODEL || 'openai/gpt-6.2-sol';
  async function ask(model,effort,system,input){
    const count=await redis.incr(quota);
    if(count===1)await redis.expire(quota,172800);
    if(count>limit)throw new Fehler('Daily concept budget reached',429);
    const result=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
      method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      signal:AbortSignal.timeout(45000),
      body:JSON.stringify({model,reasoning:{effort},max_completion_tokens:3800,response_format:{type:'json_object'},
        messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}]})
    });
    if(!result.ok)throw new Fehler('Atelier provider returned HTTP '+result.status,503);
    try{return JSON.parse((await result.json()).choices[0].message.content);}
    catch{throw new Fehler('Incomplete atelier response',502);}
  }
  const short=s=>typeof s==='string'&&s.trim().length>0&&s.length<=1500;
  const context={area,brief,colors:cells.map(s=>s?.c||null),previous:prior&&{title:prior.title,intent:prior.intent,layers:prior.layers,question:prior.question}};
  const p=await ask(model,'high',`Direct a pixel atelier. Interpret the brief and buyer feedback at the actual resolution. Return JSON with title, intent, question for the buyer and 1-6 ordered layers, each with artist (use one exact name from ${specialists.join(', ')}), purpose and numeric opacity (0.1-1). All artists can invent any technique and may recur. Give each a concrete visual task. The first layer covers the full canvas. Use the language of the brief.`,context);
  if(!p||![p.title,p.intent,p.question].every(short)||!Array.isArray(p.layers)||p.layers.length<1||p.layers.length>6)throw new Fehler('Invalid concept',502);
  const layers=p.layers.map(l=>{
    if(!l||!specialists.includes(l.artist)||!short(l.purpose)||!Number.isFinite(l.opacity)||l.opacity<.1||l.opacity>1)throw new Fehler('Invalid specialist instruction',502);
    return {artist:l.artist,purpose:l.purpose,opacity:l.opacity};
  });
  const direction=layers.map(layer=>({...layer}));
  await Promise.all([...new Set(layers.map(l=>l.artist))].map(async artist=>{
    const assigned=layers.map((l,index)=>l.artist===artist?index:-1).filter(index=>index>=0);
    const result=await ask(creatorModel,'medium','You are a Salon pixel artist. Invent techniques for your assigned layers, coordinated with the entire composition. Return JSON {layers:[{color,mask}]} in assigned order. Each expression is at most 400 characters. x,y are normalized pixel centers; i,j are integer indices. Use arithmetic, comparisons, ternaries, pi, sin, cos, abs, dist(x,y,a,b), noise(x,y), rgb(r,g,b), hsv(h,s,v), gray(v). Channels and scalar masks range from 0 to 1. Layer zero always has mask "1". No JavaScript.',{...context,artist,intent:p.intent,direction,assigned});
    if(!Array.isArray(result?.layers)||result.layers.length!==assigned.length)throw new Fehler('Incomplete creator layers',502);
    assigned.forEach((index,k)=>{
      const l=result.layers[k];
      if(typeof l?.color!=='string'||typeof l.mask!=='string')throw new Fehler('Invalid creator formula',502);
      Object.assign(layers[index],{color:l.color,mask:index===0?'1':l.mask});
    });
  }));
  const plan={network:NETWORK,area,parent,title:p.title,intent:p.intent,question:p.question,layers,model,creatorModel,renderer:'formula-1'};
  try{renderLayers(plan,cells);}catch{throw new Fehler('Invalid creator formula',502);}
  const id=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  await redis.set(key(id),plan,{ex:7*86400});
  return {id,plan,approvalBrief:prefix+id};
}
