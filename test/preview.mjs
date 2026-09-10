/**
 * 浮窗本地预览服务（开发用，不属于插件运行时）：
 * 起一个仅监听回环的 HTTP 服务，用 mock 读数喂 lib/widget.js，
 * 供无头浏览器截图 / 手动打开 http://127.0.0.1:8899/ 看样式。
 *
 *   node test/preview.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PREVIEW_PORT ?? 8899)
/** live = 一直生成中 | done = 刚结束 | empty = 无会话。 */
const MODE = process.env.PREVIEW_MODE ?? 'live'
const START = Date.now()

function readWidget() {
  return fs.readFileSync(path.join(ROOT, 'lib', 'widget.js'), 'utf8')
}

/** mock：一个正在流式输出的会话 + 一个刚结束的会话。 */
function state() {
  const elapsed = Date.now() - START
  const live = MODE === 'live'
  const thinking = MODE === 'thinking'
  const tool = MODE === 'tool'
  if (MODE === 'empty') return { ok: true, now: Date.now(), sessions: [] }
  const phase = live ? 'streaming' : thinking ? 'waiting' : 'done'
  const tps = live ? 86 + Math.sin(elapsed / 900) * 24 + Math.sin(elapsed / 260) * 6 : 0
  const stepTokens = live ? 40 + elapsed * 0.075 : 1900
  return {
    ok: true,
    now: Date.now(),
    sessions: [
      {
        id: 'session-preview-0001',
        dir: 'demo-project',
        cwd: 'D:\\work\\demo-project',
        title: 'Refactor the login flow',
        phase,
        running: live,
        // thinking / tool：整轮还在进行但没有流式输出（数字会掉到 0，靠状态行说明）
        active: live || thinking || tool,
        toolActive: tool,
        tps: Math.round(tps * 10) / 10,
        avgTps: live ? Math.round((tps - 11 + Math.sin(elapsed / 1500) * 4) * 10) / 10 : 92.4,
        avgMs: live ? Math.max(200, elapsed - 780) : 20_600,
        stepTokens: Math.round(stepTokens),
        totalTokens: Math.round(12_400 + (live ? elapsed * 0.07 : 1900)),
        ttftMs: 783,
        lastStepTps: 92.4,
        turn: 3,
        step: 7,
        stepMs: elapsed,
        quietMs: live ? 120 : thinking || tool ? 2400 : 3000,
        lastEventMs: Date.now(),
        calibration: 1.18,
      },
      {
        id: 'session-preview-0002',
        dir: 'data-pipeline',
        cwd: 'D:\\work\\data-pipeline',
        title: 'Optimize the data pipeline',
        phase: 'idle',
        running: false,
        tps: 0,
        avgTps: 61.5,
        avgMs: 13_200,
        stepTokens: 812,
        totalTokens: 21_055,
        ttftMs: 1204,
        lastStepTps: 61.5,
        turn: 6,
        step: 11,
        stepMs: 0,
        quietMs: 42_000,
        lastEventMs: Date.now() - 42_000,
        calibration: 1.05,
      },
      {
        id: 'session-preview-0003',
        dir: 'web-dashboard',
        cwd: 'D:\\work\\web-dashboard',
        title: 'Add dark mode to the dashboard',
        phase: 'idle',
        running: false,
        tps: 0,
        avgTps: 58.2,
        avgMs: 9100,
        stepTokens: 431,
        totalTokens: 8420,
        ttftMs: 990,
        lastStepTps: 58.2,
        turn: 3,
        step: 5,
        stepMs: 0,
        quietMs: 120_000,
        lastEventMs: Date.now() - 120_000,
        calibration: 1.02,
      },
      {
        id: 'session-preview-0004',
        dir: 'api-service',
        cwd: 'D:\\work\\api-service',
        title: 'Polish the widget layout',
        phase: 'idle',
        running: false,
        tps: 0,
        avgTps: 71.9,
        avgMs: 5400,
        stepTokens: 388,
        totalTokens: 3110,
        ttftMs: 845,
        lastStepTps: 71.9,
        turn: 2,
        step: 4,
        stepMs: 0,
        quietMs: 260_000,
        lastEventMs: Date.now() - 260_000,
        calibration: 1.11,
      },
    ],
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-tps-meter 浮窗预览</title>
<style>
  html,body{margin:0;height:100%}
  body{background:#15161a;color:#e8e8ea;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif}
  body[data-ds-dark-theme]{background:#15161a}
  .fake{max-width:620px;margin:40px auto;padding:0 18px;opacity:.55}
  .fake h1{font-size:15px;font-weight:600;margin:0 0 14px}
  .bubble{background:#22242b;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:13px;line-height:1.5}
  .bubble.me{background:#2c3350}
</style></head>
<body><div class="fake"><h1>dsh-tps-meter 浮窗预览（mock 数据）</h1>
<div class="bubble">这是模拟的 DSH 深色界面，右下角就是待验证的悬浮窗。浮窗会每 400ms 轮询 /dsh-tps/state.json。</div>
<div class="bubble me">看得到 tok/s 数字与迷你曲线吗？</div></div>
<script>document.body.toggleAttribute('data-ds-dark-theme', true)</script>
<script>
  // 预览用：?view=avg|live 预置浮窗显示模式，方便分别截图核对。
  var m = /[?&]view=(avg|live)/.exec(location.search)
  if (m) { try { localStorage.setItem('dsh-tps-meter:mode', m[1]) } catch (e) {} }
  // 预览用：?autodbl=1 自动双击（第一行正在跑 → 应无效；第二行已完成 → 应被关闭）。
  if (/[?&]autodbl=1/.test(location.search)) {
    setTimeout(function () {
      var fire = function (el) { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) }
      var rows = document.querySelectorAll('#dshtps .t-sess')
      if (rows.length > 0) fire(rows[0])
      setTimeout(function () {
        var list = document.querySelectorAll('#dshtps .t-sess')
        if (list.length > 1) fire(list[1])
      }, 400)
    }, 2500)
  }
</script>
<script defer src="/dsh-tps/widget.js"></script>
</body></html>`

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'
  if (url.startsWith('/dsh-tps/state.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(state()))
    return
  }
  if (url.startsWith('/dsh-tps/widget.js')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(readWidget())
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(PAGE)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${PORT}/`)
})
