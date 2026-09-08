/**
 * Loopback fence tests for the /describe-image routes: non-loopback clients
 * get 403 before any handling, while loopback clients (and the trusted
 * deploy hostnames reached through the SSH tunnel) keep working.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerAttachRoute } from '../src/attach-routes.ts'

/** Capture the prefix route registration on a fake webServer. */
function capture(): Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> {
  const registrations: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
  const ctx = {
    get: (key: string) => {
      if (key === 'webServer') {
        return {
          register: (row: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
            registrations.push(row)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  registerAttachRoute(ctx as unknown as Context)
  return registrations
}

interface RequestOptions {
  method?: string
  remoteAddress?: string
  host?: string
  secFetchSite?: string
}

/** One fake request; socket + Host default to loopback. */
function makeReq(options: RequestOptions = {}): Record<string, unknown> {
  return {
    method: options.method ?? 'GET',
    url: '/describe-image/raw/sha256:unknown',
    headers: {
      host: options.host ?? '127.0.0.1:3000',
      ...(options.secFetchSite === undefined ? {} : { 'sec-fetch-site': options.secFetchSite }),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  }
}

/** One fake response collecting status/body. */
function makeRes(): { res: Record<string, unknown>; status: () => number; body: () => string } {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: unknown) => {
      if (chunk !== undefined && chunk !== null) body += String(chunk)
    },
  }
  return { res, status: () => status, body: () => body }
}

describe('/describe-image loopback fence', () => {
  it('serves loopback clients as before (unknown id still 404)', async () => {
    const [row] = capture()
    const { res, status } = makeRes()
    await row.handler(makeReq(), res)
    expect(status()).toBe(404)
  })

  it('serves a trusted deploy hostname over a loopback socket (SSH tunnel form)', async () => {
    const [row] = capture()
    const { res, status } = makeRes()
    await row.handler(makeReq({ host: 'dsh.zcj123v.online' }), res)
    expect(status()).toBe(404)
  })

  it('serves every trusted deploy hostname', async () => {
    const [row] = capture()
    for (const hostname of ['dsh.zcj123v.online', 'dsh-mac.zcj123v.online', 'dsh-n7.zcj123v.online', 'dsh-n9.zcj123v.online']) {
      const { res, status } = makeRes()
      await row.handler(makeReq({ host: hostname }), res)
      expect(status()).toBe(404)
    }
  })

  it('still 403s a trusted deploy hostname when the socket is not loopback', async () => {
    const [row] = capture()
    const { res, status, body } = makeRes()
    await row.handler(makeReq({ remoteAddress: '192.168.1.20', host: 'dsh.zcj123v.online' }), res)
    expect(status()).toBe(403)
    expect(JSON.parse(body())).toEqual({
      ok: false,
      error: { code: 'internal', message: 'forbidden: loopback-only' },
    })
  })

  it('still 403s a cross-site request with a trusted Host and loopback socket', async () => {
    const [row] = capture()
    const { res, status, body } = makeRes()
    await row.handler(makeReq({ host: 'dsh.zcj123v.online', secFetchSite: 'cross-site' }), res)
    expect(status()).toBe(403)
    expect(JSON.parse(body())).toEqual({
      ok: false,
      error: { code: 'internal', message: 'forbidden: loopback-only' },
    })
  })

  it('403s an unlisted hostname (Host check intact)', async () => {
    const [row] = capture()
    const { res, status } = makeRes()
    await row.handler(makeReq({ host: 'evil.com' }), res)
    expect(status()).toBe(403)
  })
})
