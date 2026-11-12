# iot.xid.network

The public site for xid network, the outward name of the decentralized IoT platform in this repository (`packages/boat-registry`, `packages/boat-mqtt-node`, the ESP32 components).

| Path | Source | What it is |
| --- | --- | --- |
| `/` | `landing/index.html` | The story: one reading, from signing to a paid result and a caught liar |
| `/thesis/` | `thesis/index.html` | The long-form thesis: why machine data is the next layer of trust infrastructure |
| `/docs/` | `docs/docs.md`, `docs/template.html`, `docs/img/`, `docs/figures.mjs` | Pick-your-path, Quick Start, guides for device makers, node operators and apps, the Architecture chapter (its figures are drawn by `figures.mjs` at build time: `![caption](fig:name)` in `docs.md`), reference |
| `/network/` | `network/index.html` | The public testnet, live: nodes, devices, jobs, settlements, and the faucet and sponsor forms |
| `/depin/` | `depin/index.html` | The testnet's DePIN network (the weather demo) and its enroll form |
| `/testnet.json` | `testnet.json` | The testnet's chain, contracts, network name, verifiers and nodes (`boat-node init --testnet` reads it) |
| `/dl/` | the repository's `dist/` (`tools/release/release.sh`) | Firmware, node tarballs, `install.sh`, `SHA256SUMS` |
| `/media/*` | `landing/media/`, served by `worker.js` | The film, with byte ranges |
| `/api/*` | `api.js`, D1 (`schema.sql`) | The testnet's API: see [The testnet's API](#the-testnets-api) |

The three pages are also published as claude.ai artifacts and are written in that format: no `<!doctype>`, `<head>` or `<body>`, and links to each other as artifact URLs. `build.mjs` turns them into standalone pages and rewrites those links to site paths:

| Page | Artifact |
| --- | --- |
| Landing | https://claude.ai/artifact/4rr2BAA3RL1dSj6jmCTdxn |
| Docs | https://claude.ai/artifact/Ks9DyraptN84Vk68gqApZK |
| Thesis | https://claude.ai/artifact/N1NXx49MrVeJV8tiAe46WB |

The docs started as a Claude Docs document, [xid network Docs](https://claude.ai/artifact/XDvv2TF97UKhJ7mNTbnLQe), which people can comment on. `docs/docs.md` is the site's copy of it; a change to one is not carried to the other.

## The film

The landing page plays a two-minute introduction, `landing/media/xid-intro.mp4`, with `landing/media/xid-intro-poster.jpg` (its last frame) as the poster. The mp4 is not in git. It is made from the master file, `xid-1080p-share.mp4` (1920×1080, 26.7 MB, 2:08), so that it fits Cloudflare's 25 MiB limit per file and starts playing before it has fully loaded:

```bash
ffmpeg -i xid-1080p-share.mp4 -c:v libx264 -preset slow -crf 24 -maxrate 1300k -bufsize 2600k \
  -pix_fmt yuv420p -profile:v high -c:a aac -b:a 128k -movflags +faststart landing/media/xid-intro.mp4
ffmpeg -ss 122 -i xid-1080p-share.mp4 -frames:v 1 -vf scale=1600:-2 -q:v 3 landing/media/xid-intro-poster.jpg
```

That gives about 12.8 MB at 1080p. The build stops if either file is missing.

## Build

```bash
npm install
npm run build
```

`dist/` gets `index.html`, `thesis/index.html`, `docs/index.html`, `network/`, `depin/`, `media/`, `testnet.json`, `404.html` and `_headers`. The build fails if an artifact link is left in a page or a docs link has no target. It also writes `docs/index.html`, the docs page as published to claude.ai.

`dist/dl/` is the release: the build copies `firmware/`, `node/` and `SHA256SUMS` from the repository's `dist/`, which `tools/release/release.sh https://iot.xid.network/dl/node` makes (see `tools/release/README.md`). Without a release there, or with a file that is missing or does not match `SHA256SUMS`, `npm run build` says so and builds the pages without `/dl/`, which is enough to look at them. `npm run deploy` builds with `--release`, which stops instead, so the site is never deployed without its downloads.

To look at it locally, serve `dist/`, for example with `python3 -m http.server 8765 --directory dist`.

## Deploy

The site is a Cloudflare Worker named `xid-iot` serving `dist/` as static assets, on the custom domain `iot.xid.network`. `worker.js` runs for two paths only (`run_worker_first` in `wrangler.jsonc`). For `/media/*` it answers byte ranges (206) for the film: static assets ignore `Range` requests, which Safari and iOS need to play a video. For `/api/*` it is the testnet's API (`api.js`). It lives in the Cloudflare account that owns the `xid.network` zone: **linyao01@gmail.com**.

```bash
npx wrangler login       # once, as linyao01@gmail.com
npx wrangler whoami      # check the account before deploying
npm run deploy           # node build.mjs --release && wrangler deploy
```

The first deploy to an account, and any deploy after `schema.sql` changed, needs the database and the secrets first: see below.

Wrangler keeps the account it last used in `.wrangler/cache/wrangler-account.json`. After logging in to another account, delete `.wrangler/`, or the deploy goes to the old account and fails with an authentication error (code 10000).

## Checks after a deploy

```bash
for p in / /thesis/ /docs/ /nope; do curl -s -o /dev/null -w "$p %{http_code}\n" https://iot.xid.network$p; done
```

Expect 200 for the three pages and 404 for `/nope`. For the film, `curl -sI -r 0-1023 https://iot.xid.network/media/xid-intro.mp4` should answer 206 with a `content-range` and `content-length: 1024`. For the API, `curl -s https://iot.xid.network/api/network | head -c 200` should show a snapshot whose `at` is less than a minute old (503 `no snapshot yet` means the hub has not pushed one), and `curl -s https://iot.xid.network/dl/SHA256SUMS` should list the release.

## The testnet's API

`api.js` holds no key and pays nothing. It keeps the latest snapshot of the testnet and a queue of requests in D1; the hub (`packages/boat-registry/examples/testnet-hub.js`, `boat-testnet-hub`, on a VM) holds the faucet wallet, pushes the snapshot every 30 s, takes the queue and pays.

| Call | Who | What it does |
| --- | --- | --- |
| `GET /api/network` | anyone, any origin | The latest snapshot (cached 15 s); 503 before the first one |
| `POST /api/faucet` `{"address": "0x…"}` | anyone | Queues 1,000 TSUSD and a little Arc USDC for gas for the address |
| `POST /api/sponsor` `{"device": "<64 hex>"}` | anyone | Queues verify and store jobs on the device's readings, paid by the testnet |
| `POST /api/depin/enroll` `{"device": "<64 hex>"}` | anyone | Queues the device's enrollment in the testnet's DePIN network |
| `GET /api/request/<id>` | anyone | How a request went: `queued`, `working`, `done` or `failed`, and its result |
| `POST /api/hub/snapshot`, `/api/hub/take`, `/api/hub/done` | the hub, `Authorization: Bearer <HUB_TOKEN>` | Stores the snapshot; hands out up to 20 queued requests (again after 10 minutes without an answer); records how one went |

The three public POSTs answer 202 with `{"id", "state": "queued"}`; the id is 32 random hex digits and is the only way to read the request back. They need `Content-Type: application/json` (415 otherwise), and a request that carries an `Origin` other than the site's own is refused (403): the forms on `/network/` and `/depin/` and command-line tools (`boat-sim`, `xid-depin`, curl) work, a page on another site does not.

Limits per 24 hours, checked and counted in one SQL statement: one faucet drip per address, three per client, 100 in all; one sponsorship per device, five per client, 200 in all; one enrollment per device, 20 per client, 300 in all. Asking again for the same address or device answers 200 with the earlier request's id; over a limit answers 429. A client is an IPv4 address or an IPv6 /64, stored only as a salted hash.

### Database

D1 database `xid-testnet`, binding `DB` (`wrangler.jsonc`). `schema.sql` is the whole schema and can be applied again at any time:

```bash
npx wrangler d1 create xid-testnet        # once; put its id in wrangler.jsonc
npx wrangler d1 execute xid-testnet --remote --file schema.sql
```

A database made before the `rid` column existed needs it added once, before the Worker that writes it is deployed (the new Worker's inserts fail without it), and then `schema.sql` again for its index:

```bash
npx wrangler d1 execute xid-testnet --remote --command "ALTER TABLE requests ADD COLUMN rid TEXT"
npx wrangler d1 execute xid-testnet --remote --command "UPDATE requests SET rid = lower(hex(randomblob(16))) WHERE rid IS NULL"
npx wrangler d1 execute xid-testnet --remote --file schema.sql
```

### Secrets

```bash
npx wrangler secret put HUB_TOKEN    # the hub's bearer token: a long random string, e.g. openssl rand -hex 32
npx wrangler secret put IP_SALT      # salts the hash of a client's address, e.g. openssl rand -hex 32
```

| Secret | Without it |
| --- | --- |
| `HUB_TOKEN` | Every `/api/hub/*` call answers 401, so there is no snapshot and nothing is paid. The hub reads the same value from its `--token-file` |
| `IP_SALT` | `HUB_TOKEN` salts the hashes instead. With neither, the three public POSTs answer 503 rather than store hashes anyone could reverse |

Changing `IP_SALT` (or setting it where `HUB_TOKEN` stood in) changes every client's hash, so the limits per client start again for that day.

### The hub

```bash
boat-testnet-hub --key-file <hub wallet key> --token-file <file with HUB_TOKEN> [--state hub-state.json] [--depin <dir>]
```

It keeps two files: `--state` (the registry's events) and `<state>.requests` (what each request under way has paid so far, so a request the site hands out again is not paid twice). Keep both across restarts.
