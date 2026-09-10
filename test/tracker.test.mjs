/**
 * tracker 纯逻辑单测：token 估算、滑动窗口速度、步骤状态机、提供方 usage 校正、
 * 登记表过滤与排序。跑法：node --test test/ （在项目根）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEvent,
  createRegistry,
  createTracker,
  dirName,
  estimateTokens,
  IDLE_MS,
  snapshot,
  windowTps,
} from '../lib/tracker.js'

const SESSION = { id: 'session-test', header: { cwd: 'D:\\work\\demo-project' } }

function chunk(text, kind = 'text-delta') {
  return { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: kind, index: 0, text } } }
}

test('estimateTokens：ASCII / CJK / 混合 / 空', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('你好世界'), 2.4)
  assert.ok(Math.abs(estimateTokens('hello 你好') - 2.7) < 1e-9)
  assert.equal(estimateTokens(null), 0)
})

test('dirName：取末级目录', () => {
  assert.equal(dirName('D:\\work\\demo-project'), 'demo-project')
  assert.equal(dirName('/home/me/proj'), 'proj')
  assert.equal(dirName(''), '')
  assert.equal(dirName(undefined), '')
})

test('滑动窗口：连续 chunk 的速度落在合理区间', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const start = 1_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: start }, start)
  let now = start
  // 每 100ms 一个 'abcd' chunk（≈1 token），共 10 个 → 约 10 tok/s
  for (let i = 0; i < 10; i += 1) {
    now += 100
    applyEvent(tr, chunk('abcd'), now)
  }
  const tps = windowTps(tr, now)
  assert.ok(tps > 8 && tps < 14, `tps=${tps}`)
})

test('状态机：waiting → streaming → done，并按精确 usage 记账', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 5_000
  applyEvent(tr, { type: 'step/start', data: { turn: 2, step: 3 }, time: t0 }, t0)
  assert.equal(tr.phase, 'waiting')

  let now = t0
  for (let i = 0; i < 5; i += 1) {
    now += 100
    applyEvent(tr, chunk('abcd'), now)
  }
  assert.equal(tr.phase, 'streaming')
  assert.equal(tr.firstTokenMs, t0 + 100)

  applyEvent(
    tr,
    { type: 'assistant/chunk', data: { turn: 2, step: 3, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 40 } } } },
    now,
  )
  assert.equal(tr.stepTokens, 40)

  now += 100
  applyEvent(
    tr,
    { type: 'assistant/message', data: { turn: 2, step: 3, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 40 } }, time: now },
    now,
  )
  assert.equal(tr.phase, 'done')
  assert.equal(tr.totalTokens, 40)
  assert.equal(tr.ttftMs, 100)
  assert.equal(tr.lastStepMs, 500)
  assert.ok(tr.lastStepTps > 75 && tr.lastStepTps < 85, `tps=${tr.lastStepTps}`)
  // 估算（5 token）与精确（40）差距大，校正系数应被拉高但受限幅
  assert.ok(tr.calibration > 1 && tr.calibration <= 3, `cal=${tr.calibration}`)
})

test('无 usage 的步：用估算值累计', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 9_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(tr, chunk('abcdefgh'), t0 + 50)
  applyEvent(tr, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } }, time: t0 + 500 }, t0 + 500)
  assert.equal(tr.totalTokens, 2)
  assert.equal(tr.ttftMs, 50)
  // 解码 450ms 产出 2 token → 约 4.4 tok/s
  assert.ok(tr.lastStepTps > 4 && tr.lastStepTps < 5, `tps=${tr.lastStepTps}`)
})

test('解码时长过短的步不给平均速度（避免噪声）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 20_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(tr, chunk('abcd'), t0 + 10)
  applyEvent(tr, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } }, time: t0 + 60 }, t0 + 60)
  assert.equal(tr.lastStepTps, null)
  assert.equal(tr.totalTokens, 1)
})

test('tool-call-delta 同样计入输出吞吐', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: 1000 }, 1000)
  applyEvent(tr, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{"path":"a"}' } } }, 1100)
  assert.equal(tr.phase, 'streaming')
  assert.ok(tr.streamEstTokens > 0)
})

test('readings：running 优先，空闲超时后 running=false', () => {
  const reg = createRegistry()
  const a = { id: 'a', header: { cwd: 'D:\\x\\proj-a' } }
  const b = { id: 'b', header: { cwd: 'D:\\x\\proj-b' } }
  const t0 = 100_000
  reg.onEvent(a, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(a, chunk('abcd'), t0 + 100)
  reg.onEvent(b, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 - 5000 }, t0 - 5000)
  reg.onEvent(b, chunk('abcd'), t0 - 4900)
  reg.onEvent(b, { type: 'turn/end', data: { turn: 1 }, time: t0 - 4000 }, t0 - 4000)

  const running = reg.readings(t0 + 200)
  assert.equal(running[0].id, 'a')
  assert.equal(running[0].running, true)
  assert.equal(running[0].dir, 'proj-a')

  const later = reg.readings(t0 + IDLE_MS + 500)
  assert.equal(later[0].running, false, '空闲超时后不再算 running')
  assert.equal(later.find((r) => r.id === 'b').phase, 'idle')
})

test('readings：整轮进行中（哪怕还没输出）也要显示，彻底空闲才让位', () => {
  const reg = createRegistry()
  const session = { id: 'noop', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 1000
  // 刚发消息、模型还在思考：没有任何 token，但整轮开着 → 必须出现在列表里
  reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } }, t0)
  const list = reg.readings(t0 + 200)
  assert.equal(list.length, 1)
  assert.equal(list[0].active, true)
  // 等待首 token 的窗口内 running 也是 true（1.5s 后自然回落），但 active 全程为真
  assert.equal(list[0].running, true)
  assert.equal(reg.readings(t0 + 5000)[0].running, false)

  // 整轮结束且全程零输出 → 不再占位
  reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: t0 + 500 }, t0 + 500)
  assert.equal(reg.readings(t0 + 600).length, 0)
  assert.equal(reg.count(), 1)
})

test('snapshot：字段形状与空值', () => {
  const tr = createTracker({ id: 's', cwd: 'D:\\x\\proj', now: 0 })
  const snap = snapshot(tr, 1000)
  assert.deepEqual(Object.keys(snap).sort(), [
    'active', 'avgMs', 'avgTps', 'calibration', 'cwd', 'dir', 'id', 'lastEventMs', 'lastStepTps', 'phase',
    'quietMs', 'running', 'step', 'stepMs', 'stepTokens', 'sub', 'title', 'toolActive', 'totalTokens', 'tps', 'ttftMs', 'turn',
  ])
  assert.equal(snap.running, false)
  assert.equal(snap.ttftMs, null)
  assert.equal(snap.sub, false)
  assert.equal(snap.avgTps, null)
  assert.equal(snap.title, '')
  assert.equal(snap.active, false)
  assert.equal(snap.toolActive, false)
})

test('整轮活动：turn 未结束就是 active（思考/跑工具空档里不能误判成已完成）', () => {
  const reg = createRegistry()
  const session = { id: 'busy', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 600_000
  reg.onEvent(session, { type: 'turn/start', data: { turn: 1 }, time: t0 }, t0)
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(session, chunk('abcd'), t0 + 50)

  const r = reg.readings(t0 + 100).find((x) => x.id === 'busy')
  assert.equal(r.active, true, 'turn 未结束 → active')
  assert.equal(r.toolActive, false)

  // 输出停了很久（思考 / 跑工具的空档）：running 会变 false，但 active 必须仍为 true
  const quiet = reg.readings(t0 + 60_000).find((x) => x.id === 'busy')
  assert.equal(quiet.running, false)
  assert.equal(quiet.active, true, '空档期不能算完成')

  // 工具执行中
  reg.onEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }, time: t0 + 60_100 }, t0 + 60_100)
  assert.equal(reg.readings(t0 + 60_200).find((x) => x.id === 'busy').toolActive, true)
  reg.onEvent(session, { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'c1' } } }, time: t0 + 61_000 }, t0 + 61_000)
  assert.equal(reg.readings(t0 + 61_100).find((x) => x.id === 'busy').toolActive, false)

  // 整轮结束 → 才算完成
  reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: t0 + 62_000 }, t0 + 62_000)
  const done = reg.readings(t0 + 62_100).find((x) => x.id === 'busy')
  assert.equal(done.active, false)
  assert.equal(done.running, false)
})

test('会话标题：session/title 事件与历史折叠都能取到', () => {
  const reg = createRegistry()
  const session = { id: 'titled', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 500_000
  reg.onEvent(session, { type: 'session/title', data: { title: '修一下登录', source: { kind: 'auto' } }, time: t0 }, t0)
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(session, chunk('abcd'), t0 + 50)
  assert.equal(reg.readings(t0 + 100).find((r) => r.id === 'titled').title, '修一下登录')

  // 最新一条胜出
  reg.onEvent(session, { type: 'session/title', data: { title: '改标题了', source: { kind: 'user' } }, time: t0 + 200 }, t0 + 200)
  assert.equal(reg.readings(t0 + 300).find((r) => r.id === 'titled').title, '改标题了')

  // 插件挂载前就已存在的标题：从 session.events 折叠
  const old = { id: 'old', header: { cwd: 'D:\\x\\proj' }, events: [{ type: 'session/title', data: { title: '历史标题' } }] }
  reg.onEvent(old, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(old, chunk('abcd'), t0 + 50)
  const oldReading = reg.readings(t0 + 100).find((r) => r.id === 'old')
  assert.equal(oldReading.title, '历史标题')

  // 空标题不覆盖已有标题
  reg.onEvent(session, { type: 'session/title', data: { title: '   ' }, time: t0 + 400 }, t0 + 400)
  assert.equal(reg.readings(t0 + 500).find((r) => r.id === 'titled').title, '改标题了')
})

test('均速：生成中实时增长，结束后定格为最后一步平均', () => {
  const reg = createRegistry()
  const session = { id: 's', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 400_000
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  // 20 个 'abcd'（各 ≈1 token），每 100ms 一个 → 首 token 落在 t0+100
  let now = t0
  for (let i = 0; i < 20; i += 1) {
    now += 100
    reg.onEvent(session, chunk('abcd'), now)
  }
  const mid = reg.readings(now)[0]
  assert.ok(mid.avgTps > 8 && mid.avgTps < 13, `avgTps=${mid.avgTps}`)
  assert.ok(mid.avgMs >= 1800 && mid.avgMs <= 2000, `avgMs=${mid.avgMs}`)
  assert.ok(mid.tps > 8 && mid.tps < 13, `tps=${mid.tps}`)

  // 结算：提供方给 40 token → 均速切换为精确值 40 / 2.0s = 20 tok/s
  now += 100
  reg.onEvent(
    session,
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 5, outputTokens: 40 } }, time: now },
    now,
  )
  const done = reg.readings(now + 100)[0]
  assert.equal(done.running, false)
  assert.equal(done.tps, 0, '停下后实时速度归零')
  assert.equal(done.avgTps, done.lastStepTps)
  assert.ok(done.avgTps > 19 && done.avgTps < 21, `avgTps=${done.avgTps}`)
})

test('readings：主会话排在 subagent 子会话之前', () => {
  const reg = createRegistry()
  const main = { id: 'main', header: { cwd: 'D:\\x\\proj' } }
  const sub = { id: 'sub', header: { cwd: 'D:\\x\\proj', origin: 'subagent', delegationDepth: 1 } }
  const t0 = 300_000
  for (const s of [main, sub]) {
    reg.onEvent(s, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
    reg.onEvent(s, chunk('abcd'), t0 + 50)
  }
  const list = reg.readings(t0 + 100)
  assert.equal(list[0].id, 'main')
  assert.equal(list[0].sub, false)
  assert.equal(list[1].sub, true)
})

test('stepMs：本步结束后定格，不随空闲时间增长', () => {
  const reg = createRegistry()
  const session = { id: 's-steps', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 900_000
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(session, chunk('abcd'), t0 + 100)
  reg.onEvent(
    session,
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: { outputTokens: 4 } }, time: t0 + 600 },
    t0 + 600,
  )
  const soon = reg.readings(t0 + 1000)[0]
  const later = reg.readings(t0 + 600_000)[0]
  assert.equal(soon.stepMs, 600, '本步耗时 = 结束时刻 - 开始时刻')
  assert.equal(later.stepMs, 600, '空闲 10 分钟后仍是 600ms，不再膨胀')
})
