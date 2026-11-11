# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**). Say what is affected, how to reproduce it and what an attacker gains. You will get an answer within a week.

Problems we especially want to hear about:

- anything that lets a node be paid for work it did not do, or avoid a slash it earned (`packages/boat-registry/contracts`, `lib/work.js`, `lib/watch.js`);
- a way to forge or replay a device's signed readings or a node's receipts (`components/boat_device`, `packages/boat-mqtt-node/lib/signed.js`, `lib/receipts.js` (and `hdht_mqtt` in hyperdht-esp32));
- reading sealed readings without a reader's key;
- the site's testnet API (`site/api.js`): draining the faucet past its limits, or reaching the hub's calls.

Problems in HyperDHT itself (the Noise handshake, SecretStream) belong to [hyperdht-esp32](https://github.com/linyao0177/hyperdht-esp32/security).

## What is in scope

This is experimental software. The contracts have not been audited, and the public testnet (Arc testnet, TSUSD test token) holds nothing of value. Testing on the public testnet is welcome; please do not degrade it for others (no floods of jobs, readings or faucet requests).

## Supported versions

Only the latest release on [iot.xid.network/docs/#download](https://iot.xid.network/docs/#download) and the `main` branch get fixes.
