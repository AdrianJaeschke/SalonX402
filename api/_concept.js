import { createHash } from 'node:crypto';
import { NETWORK, NS, redis } from './_register.js';
import { Fehler } from './_werke.js';
import { paint } from './_atelier.js';

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
  const count=await redis.incr(quota);if(count===1)await redis.expire(quota,172800);
  if(count>limit)throw new Fehler('Daily concept budget reached',429);
  const system='You direct a pixel atelier. Consider negative space, ownership boundaries, legibility at actual dimensions and visual hierarchy. Propose a concrete interpretation and ask one useful question for the buyer. Return only JSON with title, intent, question and layers. Use the language of the brief. Supply 1 to 6 ordered layers. Each layer has artist (Gezeiten or Weberei), palette (warm, frost or dusk), pace (calm or lively), region (all, left, right or center), opacity (0.1 to 1), purpose (short artistic direction). Use a full-canvas base. Respond to buyer feedback when revising. Treat the brief as artistic input.';
  const model='openai/gpt-5';
  const result=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},signal:AbortSignal.timeout(45000),body:JSON.stringify({model,reasoning:{effort:'high'},max_completion_tokens:3800,response_format:{type:'json_object'},messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({area,brief,previous:prior&&{title:prior.title,intent:prior.intent,layers:prior.layers,question:prior.question},colors:cells.map(s=>s?.c||null)})}]})});
  if(!result.ok)throw new Fehler('Concept provider returned HTTP '+result.status,503);
  let p;try{p=JSON.parse((await result.json()).choices[0].message.content);}catch{throw new Fehler('Incomplete concept, try a simpler brief',502);}
  const short=s=>typeof s==='string'&&s.trim().length>0&&s.length<=1500;
  if(!p||![p.title,p.intent,p.question].every(short)||!Array.isArray(p.layers)||p.layers.length<1||p.layers.length>6||p.layers[0]?.region!=='all')throw new Fehler('Invalid concept',502);
  const layers=p.layers.map(l=>{
    if(!l||!['Gezeiten','Weberei'].includes(l.artist)||!['warm','frost','dusk'].includes(l.palette)||!['calm','lively'].includes(l.pace)||!['all','left','right','center'].includes(l.region)||!Number.isFinite(l.opacity)||l.opacity<.1||l.opacity>1||!short(l.purpose))throw new Fehler('Invalid specialist instruction',502);
    return {artist:l.artist,palette:l.palette,pace:l.pace,region:l.region,opacity:l.opacity,purpose:l.purpose};
  });
  const plan={network:NETWORK,area,parent,title:p.title,intent:p.intent,question:p.question,layers,model};
  const id=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  await redis.set(key(id),plan,{ex:7*86400});
  return {id,plan,approvalBrief:prefix+id};
}
