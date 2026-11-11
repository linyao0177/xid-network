// Serves /media/* (the landing page's film) with byte ranges, and /api/* for
// the public testnet (api.js).
//
// Workers static assets answer a Range request with the whole file (200). Safari,
// and every browser on iOS, needs 206 partial responses to play a video, and other
// browsers need them to seek ahead. This worker runs only for /media/* (see
// run_worker_first in wrangler.jsonc): it reads the asset and returns the part asked
// for. Everything else is served by static assets without it.

import { api } from './api.js'

export default {
  async fetch (request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return api(request, env)
    const asset = await env.ASSETS.fetch(request.url, { method: 'GET' })
    if (!asset.ok) return asset
    const headers = new Headers(asset.headers)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', 'public, max-age=86400')

    const range = request.headers.get('Range')
    if (request.method === 'HEAD' || !range) {
      return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers })
    }

    const body = await asset.arrayBuffer()
    const size = body.byteLength
    // bytes=start-end | bytes=start- | bytes=-suffix (one range; that is what players send)
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    let start, end
    if (m && m[1] !== '') {
      start = Number(m[1])
      end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1
    } else if (m && m[2] !== '') {
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    }
    if (start === undefined || start > end || start >= size) {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(body.slice(start, end + 1), { status: 206, headers })
  }
}
