// Test-Agent für den Salon x402: kauft einen Pixel per x402.
// Installieren:  npm i @x402/fetch @x402/evm viem
// Starten:       PRIVATE_KEY=0x... node kaufe-pixel.mjs 500 500 ffd23f mein-agent
// Nur mit einer Test-Wallet benutzen. Base-Sepolia-USDC gibt es kostenlos unter https://faucet.circle.com

import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.LEINWAND_URL || 'https://salon-x402.vercel.app';
const NETWORK = process.env.X402_NETWORK || 'eip155:84532';
const [x = '500', y = '500', farbe = 'ffd23f', name = 'test-agent'] = process.argv.slice(2);

if (!process.env.PRIVATE_KEY) {
  console.error('Bitte PRIVATE_KEY einer Test-Wallet setzen.');
  process.exit(1);
}

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }]
});

const url = `${BASE}/api/buy?x=${x}&y=${y}&c=${farbe}&agent=${encodeURIComponent(name)}`;
console.log(`${name} (${account.address}) kauft Pixel (${x}, ${y}) …`);

const res = await fetchWithPayment(url);
const body = await res.json().catch(() => ({}));
console.log(res.status, body);

const header = res.headers.get('PAYMENT-RESPONSE') || res.headers.get('X-PAYMENT-RESPONSE');
if (header) {
  const receipt = decodePaymentResponseHeader(header);
  console.log('Quittung:', receipt);
  if (receipt.transaction) console.log(`https://sepolia.basescan.org/tx/${receipt.transaction}`);
}
