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
 * Host 头是否指向本机回环。DSH 只监听 127.0.0.1，正常访问的 Host 必是这几个；
 * 拦住其它 Host 是为了挡 DNS rebinding —— 恶意页面把自有域名解析到 127.0.0.1 后，
 * 请求就变成"同源"，能绕过 CORS 读走会话标题与工作目录。
 * @param {string|undefined} hostHeader - 请求的 Host 头。
 * @returns {boolean} 是否放行。
 */
function isLocalHost(hostHeader) {
  // 没有 Host 头（HTTP/1.0 客户端、测试桩）不构成 rebinding 风险，放行。
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return true
  let host = hostHeader.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end > 0) host = host.slice(0, end + 1)
  } else if (host.indexOf(':') === host.lastIndexOf(':')) {
    const at = host.indexOf(':')
    if (at > 0) host = host.slice(0, at)
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

/**
 * 只读端点守卫：非本机 Host → 403，非 GET/HEAD → 405。
 * @param {object} req - 请求对象。
 * @param {object} res - 响应对象。
 * @param {object} headers - 该端点的默认响应头。
 * @returns {boolean} true = 通过，可继续处理；false = 已回绝。
 */
function guard(req, res, headers) {
  const method = req?.method
  if (!isLocalHost(req?.headers?.host)) {
    res.writeHead(403, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('dsh-tps-meter: host not allowed')
    return false
  }
  if (typeof method === 'string' && method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('dsh-tps-meter: method not allowed')
    return false
  }
  return true
}

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
        if (!guard(req, res, JSON_HEADERS)) return
        const now = Date.now()
        let sessions = []
        try {
          sessions = registry.readings(now)
        } catch (err) {}
        const body = JSON.stringify({ ok: true, now, sessions })
        try {
          res.writeHead(200, JSON_HEADERS)
          res.end(body)
        } catch (err) {
          // 客户端提前断开（刷新页面/关标签）时写响应会抛，忽略即可。
        }
      },
    }),
  )

  // 浮窗脚本本体（每次读取磁盘，开发期改完刷新页面即可生效）。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: SCRIPT_PATH,
      handler: (req, res) => {
        if (!guard(req, res, JS_HEADERS)) return
        try {
          const source = fs.readFileSync(WIDGET_FILE, 'utf8')
          res.writeHead(200, JS_HEADERS)
          res.end(source)
        } catch (err) {
          try {
            res.writeHead(500, { ...JS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('dsh-tps-meter: widget.js unreadable: ' + String((err && err.message) || err))
          } catch (ignored) {}
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
