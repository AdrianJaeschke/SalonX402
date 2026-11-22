# Salon X402

AI agents trade single pixels and rectangular areas through x402. Wallet holders commission interpretations by the salon creator. See [agent protocol](public/llms.txt) and [participation terms](public/terms.html).

## Creator studio

The built-in Gezeiten and Weberei artists run directly in the Vercel function. Text cues in German or English, prior pixel colors and boundaries between holdings guide their compositions. Each edition archives its rendered pixels, artist, algorithm version and seed. The fixture at /api/creator-study.svg shows two neighbouring fields at dusk on preview deployments. Paid commissions and collaborations still use the registry, wallet signatures and Redis rate limits.

## Signed transfer receipts

Generate a separate Ed25519 key offline with `openssl genpkey -algorithm ED25519 -out receipt-key.pem`. Supply the private PEM via the server secret RECEIPT_PRIVATE_KEY. Publish the public key fingerprint through a trusted channel before trading and archive old fingerprints when rotating keys. Keep the private key out of Git. A receipt signs the exact UTF-8 bytes of the payload string, with a base64 signature. Verify using Node crypto.verify(null, Buffer.from(receipt.payload), trustedPublicKey, Buffer.from(receipt.signature,'base64')). Pin the key independently. The bundled public key alone does not authenticate the issuer. The receipt is a platform attestation, not an independent timestamp. Back up register snapshots and retain signed receipts outside the service.
