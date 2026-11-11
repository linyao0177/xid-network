# iot.xid.network

The public site for xid network, the outward name of the decentralized IoT platform in this repository (`packages/boat-registry`, `packages/boat-mqtt-node`, the ESP32 components).

| Path | Source | What it is |
| --- | --- | --- |
| `/` | `landing/index.html` | The story: one reading, from signing to a paid result and a caught liar |
| `/thesis/` | `thesis/index.html` | The long-form thesis: why machine data is the next layer of trust infrastructure |
| `/docs/` | `docs/docs.md`, `docs/template.html`, `docs/img/` | Pick-your-path, Quick Start, guides for device makers, node operators and apps, reference |

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

`dist/` gets `index.html`, `thesis/index.html`, `docs/index.html`, `404.html` and `_headers`. The build fails if an artifact link is left in a page or a docs link has no target. It also writes `docs/index.html`, the docs page as published to claude.ai.

To look at it locally, serve `dist/`, for example with `python3 -m http.server 8765 --directory dist`.

## Deploy

The site is a Cloudflare Worker named `xid-iot` serving `dist/` as static assets, on the custom domain `iot.xid.network`. Static assets ignore `Range` requests, which Safari and iOS need to play a video, so `worker.js` runs for `/media/*` only and answers byte ranges (206) for the film. It lives in the Cloudflare account that owns the `xid.network` zone: **linyao01@gmail.com**.

```bash
npx wrangler login       # once, as linyao01@gmail.com
npx wrangler whoami      # check the account before deploying
npm run deploy
```

Wrangler keeps the account it last used in `.wrangler/cache/wrangler-account.json`. After logging in to another account, delete `.wrangler/`, or the deploy goes to the old account and fails with an authentication error (code 10000).

## Checks after a deploy

```bash
for p in / /thesis/ /docs/ /nope; do curl -s -o /dev/null -w "$p %{http_code}\n" https://iot.xid.network$p; done
```

Expect 200 for the three pages and 404 for `/nope`. For the film, `curl -sI -r 0-1023 https://iot.xid.network/media/xid-intro.mp4` should answer 206 with a `content-range`.
