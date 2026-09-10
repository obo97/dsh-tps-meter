/**
 * 浮窗渲染行为测试（客户端半侧）：用极简 DOM 桩在 vm 里跑 lib/widget.js，
 * 验证用户能直接看到的两件事 ——
 *   ① 多会话交替输出时，会话行的位置不会互相换位（宿主返回顺序抖动也不动）；
 *   ② "当前显示"的会话（绿字 + 大数字）不会在几个会话之间来回跳。
 * 跑法：node test/widget.test.mjs（或 node --test test/）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRegistry } from '../lib/tracker.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'widget.js'), 'utf8')

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 一个刚好够 widget.js 跑起来的假元素。 */
function fakeEl() {
  const el = {
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    id: '',
    dataset: {},
    style: {},
    offsetWidth: 186,
    offsetHeight: 166,
    width: 332,
    height: 60,
    _attrs: {},
    _handlers: {},
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c)
      },
      remove(c) {
        this._set.delete(c)
      },
      contains(c) {
        return this._set.has(c)
      },
      toggle(c, on) {
        const next = on === undefined ? !this._set.has(c) : !!on
        if (next) this._set.add(c)
        else this._set.delete(c)
        return next
      },
    },
    addEventListener(type, fn) {
      ;(this._handlers[type] = this._handlers[type] || []).push(fn)
    },
    removeEventListener() {},
    appendChild(kid) {
      this._kids = this._kids || []
      this._kids.push(kid)
      return kid
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v)
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null
    },
    hasAttribute() {
      return false
    },
    closest() {
      return null
    },
    getContext() {
      return { clearRect() {}, fillRect() {}, fillStyle: '' }
    },
  }
  return el
}

/** 搭一个 DOM 环境并把 widget.js 跑起来。 */
function startWidget() {
  const stubs = new Map()
  const docHandlers = {}
  const visibility = []

  const segments = ['live', 'avg'].map((mode) => {
    const el = fakeEl()
    el._attrs['data-mode'] = mode
    return el
  })

  // 同一个选择器始终返回同一个桩，这样 widget 写进去的内容测试读得到。
  const makeEl = () => {
    const el = fakeEl()
    el.querySelector = (sel) => {
      if (!stubs.has(sel)) stubs.set(sel, fakeEl())
      return stubs.get(sel)
    }
    el.querySelectorAll = () => segments
    return el
  }

  const document = {
    hidden: false,
    head: fakeEl(),
    body: fakeEl(),
    createElement: () => makeEl(),
    querySelector: () => null,
    addEventListener(type, fn) {
      ;(docHandlers[type] = docHandlers[type] || []).push(fn)
      if (type === 'visibilitychange') visibility.push(fn)
    },
  }

  const store = new Map()
  const env = {
    document,
    window: {
      innerWidth: 1280,
      innerHeight: 860,
      location: { reload() {} },
      addEventListener() {},
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  }

  let payload = { ok: true, sessions: [] }
  const sandbox = {
    window: env.window,
    document: env.document,
    localStorage: env.localStorage,
    fetch: async () => ({ ok: true, json: async () => payload }),
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    console,
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'widget.js' })

  // widget 自己 createElement 出根节点并挂到 body —— 取回来当测试的观察窗口。
  const root = document.body._kids[0]
  env.root = root
  const sessionsEl = root.querySelector('.t-sessions')
  env.rows = () => Array.from(sessionsEl.innerHTML.matchAll(/data-id="([^"]+)"/g), (m) => m[1])
  env.selected = () => {
    const m = /class="t-sess on" data-id="([^"]+)"/.exec(sessionsEl.innerHTML)
    return m === null ? null : m[1]
  }
  /** 推一轮宿主读数（顺带触发一次轮询渲染）。 */
  env.push = async (sessions) => {
    payload = { ok: true, now: Date.now(), sessions }
    for (const fn of visibility) fn()
    await flush()
    await flush()
  }
  return env
}

/** 造一条读数（只填与排序/选择相关的字段）。 */
function reading(id, { working = true, tps = 50, title = '' } = {}) {
  return {
    id,
    dir: id,
    cwd: 'D:\\work\\' + id,
    title,
    sub: false,
    phase: working ? 'streaming' : 'done',
    running: working,
    active: working,
    toolActive: false,
    tps,
    avgTps: tps,
    avgMs: 1000,
    stepTokens: 100,
    totalTokens: 2000,
    ttftMs: 500,
    lastStepTps: tps,
    turn: 1,
    step: 2,
    stepMs: 2000,
    quietMs: 100,
    lastEventMs: Date.now(),
    calibration: 1,
  }
}

test('行序稳定：宿主把同一批会话换个顺序返回，行不会上下换位', async () => {
  const ui = startWidget()
  await ui.push([reading('a'), reading('b')])
  const first = ui.rows()
  assert.equal(first.length, 2, '两个会话都应显示')

  // 宿主排序按"谁刚吐 token"翻来覆去，这里反复交换顺序推送
  for (let i = 0; i < 6; i += 1) {
    const order = i % 2 === 0 ? [reading('b'), reading('a')] : [reading('a'), reading('b')]
    await ui.push(order)
    assert.deepEqual(ui.rows(), first, `第 ${i} 次轮询后行序应保持不变`)
  }
})

test('行序稳定：工作状态的会话恒在已完成之前，组内次序不受抖动影响', async () => {
  const ui = startWidget()
  await ui.push([reading('a'), reading('b')])
  // a 闲下来：它掉到"已完成"组，b 仍在工作 → b 在前，且之后不再变
  await ui.push([reading('a', { working: false }), reading('b')])
  assert.deepEqual(ui.rows(), ['b', 'a'])
  for (let i = 0; i < 4; i += 1) {
    const order = i % 2 === 0 ? [reading('b'), reading('a', { working: false })] : [reading('a', { working: false }), reading('b')]
    await ui.push(order)
    assert.deepEqual(ui.rows(), ['b', 'a'], '组内位置应恒定')
  }
})

test('绿字不跳：没手动点选时，当前显示的会话咬住不放', async () => {
  const ui = startWidget()
  await ui.push([reading('a'), reading('b')])
  const shown = ui.selected()
  assert.ok(shown === 'a' || shown === 'b', `应有选中项，实际 ${shown}`)

  // 另一个会话开始输出并被宿主排到最前 —— 显示项不许跟着换人
  for (let i = 0; i < 6; i += 1) {
    await ui.push(i % 2 === 0 ? [reading('b', { tps: 90 }), reading('a')] : [reading('a'), reading('b', { tps: 90 })])
    assert.equal(ui.selected(), shown, `第 ${i} 次轮询后绿字应仍是 ${shown}`)
  }
})

test('绿字不跳：被关闭的会话消失后，才回落到新的可用会话', async () => {
  const ui = startWidget()
  await ui.push([reading('a'), reading('b')])
  const shown = ui.selected()
  const other = shown === 'a' ? 'b' : 'a'

  // 只剩另一个会话（被关掉的 / 已下线的）→ 必须回落到它，不能空着
  await ui.push([reading(other)])
  assert.equal(ui.selected(), other)
})

test('空读数不炸：列表给占位、数字归零', async () => {
  const ui = startWidget()
  await ui.push([])
  assert.equal(ui.rows().length, 0)
  assert.ok(ui.root.querySelector('.t-sessions').innerHTML.includes('暂无会话输出'))
  assert.equal(ui.root.querySelector('.t-num').textContent, '0.0')
})

test('端到端：宿主按活跃度抖动排序时，浮窗行序与当前会话都纹丝不动', async () => {
  // ① 用真实 tracker 造「两个会话交替输出」的流量，取宿主真实返回的读数序列。
  //    宿主排序键是 running + lastEventMs，交替输出时两者都在变 → 顺序会抖，
  //    这正是用户看到的"位置上下浮动 + 绿字交替"的来源。
  const reg = createRegistry()
  const a = { id: 'session-aaaa1111', header: { cwd: 'D:\\work\\proj-a' } }
  const b = { id: 'session-bbbb2222', header: { cwd: 'D:\\work\\proj-b' } }
  const delta = () => ({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(400) } },
  })
  reg.onEvent(a, { type: 'turn/start', data: { turn: 1 } }, 5_000_000)
  reg.onEvent(b, { type: 'turn/start', data: { turn: 1 } }, 5_000_000)
  let now = 5_000_000
  const frames = []
  for (let i = 0; i < 12; i += 1) {
    reg.onEvent(i % 2 === 0 ? a : b, delta(), now)
    now += 400
    frames.push(reg.readings(now))
  }
  const hostOrders = new Set(frames.map((f) => f.map((r) => r.id).join(',')))
  assert.ok(hostOrders.size > 1, `宿主顺序应随活跃度变化（否则这个场景没造出抖动）：${[...hostOrders].join(' / ')}`)

  // ② 把这份抖动的数据原样喂给浮窗：行序与"当前显示"的会话都不许变。
  const ui = startWidget()
  const rows = []
  const shown = []
  for (const frame of frames) {
    await ui.push(frame)
    rows.push(ui.rows().join(','))
    shown.push(ui.selected())
  }
  assert.equal(new Set(rows).size, 1, `行序应恒定，实际出现 ${new Set(rows).size} 种：${[...new Set(rows)].join(' / ')}`)
  assert.equal(new Set(shown).size, 1, `当前显示的会话应恒定，实际出现 ${new Set(shown).size} 种：${[...new Set(shown)].join(' / ')}`)
})
