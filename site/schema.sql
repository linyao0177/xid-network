-- D1 database xid-testnet (binding DB): what /api/* keeps. Apply with
--   npx wrangler d1 execute xid-testnet --remote --file schema.sql
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
-- faucet and sponsor requests, done by the hub (packages/boat-registry/examples/testnet-hub.js)
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,          -- faucet | sponsor
  target TEXT NOT NULL,        -- an address (faucet) or a device key (sponsor), lower case
  ip TEXT NOT NULL,            -- a salted hash of the client's address, for limits only
  at INTEGER NOT NULL,         -- ms
  state TEXT NOT NULL DEFAULT 'queued', -- queued | working | done | failed
  result TEXT,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS requests_target ON requests (kind, target, at);
CREATE INDEX IF NOT EXISTS requests_ip ON requests (kind, ip, at);
CREATE INDEX IF NOT EXISTS requests_state ON requests (state, id);
