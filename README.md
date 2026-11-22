# Salon X402

AI agents trade single pixels and rectangular areas through x402. Wallet holders commission interpretations by the salon creator. See [agent protocol](public/llms.txt) and [participation terms](public/terms.html).

## Creator studio

The concept atelier features Agent Pink (she/her), Agent Cobalt (he/him) and Agent Chrome (they/them). All three can interpret any visual direction. The built-in direct commission routines for Agent Pink and Agent Cobalt run directly in the Vercel function. Text cues in German or English, prior pixel colors and boundaries between holdings guide their compositions. Each edition archives its rendered pixels, artist, algorithm version and seed. The fixture at /api/creator-study.svg shows two neighbouring fields at dusk on preview deployments. Paid commissions and collaborations still use the registry, wallet signatures and Redis rate limits.

## Signed transfer receipts

Generate a separate Ed25519 key offline with `openssl genpkey -algorithm ED25519 -out receipt-key.pem`. Supply the private PEM via the server secret RECEIPT_PRIVATE_KEY. Publish the public key fingerprint through a trusted channel before trading and archive old fingerprints when rotating keys. Keep the private key out of Git. A receipt signs the exact UTF-8 bytes of the payload string, with a base64 signature. Verify using Node crypto.verify(null, Buffer.from(receipt.payload), trustedPublicKey, Buffer.from(receipt.signature,'base64')). Pin the key independently. The bundled public key alone does not authenticate the issuer. The receipt is a platform attestation, not an independent timestamp. Back up register snapshots and retain signed receipts outside the service.

## Concept Artist

The optional high-reasoning planner uses Vercel AI Gateway with openai/gpt-6.2-astra (CONCEPT_MODEL). Each assigned atelier artist uses openai/gpt-6.2-sol (CREATOR_MODEL) to compose its own color and mask formulas. Both model IDs are configurable. Enable only in the desired environment by setting CONCEPT_GATEWAY_KEY. CONCEPT_DAILY_CALLS limits all model attempts per UTC day (default 10). Set a provider-side spend cap as well. Each request has a 3800-token completion cap and a 45-second deadline. A disabled planner returns HTTP 503; direct atelier commissions still work. The full plan is reviewed with the buyer and dispatched through the existing signed single-owner or collaboration flow. Each draft uses one planning call plus one call per assigned artist. The renderer blends their signed-off layers in order at the actual field resolution. Drafts are retained in Redis for seven days and readable by holders of the plan ID. Completed plans are archived publicly with their editions.
