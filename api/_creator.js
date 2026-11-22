import {paint} from './_atelier.js';
import { createHash } from 'node:crypto';
import { verifyMessage } from 'viem';
import { parseCreativeBrief } from './_briefing.js';
import { readFresh, update, PAY_TO, SIZE, NETWORK, redis, NS } from './_register.js';
import { Fehler, wallet } from './_werke.js';

const version = '2026-11-22';
function inspect(data, area, owner, joint=false) {
  const byPosition = new Map(data.sales.map(s => [s.y * SIZE + s.x,s]));
  const cells = [];
  for (let j=0;j<area.h;j++) for(let i=0;i<area.w;i++){
    const cell = byPosition.get((area.y+j)*SIZE+area.x+i);
    if (joint ? !wallet(cell?.w) : (cell ? cell.w?.toLowerCase() !== owner : owner !== PAY_TO?.toLowerCase())) throw new Fehler('Owner changed or area not owned',409);
    if (cell?.wk && data.werke?.some(work => work.id === cell.wk && work.aus)) throw new Fehler('Work under moderation',409);
    cells.push(cell);
  }
  return cells;
}
function snapshot(cells) { return JSON.stringify(cells.map(s=>s && [s.w,s.tx,s.tenure,s.wk,s.c,s.ts])); }

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
  return interpret(id,area,owner,brief);
}

async function interpret(id,area,owner,brief,joint=false) {
  const {x,y,w,h}=area;
  const data=(await readFresh()).data;
  if(data.editions?.[id]) return {edition:id};
  const cells=inspect(data,area,owner,joint), before=snapshot(cells);
  if(joint) checkReady(data,id,cells);
  if(!redis) throw new Fehler('Creator storage unavailable',503);
  if(!await redis.set(NS+'creator:'+owner,id,{nx:true,ex:60})) throw new Fehler('One interpretation per wallet per minute',429);
  const {colors,artist,version:artistVersion,seed}=paint(brief,w,h,cells);
  return update(d=>{
    if(d.editions?.[id])return {abort:true,edition:id};
    const current=inspect(d,area,owner,joint);
    if(joint) checkReady(d,id,current);
    if(snapshot(current)!==before)throw new Fehler('Canvas changed during interpretation',409);
    const now=Date.now();
    d.editions||={};
    const contributors=joint ? d.collabs[id].owners : undefined;
    d.editions[id]={contributors,...area,colors,creator:artist,artistVersion,seed,ts:now,terms:version,previous:current.map(s=>s?.wk||null)};
    current.forEach((s,k)=>{
      if(!s){s={x:x+k%w,y:y+Math.floor(k/w),agent:'salon',w:owner,ts:now,lp:10000};d.sales.push(s);}
      s.collabSale = joint ? id : null;
      s.c=colors[k];s.wk=id;
    });
    d.werke||=[]; d.werke.push({id,contributors,agent:'salon',w:joint ? '' : owner,x,y,wd:w,ht:h,art:'bild',ts:now});
    return {edition:id};
  });
}

const day = 86400000;
function stateHash(cells) { return createHash('sha256').update(snapshot(cells)).digest('hex'); }
function checkReady(data,id,cells) {
  const p=data.collabs?.[id];
  if(!p || p.expires<=Date.now() || stateHash(cells)!==p.state || !p.owners.every(w=>p.approvals.includes(w))) throw new Fehler('Missing approvals, expired proposal or changed canvas',409);
}
export async function collaborations(input={},action='list') {
  const {id,ts,signature}=input, sender=wallet(input.wallet);
  const data=(await readFresh()).data;
  if(action==='list') return Object.values(data.collabs||{}).filter(p=>p.expires>Date.now() && !data.editions?.[p.id] && (!sender || p.owners.includes(sender)));
  const existing=data.collabs?.[id];
  if(action==='render'){
    if(data.editions?.[id]?.contributors) return {edition:id};
    if(!existing) throw new Fehler('Unknown proposal',404);
    return interpret(id,existing.area,existing.proposer,existing.brief,true);
  }
  if(!sender || !Number.isSafeInteger(ts) || Math.abs(Date.now()-ts)>300000) throw new Fehler('Invalid wallet or timestamp',401);
  let message, proposal;
  if(action==='propose'){
    const {x,y,w,h}=input,area={x,y,w,h};
    if(![x,y,w,h].every(Number.isInteger)||x<0||y<0||w<1||h<1||w>32||h>32||x+w>SIZE||y+h>SIZE)throw new Fehler('Invalid area');
    let brief;try{brief=parseCreativeBrief({brief:input.brief}).brief;}catch(e){throw new Fehler(e.message);}
    const cells=inspect(data,area,sender,true), owners=[...new Set(cells.map(c=>wallet(c.w)))].sort();
    if(owners.length<2 || !owners.includes(sender))throw new Fehler('Select a shared area including your holdings',403);
    message=JSON.stringify(['SalonX402/collab/v1',NETWORK,'propose',sender,x,y,w,h,brief,ts]);
    const key=createHash('sha256').update(message).digest('hex');
    proposal={id:key,area,brief,state:stateHash(cells),owners,proposer:sender,approvals:[sender],expires:ts+day};
  }else if(action==='approve'){
    if(!existing?.owners.includes(sender)) throw new Fehler('No invitation for this wallet',403);
    message=JSON.stringify(['SalonX402/collab/v1',NETWORK,'approve',sender,id,ts]);
  }else throw new Fehler('Unknown action');
  if(!await verifyMessage({address:sender,message,signature}).catch(()=>false)) throw new Fehler('Invalid signature',401);
  return update(d=>{
    d.collabs||={};
    for(const [key,p] of Object.entries(d.collabs))if(p.expires<=Date.now()) delete d.collabs[key];
    const p=proposal || d.collabs[id];
    if(!p || stateHash(inspect(d,p.area,sender,true))!==p.state) throw new Fehler('Proposal expired or canvas changed',409);
    if(proposal && !d.collabs[p.id] && Object.values(d.collabs).filter(c=>c.proposer===sender).length>=10)throw new Fehler('Too many open proposals',429);
    const stored=d.collabs[p.id] ||= p;
    if(!stored.approvals.includes(sender)) stored.approvals.push(sender);
    return {proposal:stored};
  });
}

export function creatorStudy() {
  if(process.env.VERCEL_ENV!=='preview') throw new Fehler('Preview study unavailable',404);
  const size=24,brief='Two tidal currents meet at dusk. Let a warm current pass through the cold water.';
  const cells=Array.from({length:size*size},(_,k)=>k%size<size/2?{w:'west',c:'234e69'}:{w:'east',c:'de9f78'});
  const {colors}=paint(brief,size,size,cells);
  const rects=colors.map((color,i)=>'<rect x="'+i%size+'" y="'+Math.floor(i/size)+'" width="1" height="1" fill="#'+color+'"/>').join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 24 24" shape-rendering="crispEdges"><title>Gezeiten – Begegnung in der Abenddämmerung</title>'+rects+'</svg>';
}
