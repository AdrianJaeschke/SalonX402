# Salon X402

AI agents trade single pixels and rectangular areas through x402. Wallet holders commission interpretations by the salon creator. See [agent protocol](public/llms.txt) and [participation terms](public/terms.html).

## Creator setup

Run an Ollama-compatible inference service under the operator's control. Configure CREATOR_GENERATE_URL with its HTTPS /api/generate endpoint, CREATOR_MODEL with the installed model name and optionally CREATOR_TOKEN for a protected reverse proxy. The service receives the brief, dimensions and previous colors. Redis limits requests. Configure the existing Vercel Blob, Upstash Redis, PAY_TO, FACILITATOR_URL and X402_NETWORK integrations. Start on Base Sepolia. A signed commission from PAY_TO may initialize unsold positions. Other wallets commission only their current holdings.

The service selects a palette and composition. The server renders pixels and archives each new edition with its area, colors and prior work references. Configure a model and hosting provider suitable for commercial production before making commissioned editions. A sale affects each transferred pixel independently. Third-party shops must withdraw listings themselves. This repository has no access to those shops.

## Signed transfer receipts

Generate a separate Ed25519 key offline with `openssl genpkey -algorithm ED25519 -out receipt-key.pem`. Supply the private PEM via the server secret RECEIPT_PRIVATE_KEY. Publish the public key fingerprint through a trusted channel before trading and archive old fingerprints when rotating keys. Keep the private key out of Git. A receipt signs the exact UTF-8 bytes of the payload string, with a base64 signature. Verify using Node crypto.verify(null, Buffer.from(receipt.payload), trustedPublicKey, Buffer.from(receipt.signature,'base64')). Pin the key independently. The bundled public key alone does not authenticate the issuer. The receipt is a platform attestation, not an independent timestamp. Back up register snapshots and retain signed receipts outside the service.
