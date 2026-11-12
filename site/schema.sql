-- D1 database xid-testnet (binding DB): what /api/* keeps. Apply with
--   npx wrangler d1 execute xid-testnet --remote --file schema.sql
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
-- faucet, sponsor and enroll requests, done by the hub (packages/boat-registry/examples/testnet-hub.js)
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- the order they came in; only the hub sees it
  rid TEXT,                    -- the id the asker gets (GET /api/request/<rid>): 32 random hex digits
  kind TEXT NOT NULL,          -- faucet | sponsor | enroll
  target TEXT NOT NULL,        -- an address (faucet) or a device key (sponsor, enroll), lower case
  ip TEXT NOT NULL,            -- a salted hash of the client's IPv4 address or IPv6 /64, for limits only
  at INTEGER NOT NULL,         -- ms
  state TEXT NOT NULL DEFAULT 'queued', -- queued | working | done | failed
  result TEXT,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS requests_target ON requests (kind, target, at);
CREATE INDEX IF NOT EXISTS requests_ip ON requests (kind, ip, at);
CREATE INDEX IF NOT EXISTS requests_state ON requests (state, id);
CREATE UNIQUE INDEX IF NOT EXISTS requests_rid ON requests (rid);
-- A database made before rid existed: run these two first, once, and BEFORE
-- deploying the Worker that writes rid (then the index above):
--   ALTER TABLE requests ADD COLUMN rid TEXT;
--   UPDATE requests SET rid = lower(hex(randomblob(16))) WHERE rid IS NULL;
