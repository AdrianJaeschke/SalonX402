// Run with Node 24: node --test test/collaboration.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {generateKeyPairSync,verify} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';

const alice=privateKeyToAccount(generatePrivateKey()), bob=privateKeyToAccount(generatePrivateKey());
const salon='0x'+'1'.repeat(40), network='eip155:84532', terms='2026-11-22';
const A=alice.address.toLowerCase(), B=bob.address.toLowerCase();
const cache=new Map();
let data={sales:[A,A,B].map((w,x)=>({w,x,y:0,c:'abcdef',p:1000000,ts:1})),werke:[]};
globalThis.salonFixture={
  read:()=>structuredClone(data), update:fn=>{const copy=structuredClone(data);const r=fn(copy);if(!r?.abort)data=copy;return r;},cache
};
const modules={
  './_register.js':`export const NETWORK='${network}',SIZE=1000,PAY_TO='${salon}',NS='',cleanAgent=String,redis={get:async k=>salonFixture.cache.get(k),set:async(k,v)=>{salonFixture.cache.set(k,v);return true},incr:async()=>1,expire:async()=>true},readCached=async()=>salonFixture.read(),readFresh=async()=>({data:salonFixture.read()}),update=async fn=>salonFixture.update(fn);`,
  '@vercel/functions':'export const getCache=()=>salonFixture.cache;',
  './_publikum.js':'export const agentKonditionen=async()=>({atomic:10000});',
  './_kasse.js':'export const buchen=async()=>{},alarm=async()=>{};',
  './_namen.js':'export const claimName=async()=>{};',
};
registerHooks({resolve(s,c,next){return c.parentURL?.includes('/api/') && Object.hasOwn(modules,s)?{url:'data:text/javascript,'+encodeURIComponent(modules[s]),shortCircuit:true}:next(s,c);}});
const {collaborations}=await import('../api/_creator.js');
const {planen,speichern,pruefen,verbuchen}=await import('../api/_werke.js');

test('joint edition, stale quotes, partial payments, transfer receipt and per-pixel fees',async()=>{
  const keys=generateKeyPairSync('ed25519');
  process.env.RECEIPT_PRIVATE_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'});
  {
    const quote=async x=>planen({x,y:0,w:1,h:1,agent:'buyer',terms});
    const stale=await quote(0);await speichern(stale);
    const ts=Date.now(), brief='A red thread connecting both fields';
    const sign=(account,fields)=>account.signMessage({message:JSON.stringify(fields)});
    const invite=await collaborations({wallet:A,x:0,y:0,w:3,h:1,brief,ts,signature:await sign(alice,['SalonX402/collab/v1',network,'propose',A,0,0,3,1,brief,ts])},'propose');
    const id=invite.proposal.id;
    await assert.rejects(collaborations({id},'render'),/approvals/);
    const approval=['SalonX402/collab/v1',network,'approve',B,id,ts];
    await assert.rejects(collaborations({id,wallet:B,ts,signature:await sign(alice,approval)},'approve'),/signature/);
    await collaborations({id,wallet:B,ts,signature:await sign(bob,approval)},'approve');
    assert.equal((await collaborations({id},'render')).edition,id);
    assert.equal(data.editions[id].creator,'Jasper Reed');
    assert.equal(data.editions[id].colors.length,3);
    await assert.rejects(pruefen(stale.id,1,true),/changed/);
    const sale=await quote(0);await speichern(sale);
    assert.deepEqual(sale.teile.map(t=>[t.an,t.betrag]),[[salon,50000],[A,950000]]);
    for(const t of sale.teile){
      await pruefen(sale.id,t.nr,true);
      await verbuchen(sale.id,t.nr,B,'0x'+String(t.nr).repeat(64));
      if(t.nr===1){assert.equal(data.sales.find(s=>s.x===0).w,A);assert.ok(!data.receipts?.[sale.id]);}
    }
    const receipt=data.receipts[sale.id];
    assert.ok(verify(null,Buffer.from(receipt.payload),keys.publicKey,Buffer.from(receipt.signature,'base64')));
    assert.equal(JSON.parse(receipt.payload).buyer,B);
    assert.equal(JSON.parse(receipt.payload).pixels[0].previousWallet,A);
    for(const [x,fee] of [[0,100000],[1,50000],[2,50000]])assert.equal((await quote(x)).teile[0].anteil.tantiemen,fee*(x===0?2:1));
  }
});

test('buyer negotiates a revision before signing specialist execution',async()=>{
  const {conceptRequest,commission}=await import('../api/_creator.js');
  const original=globalThis.fetch;
  process.env.CONCEPT_GATEWAY_KEY='fixture-only';
  let calls=0;
  globalThis.fetch=async(url,opts)=>{
    const request=JSON.parse(opts.body);

    const input=JSON.parse(request.messages[1].content);
    if(request.reasoning.effort==='medium'){
      assert.deepEqual(input.assigned,[0,1]);
      return Response.json({choices:[{message:{content:JSON.stringify({layers:[{color:'rgb(1,0,0)',mask:'1'},{color:'rgb(0,0,1)',mask:'x>=0.5'}]})}}]});
    }
    assert.equal(request.reasoning.effort,'high');
    if(calls++)assert.equal(input.previous.title,'Estuary');
    const layers=['Rowan Grey','Rowan Grey'].map(artist=>({artist,opacity:1,purpose:'Trace the seam'}));
    return Response.json({choices:[{message:{content:JSON.stringify({title:'Estuary',intent:input.brief,question:'More contrast?',layers})}}]});
  };
  try{
    const area={x:1,y:0,w:1,h:1}, ts=Date.now();
    const request=async(brief,parent=null)=>conceptRequest({...area,brief,parent,ts,wallet:A,signature:await alice.signMessage({message:JSON.stringify(['SalonX402/concept/v1',network,A,1,0,1,1,brief,parent,ts])})});
    const before=structuredClone(data.sales);
    const first=await request('Let two tides meet');
    const revised=await request('Add more contrast',first.id);
    assert.notEqual(revised.id,first.id);assert.deepEqual(data.sales,before);
    const brief=revised.approvalBrief;
    const done=await commission({...area,brief,ts,wallet:A,terms,signature:await alice.signMessage({message:JSON.stringify(['SalonX402/commission',network,terms,A,1,0,1,1,ts,brief])})});
    assert.equal(data.editions[done.edition].seed,revised.id);
    assert.equal(data.editions[done.edition].concept.layers.length,2);
    assert.deepEqual(data.editions[done.edition].colors,['0000ff']);
  }finally{globalThis.fetch=original;delete process.env.CONCEPT_GATEWAY_KEY;}
});
