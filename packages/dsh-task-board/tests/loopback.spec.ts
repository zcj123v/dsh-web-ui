/**
 * Loopback fence tests for the /api/task-board routes: non-loopback clients
 * get the 403 "forbidden: loopback-only" body, while loopback clients (and
 * the trusted deploy hostnames reached through the SSH tunnel) keep working.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeRoutes } from '../src/host/routes.ts'
import type { TaskBoardRoutesDeps } from '../src/host/routes.ts'

interface RequestOptions {
  method?: string
  remoteAddress?: string
  host?: string
  origin?: string
  body?: string
}

/** One fake request: loopback socket + Host by default. */
function fakeRequest(url: string, options: RequestOptions = {}): Record<string, unknown> {
  const req: Record<PropertyKey, unknown> = {
    method: options.method ?? 'GET',
    url,
    headers: {
      host: options.host ?? '127.0.0.1:3000',
      'content-type': 'application/json',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  }
  const payload = options.body
  if (payload !== undefined) {
    req[Symbol.asyncIterator] = async function* iterate() {
      yield Buffer.from(payload)
    }
  }
  return req
}

/** One fake response collecting status/headers/body. */
function fakeResponse(): {
  res: Record<string, unknown>
  status: number
  headers: Record<string, string>
  body: string
} {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res: Record<string, unknown> = {
    writeHead: (code: number, head: Record<string, string> = {}) => {
      state.status = code
      state.headers = { ...head }
    },
    end: (chunk?: unknown) => {
      if (chunk !== undefined && chunk !== null) state.body += String(chunk)
    },
  }
  return {
    res,
    get status() { return state.status },
    get headers() { return state.headers },
    get body() { return state.body },
  }
}

function deps(): TaskBoardRoutesDeps {
  return {
    store: { tasks: () => [], todos: () => [] } as unknown as TaskBoardRoutesDeps['store'],
    runner: {} as unknown as TaskBoardRoutesDeps['runner'],
  }
}

/** Find the tasks route handler. */
function tasksHandler(): (req: unknown, res: unknown) => Promise<void> {
  const routes = makeRoutes(deps())
  const row = routes.find((route) => route.path === '/api/task-board/tasks')
  if (row === undefined) throw new Error('tasks route not registered')
  return row.handler as (req: unknown, res: unknown) => Promise<void>
}

describe('/api/task-board loopback fence', () => {
  it('serves loopback clients with a loopback Host', async () => {
    const handler = tasksHandler()
    const response = fakeResponse()
    await handler(fakeRequest('/api/task-board/tasks'), response.res)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ tasks: [] })
  })

  it('serves a trusted deploy hostname over a loopback socket', async () => {
    const handler = tasksHandler()
    const response = fakeResponse()
    await handler(fakeRequest('/api/task-board/tasks', {
      host: 'dsh.zcj123v.online',
    }), response.res)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ tasks: [] })
  })

  it('serves every trusted deploy hostname with an Origin that matches the Host', async () => {
    const handler = tasksHandler()
    for (const hostname of ['dsh.zcj123v.online', 'dsh-mac.zcj123v.online', 'dsh-n7.zcj123v.online', 'dsh-n9.zcj123v.online']) {
      const response = fakeResponse()
      await handler(fakeRequest('/api/task-board/tasks', {
        host: hostname,
        origin: `https://${hostname}`,
      }), response.res)
      expect(response.status).toBe(200)
    }
  })

  it('still 403s a trusted deploy hostname when the socket is not loopback', async () => {
    const handler = tasksHandler()
    const response = fakeResponse()
    await handler(fakeRequest('/api/task-board/tasks', {
      remoteAddress: '192.168.110.50',
      host: 'dsh.zcj123v.online',
    }), response.res)
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden: loopback-only' })
  })

  it('still 403s a cross-site request even with a trusted Host and loopback socket', async () => {
    const handler = tasksHandler()
    const response = fakeResponse()
    const req = fakeRequest('/api/task-board/tasks', {
      host: 'dsh.zcj123v.online',
      origin: 'https://evil.example',
    })
    ;(req.headers as Record<string, string>)['sec-fetch-site'] = 'cross-site'
    await handler(req, response.res)
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden: loopback-only' })
  })

  it('403s an unlisted hostname (Host check intact)', async () => {
    const handler = tasksHandler()
    const response = fakeResponse()
    await handler(fakeRequest('/api/task-board/tasks', {
      host: 'evil.com',
    }), response.res)
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden: loopback-only' })
  })
})
