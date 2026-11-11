// Builds iot.xid.network into dist/:
//
//   dist/index.html         landing/index.html (the story)
//   dist/thesis/index.html  thesis/index.html (the long-form thesis)
//   dist/docs/index.html    docs/docs.md rendered into docs/template.html, with a
//                           contents sidebar made from its headings
//   dist/404.html, dist/_headers
//
// The three pages are written as claude.ai artifacts: no <!doctype>/<head>/<body>,
// and links to each other as artifact URLs. Published to the site, each gets a full
// document, its own title and description, and site paths for those links.
//
// usage: npm run build      (then npm run deploy, see README.md)

import fs from 'fs'
import path from 'path'
import { marked } from 'marked'

const here = path.dirname(new URL(import.meta.url).pathname)
const dist = path.join(here, 'dist')
const ORIGIN = 'https://iot.xid.network'
// the artifacts these pages are also published as, and where each lives on the site
const PAGES = {
  'https://claude.ai/artifact/4rr2BAA3RL1dSj6jmCTdxn': '/',
  'https://claude.ai/artifact/Ks9DyraptN84Vk68gqApZK': '/docs/',
  'https://claude.ai/artifact/N1NXx49MrVeJV8tiAe46WB': '/thesis/'
}
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='12' fill='none' stroke='%232f54ff' stroke-width='5'/%3E%3Ccircle cx='16' cy='16' r='5' fill='%232f54ff'/%3E%3C/svg%3E"

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8')
const write = (f, s) => {
  fs.mkdirSync(path.dirname(path.join(dist, f)), { recursive: true })
  fs.writeFileSync(path.join(dist, f), s)
}

// ---- the docs: markdown -> HTML, headings -> sidebar ----------------------------

function renderDocs () {
  const toc = []
  const used = new Set()
  const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const r = new marked.Renderer()
  r.heading = (text, level, raw) => {
    let id
    const m = raw.match(/\s*\{#([a-z0-9-]+)\}\s*$/) // "## Title {#id}" sets the id
    if (m) { id = m[1]; raw = raw.slice(0, m.index); text = text.replace(/\s*\{#[a-z0-9-]+\}\s*$/, '') } else id = slug(raw)
    while (used.has(id)) id += '-x'
    used.add(id)
    if (level === 2 || level === 3) toc.push({ level, id, text: raw.replace(/`/g, '') })
    if (level === 1) return `<h1 id="${id}">${text}</h1>\n`
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${level}>\n`
  }
  // ![caption](img:name) -> docs/img/name.png, embedded
  r.image = (href, title, text) => {
    if (href && href.startsWith('img:')) {
      const b64 = fs.readFileSync(path.join(here, 'docs', 'img', href.slice(4) + '.png')).toString('base64')
      return `<figure class="fig"><img src="data:image/png;base64,${b64}" alt="${esc(text)}" loading="lazy"><figcaption>${esc(text)}</figcaption></figure>`
    }
    return `<img src="${href}" alt="${esc(text)}">`
  }
  r.code = (code, lang) => {
    const l = (lang || '').trim()
    const label = { bash: 'Terminal', text: 'Output', c: 'C' }[l] || l || 'Code'
    return `<div class="code ${l === 'text' ? 'out' : ''}"><div class="code-bar"><span>${label}</span>${l === 'text' ? '' : '<button type="button" class="copy">Copy</button>'}</div><pre><code>${esc(code)}</code></pre></div>\n`
  }
  r.table = (header, body) => `<div class="table"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`
  r.link = (href, title, text) => `<a href="${href}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`
  marked.use({ renderer: r, gfm: true })
  const body = marked.parse(read('docs/docs.md'))

  let nav = ''
  toc.forEach((t, i) => {
    if (t.level !== 2) return
    const kids = []
    for (let j = i + 1; j < toc.length && toc[j].level === 3; j++) kids.push(toc[j])
    nav += `<li><a href="#${t.id}" class="l2">${esc(t.text)}</a>`
    if (kids.length) nav += `<ul>${kids.map((k) => `<li><a href="#${k.id}" class="l3">${esc(k.text.replace(/^\d+\.\s*/, ''))}</a></li>`).join('')}</ul>`
    nav += '</li>'
  })
  return { html: read('docs/template.html').replace('<!--NAV-->', nav).replace('<!--BODY-->', body), toc }
}

// ---- artifact page -> standalone page ----------------------------------------------

function standalone (html, { title, description, sitePath }) {
  html = html.replace(/<title>[\s\S]*?<\/title>\s*/, '').replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
  // links between the pages: artifact URL -> site path, same tab
  for (const [url, p] of Object.entries(PAGES)) {
    const u = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    html = html.replace(new RegExp(u + '(#[a-z0-9-]+)?"\\s+target="_blank"\\s+rel="noopener"', 'g'), (_, hash) => p + (hash || '') + '"')
    html = html.split(url).join(p)
  }
  // fonts and styles go in <head>; the rest is the body
  const cut = html.search(/<(header|div|section|main)\b/)
  const head = html.slice(0, cut).trim()
  const body = html.slice(cut).trim()
  const url = ORIGIN + sitePath
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="${ICON}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<style>
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
html, body { margin: 0; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
${head}
</head>
<body>
${body}
</body>
</html>
`
}

// ---- build ----------------------------------------------------------------------

fs.rmSync(dist, { recursive: true, force: true })
const docs = renderDocs()
fs.writeFileSync(path.join(here, 'docs', 'index.html'), docs.html) // the docs artifact's file

write('index.html', standalone(read('landing/index.html'), {
  title: 'xid network: data that proves itself',
  description: 'An open network for connected devices. Every reading is signed where it is made, checked by independent nodes, and paid for only when they agree.',
  sitePath: '/'
}))
// the film and its poster (landing/media/, see README.md for how the mp4 is made)
const media = path.join(here, 'landing', 'media')
for (const f of ['xid-intro.mp4', 'xid-intro-poster.jpg']) {
  if (!fs.existsSync(path.join(media, f))) {
    console.error(`missing landing/media/${f}: see "The film" in README.md`)
    process.exit(1)
  }
}
fs.cpSync(media, path.join(dist, 'media'), { recursive: true })
write('thesis/index.html', standalone(read('thesis/index.html'), {
  title: 'The xid thesis: every machine will become a witness',
  description: 'Why checkable machine data is the next layer of trust infrastructure, the five principles behind xid network, and the road to a network that outlives its makers.',
  sitePath: '/thesis/'
}))
write('docs/index.html', standalone(docs.html, {
  title: 'xid network docs',
  description: 'Quick Start and guides for device makers, node operators and apps on xid network, with the protocol reference.',
  sitePath: '/docs/'
}))
write('404.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · xid network</title><link rel="icon" href="${ICON}">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1026;color:#f4f4f8;font:17px/1.6 Manrope,Helvetica,Arial,sans-serif;text-align:center;padding:24px}a{color:#8ea3ff}h1{font-size:44px;margin:0 0 8px}</style>
</head><body><div><h1>Nothing here</h1><p>That page does not exist. Try the <a href="/">home page</a> or the <a href="/docs/">docs</a>.</p></div></body></html>
`)
// the release files (tools/release/release.sh https://iot.xid.network/dl/node puts
// them in the repository's dist/): firmware, node tarballs, checksums
const release = path.join(here, '..', 'dist')
if (fs.existsSync(path.join(release, 'SHA256SUMS'))) {
  for (const d of ['firmware', 'node']) fs.cpSync(path.join(release, d), path.join(dist, 'dl', d), { recursive: true })
  fs.copyFileSync(path.join(release, 'SHA256SUMS'), path.join(dist, 'dl', 'SHA256SUMS'))
} else {
  console.error('no release in ../dist: run tools/release/release.sh https://iot.xid.network/dl/node first (the docs link to /dl/)')
}
// the public testnet: chain, contracts, network name, verifiers and nodes
// (boat-node init --testnet reads it), and its live page
fs.copyFileSync(path.join(here, 'testnet.json'), path.join(dist, 'testnet.json'))
fs.cpSync(path.join(here, 'network'), path.join(dist, 'network'), { recursive: true })
// /dl/ and /testnet.json are fetched from other pages too (the browser
// installer on the docs artifact reads the manifests and images): open to any origin
write('_headers', '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n/dl/*\n  Access-Control-Allow-Origin: *\n/testnet.json\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=300\n')

// checks: no artifact links left, every in-page link of the docs has its target
const pages = ['index.html', 'thesis/index.html', 'docs/index.html']
const left = pages.filter((f) => Object.keys(PAGES).some((u) => fs.readFileSync(path.join(dist, f), 'utf8').includes(u)))
const d = fs.readFileSync(path.join(dist, 'docs/index.html'), 'utf8')
const broken = [...new Set([...d.matchAll(/href="#([a-z0-9-]+)"/g)].map((m) => m[1]))].filter((id) => !d.includes(`id="${id}"`))
for (const f of pages) console.log(`dist/${f}: ${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)} KB`)
console.log(`docs: ${docs.toc.filter((t) => t.level === 2).length} chapters, ${docs.toc.filter((t) => t.level === 3).length} sections`)
if (left.length || broken.length) {
  console.error('artifact links left in:', left, '| docs links without a target:', broken)
  process.exit(1)
}
