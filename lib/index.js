/**
 * dsh-tps-meter 宿主半侧：把会话实时输出吞吐喂给页面里的浮窗。
 *
 * 数据链路：
 *   session/event firehose（assistant/chunk 等）
 *     → tracker（滑动窗口算 tok/s）
 *       → GET /dsh-tps/state.json（浮窗轮询）
 *   GET /dsh-tps/widget.js  +  webServer.tapIndex 注入，构成浮窗本体。
 *
 * 不注册投影、不写会话日志、不碰模型请求：纯读侧观测，卸载即净。
 *
 * @module dsh-tps-meter
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRegistry } from './tracker.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIDGET_FILE = path.join(PACKAGE_ROOT, 'lib', 'widget.js')

const SCRIPT_PATH = '/dsh-tps/widget.js'
const STATE_PATH = '/dsh-tps/state.json'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}
const JS_HEADERS = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** Cordis 插件名（同时是 loader 条目 id 与 profile insert 行的 name）。 */
export const name = 'dsh-tps-meter'

/** 依赖的服务：只需要能挂 HTTP 路由的 webServer。 */
export const inject = ['webServer']

/**
 * 挂载插件：订阅会话事件流，注册浮窗资源与状态端点。
 * @param {object} ctx - 宿主 cordis 上下文。
 */
export function apply(ctx) {
  const registry = createRegistry()

  // 观察者绝不能把失败带进会话提交路径（firehose 是 fire-and-forget）。
  ctx.on('session/event', (session, event) => {
    try {
      registry.onEvent(session, event, Date.now())
    } catch (err) {
      try {
        ctx.logger?.warn?.('dsh-tps-meter: 事件处理失败: %s', String(err && err.message ? err.message : err))
      } catch (ignored) {}
    }
  })

  const disposers = []

  // 浮窗读的实时读数。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        const now = Date.now()
        let sessions = []
        try {
          sessions = registry.readings(now)
        } catch (err) {}
        const body = JSON.stringify({ ok: true, now, sessions })
        res.writeHead(200, JSON_HEADERS)
        res.end(body)
      },
    }),
  )

  // 浮窗脚本本体（每次读取磁盘，开发期改完刷新页面即可生效）。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: SCRIPT_PATH,
      handler: (req, res) => {
        try {
          const source = fs.readFileSync(WIDGET_FILE, 'utf8')
          res.writeHead(200, JS_HEADERS)
          res.end(source)
        } catch (err) {
          res.writeHead(500, { ...JS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('dsh-tps-meter: widget.js unreadable: ' + String((err && err.message) || err))
        }
      },
    }),
  )

  // 注入到 DSH 页面（只认 harness 自己的 index，避免污染其它 HTML）。
  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string') return html
      if (html.indexOf('__DSH_BOOT__') === -1) return html
      if (html.indexOf(SCRIPT_PATH) !== -1) return html
      const tag = `<script defer src="${SCRIPT_PATH}"></script>`
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', `${tag}</body>`)
      return html + tag
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {}
    }
  })
}
