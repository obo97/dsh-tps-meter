/**
 * 宿主半侧集成冒烟：用假 cordis 上下文加载插件，走通
 * 「session/event 事件 → /dsh-tps/state.json」与「widget.js 资源 + tapIndex 注入」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

function fakeCtx() {
  const routes = new Map()
  const taps = []
  const listeners = new Map()
  const cleanups = []
  const ctx = {
    logger: { warn() {} },
    on(event, fn) {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    webServer: {
      register(def) {
        routes.set(def.path, def.handler)
        return () => routes.delete(def.path)
      },
      tapIndex(fn) {
        taps.push(fn)
        return () => {
          const at = taps.indexOf(fn)
          if (at >= 0) taps.splice(at, 1)
        }
      },
    },
  }
  return { ctx, routes, taps, listeners, cleanups }
}

test('插件契约：名字与服务依赖', () => {
  assert.equal(name, 'dsh-tps-meter')
  assert.deepEqual(inject, ['webServer'])
})

test('state.json：走通事件 → 读数链路', () => {
  const { ctx, routes, listeners } = fakeCtx()
  apply(ctx)
  assert.ok(listeners.has('session/event'), '必须订阅会话事件 firehose')

  const fire = listeners.get('session/event')
  const session = { id: 'session-abc', header: { cwd: 'D:\\work\\demo-project' } }
  const t0 = Date.now()
  fire(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 })
  for (let i = 0; i < 10; i += 1) {
    fire(session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'abcd' } }, time: t0 + i * 50 })
  }

  const state = routes.get('/dsh-tps/state.json')
  assert.equal(typeof state, 'function')
  const res = fakeRes()
  state({ method: 'GET', url: '/dsh-tps/state.json' }, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /application\/json/)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0].id, 'session-abc')
  assert.equal(payload.sessions[0].dir, 'demo-project')
  assert.equal(payload.sessions[0].running, true)
  assert.ok(payload.sessions[0].tps > 0, `tps=${payload.sessions[0].tps}`)
})

test('state.json：无事件时是空列表而不是 500', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx)
  const res = fakeRes()
  routes.get('/dsh-tps/state.json')({}, res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body).sessions, [])
})

test('widget.js：可读取且是浮窗源码', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx)
  const res = fakeRes()
  routes.get('/dsh-tps/widget.js')({}, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /javascript/)
  assert.ok(res.body.includes('__dshTpsMeter'), 'widget 应带自身守卫标记')
  assert.ok(res.body.includes('/dsh-tps/state.json'), 'widget 应轮询状态端点')
})

test('tapIndex：只注入 DSH 页面，且不重复注入', () => {
  const { ctx, taps } = fakeCtx()
  apply(ctx)
  assert.equal(taps.length, 1)
  const injectInto = taps[0]

  const dshHtml = '<html><head></head><body><div id="root"></div><script>globalThis["__DSH_BOOT__"]={}</script></body></html>'
  const once = injectInto(dshHtml)
  assert.ok(once.includes('<script defer src="/dsh-tps/widget.js"></script>'))
  assert.ok(once.indexOf('</body>') > once.indexOf('/dsh-tps/widget.js'))
  assert.equal(injectInto(once), once, '已注入过就不再重复')

  const otherHtml = '<html><body>hello</body></html>'
  assert.equal(injectInto(otherHtml), otherHtml)
})

test('effect 清理：dispose 后路由与注入点都被撤掉', () => {
  const { ctx, routes, taps, cleanups } = fakeCtx()
  apply(ctx)
  assert.equal(routes.size, 2)
  assert.equal(taps.length, 1)
  for (const dispose of cleanups) dispose()
  assert.equal(routes.size, 0)
  assert.equal(taps.length, 0)
})
