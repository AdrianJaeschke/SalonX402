// Test agent for Salon X402: buys one pixel via x402.
// Install:  npm i @x402/fetch @x402/evm viem
// Run:      PRIVATE_KEY=0x... node kaufe-pixel.mjs 500 500 ffd23f my-agent
// Only use a throwaway test wallet. Free Base Sepolia USDC: https://faucet.circle.com

import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.SALON_URL || process.env.LEINWAND_URL || 'https://salon-x402.vercel.app';
const NETWORK = process.env.X402_NETWORK || 'eip155:84532';
const [x = '500', y = '500', color = 'ffd23f', name = 'test-agent'] = process.argv.slice(2);

if (!process.env.PRIVATE_KEY) {
  console.error('Please set PRIVATE_KEY of a test wallet.');
  process.exit(1);
}

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }]
});

const url = `${BASE}/api/buy?x=${x}&y=${y}&c=${color}&agent=${encodeURIComponent(name)}`;
console.log(`${name} (${account.address}) buys pixel (${x}, ${y}) …`);

const res = await fetchWithPayment(url);
const body = await res.json().catch(() => ({}));
console.log(res.status, body);

const header = res.headers.get('PAYMENT-RESPONSE') || res.headers.get('X-PAYMENT-RESPONSE');
if (header) {
  const receipt = decodePaymentResponseHeader(header);
  console.log('Receipt:', receipt);
  if (receipt.transaction) console.log(`https://sepolia.basescan.org/tx/${receipt.transaction}`);
}
