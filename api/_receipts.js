import {createHash, createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {NETWORK, SIZE} from './_register.js';

let signer;
export function receiptKey() {
  if (signer) return signer;
  const key = createPrivateKey((process.env.RECEIPT_PRIVATE_KEY || '').replaceAll('\\n','\n'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 receipt key');
  const publicKey = createPublicKey(key).export({format:'pem',type:'spki'}).toString();
  const keyId = createHash('sha256').update(publicKey).digest('hex');
  signer = {key,publicKey,keyId};
  return signer;
}

export function createReceipt(order, previous, buyer, timestamp) {
  const {key,publicKey,keyId} = receiptKey();
  const pixels = [];
  for(let y=order.y;y<order.y+order.ht;y++) for(let x=order.x;x<order.x+order.wd;x++) {
    const old = previous.get(y*SIZE+x);
    pixels.push({x,y,previousWallet:old?.w || null,previousTenure:old?.tenure || null,
      edition:old?.wk || null,color:old?.c || '888888'});
  }
  const payload = JSON.stringify({schema:'salon-x402/transfer/v1',network:NETWORK,keyId,order:order.id,
    transferredAt:new Date(timestamp).toISOString(),buyer,terms:order.terms,termsPath:'/terms-2026-11-22.html',
    area:{x:order.x,y:order.y,w:order.wd,h:order.ht},pixels,
    payments:order.teile.map(t=>({part:t.nr,from:t.von,to:t.an,microUSDC:t.betrag,transaction:t.tx}))});
  return {payload,signature:sign(null,Buffer.from(payload,'utf8'),key).toString('base64'),publicKey,keyId};
}
