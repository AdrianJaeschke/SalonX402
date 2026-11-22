import { verifyMessage } from 'viem';
import { NETWORK, PAY_TO, SIZE, update } from './_register.js';
import { Fehler, wallet } from './_werke.js';

export async function rate({wallet:address,x,y,score,ts,signature}) {
  const voter=wallet(address);
  if(!voter || voter===PAY_TO.toLowerCase() || ![x,y,score,ts].every(Number.isSafeInteger) || Math.min(x,y)<0 || Math.max(x,y)>=SIZE || score<1 || score>5 || Math.abs(Date.now()-ts)>300000) throw new Fehler('Invalid market rating');
  const message=JSON.stringify(['SalonX402/rate',NETWORK,voter,x,y,score,ts]);
  if(!await verifyMessage({address:voter,message,signature}).catch(()=>false)) throw new Fehler('Invalid rating signature',401);
  return update(data=>{
    const cell=data.sales.find(s=>s.x===x && s.y===y);
    if(!cell?.wk) throw new Fehler('Choose a published work',404);
    const work=data.werke.find(w=>w.id===cell.wk);
    if(!work || work.aus) throw new Fehler('Work unavailable',404);
    work.votes||={};
    const previous=work.votes[voter];
    if(previous && previous.ts>=ts) return {abort:true,score:previous.score};
    work.votes[voter]={score,ts};
    const votes=Object.values(work.votes);
    work.rating=votes.reduce((sum,v)=>sum+v.score,0)/votes.length;
    return {rating:work.rating,count:votes.length};
  });
}