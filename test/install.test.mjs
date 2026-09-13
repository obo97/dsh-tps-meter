/**
 * install.ps1 端到端测试：在临时 profile 上真跑安装 / 卸载脚本，
 * 断言它只碰 dsh-tps-meter 自己的登记，别的插件行一个不许动。
 *
 *   node test/install.test.mjs
 *
 * 为什么必须有这套测试：卸载不清干净 `dsh.profile.bundles` 会让 DSH 启动时
 * 解析不到 bundle（`cannot resolve profile bundle`）→ `plugin tree failed to
 * load` → 进程在监听端口前退出，用户看到的就是「DSH 起不来」。旧版脚本还有
 * 一个反向危险：删 patch 行时按 "缩进 ≥4 空格" 一路吃下去，会把**后面所有
 * 插件的 insert 行一起删掉**（用例 1/6 就是钉这两个方向的）。
 *
 * 说明：本机沙箱下 node 的 spawnSync 只能用 'ignore'/'inherit'，管道会 EPERM，
 * 所以子进程输出默认丢弃（要看得跑 TPS_TEST_VERBOSE=1）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_PS1 = path.join(HERE, '..', 'install.ps1')
const NAME = 'dsh-tps-meter'

let passed = 0
const failures = []

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (err) {
    failures.push({ label, err })
    console.log(`FAIL  ${label}`)
    console.log(`      ${err && err.message ? err.message.split('\n').join('\n      ') : String(err)}`)
  }
}

function runScript(profileDir, args) {
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_PS1]
  if (profileDir) argv.push('-ProfileDir', profileDir)
  argv.push(...args)
  const result = spawnSync('powershell', argv, {
    stdio: process.env.TPS_TEST_VERBOSE ? 'inherit' : 'ignore',
  })
  if (result.error) throw result.error
  return result.status
}

function readDoc(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return {
    raw,
    lines: raw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'),
    crlf: raw.includes('\r\n'),
    finalNewline: raw.endsWith('\n'),
    bom: raw.charCodeAt(0) === 0xfeff,
  }
}

function countOccurrences(lines, name) {
  return lines.filter((line) => line.includes(name)).length
}

/** 一个「真实」的 profile：多插件 + tps 夹在中间，patch 里 tps 后面还有别的插件。 */
function makeProfile({ bundles, patch, dependencies }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-install-'))
  const pkg = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: dependencies ?? {
      'dsh-memory-evolve': 'file:C:/plugins-src/dsh-memory-evolve',
      'dsh-tps-meter': 'link:D:/work/dsh-tps-meter',
      'dsh-ponytail': 'link:D:/work/dsh-ponytail',
    },
    dsh: { profile: { bundles: bundles ?? ['@deepseek-ai/dsh-base', 'dsh-tps-meter', 'dsh-ponytail'] } },
  }
  // 真实 profile 的 package.json 是 LF + 末尾换行
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  // 真实 profile 的 cordis.patch.yml 是 CRLF 且末尾无换行；tps 行后面还跟着别的插件
  const yml =
    patch ??
    [
      '- insert:',
      '    - id: dsh-memory-evolve',
      '      name: dsh-memory-evolve',
      '      config:',
      '        reviewEnabled: true',
      '    - id: dsh-tps-meter',
      '      name: dsh-tps-meter',
      '      config:',
      '        enabled: true',
      '    - id: dsh-security-guard',
      '      name: dsh-security-guard',
      '      config:',
      "        mirrorMdPath: 'D:/work/docs/log.md'",
      '',
      '# trailing comment',
    ].join('\r\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), yml, 'utf8')
  return dir
}

function readState(dir) {
  const pkg = readDoc(path.join(dir, 'package.json'))
  const patch = readDoc(path.join(dir, 'cordis.patch.yml'))
  return { pkg, patch, json: JSON.parse(pkg.raw) }
}

console.log('install.ps1 端到端测试\n')

// ---- 1. 卸载：清干净自己，别人的行一根不动（救援路径） ----------------------
{
  const dir = makeProfile({})
  const status = runScript(dir, ['-Remove', '-SkipPnpm'])
  const { pkg, patch, json } = readState(dir)

  check('卸载：退出码 0', () => assert.equal(status, 0))
  check('卸载：bundles 里的 dsh-tps-meter 已移除', () =>
    assert.equal(json.dsh.profile.bundles.includes(NAME), false))
  check('卸载：bundles 里其它项原样保留', () =>
    assert.deepEqual(json.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-ponytail']))
  check('卸载：dependencies 里的项已移除、其它保留', () =>
    assert.deepEqual(Object.keys(json.dependencies), ['dsh-memory-evolve', 'dsh-ponytail']))
  check('卸载：patch 里 dsh-tps-meter 的行（含 config 子块）已移除', () =>
    assert.equal(countOccurrences(patch.lines, NAME), 0))
  check('卸载：patch 里它后面的 security-guard 行完整保留（不吃掉同级行）', () => {
    assert.equal(countOccurrences(patch.lines, 'dsh-security-guard'), 2)
    assert.ok(patch.raw.includes("        mirrorMdPath: 'D:/work/docs/log.md'"), 'config 子行应保留')
  })
  check('卸载：patch 里它前面的 memory-evolve 行完整保留', () => {
    assert.equal(countOccurrences(patch.lines, 'dsh-memory-evolve'), 2)
    assert.ok(patch.raw.includes('        reviewEnabled: true'), 'config 子行应保留')
  })
  check('卸载：package.json 仍是合法 JSON', () => {
    assert.doesNotThrow(() => JSON.parse(pkg.raw))
  })
  check('卸载：没有写 BOM', () => {
    assert.equal(pkg.bom, false)
    assert.equal(patch.bom, false)
  })
  check('卸载：package.json 保持 LF 与末尾换行', () => {
    assert.equal(pkg.crlf, false)
    assert.equal(pkg.finalNewline, true)
  })
  check('卸载：cordis.patch.yml 保持 CRLF 与无末尾换行', () => {
    assert.equal(patch.crlf, true)
    assert.equal(patch.finalNewline, false)
  })
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- 2. 卸载幂等：再跑一次不报错、不再改动文件 ------------------------------
{
  const dir = makeProfile({})
  runScript(dir, ['-Remove', '-SkipPnpm'])
  const before = {
    pkg: fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    patch: fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'),
  }
  const status = runScript(dir, ['-Remove', '-SkipPnpm'])
  const after = {
    pkg: fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    patch: fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'),
  }
  check('幂等卸载：退出码 0', () => assert.equal(status, 0))
  check('幂等卸载：第二次运行不再改动文件', () => assert.deepEqual(after, before))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- 3. 安装：登记进 dsh.profile.bundles，不再写 patch 行 --------------------
{
  const dir = makeProfile({ bundles: ['@deepseek-ai/dsh-base', 'dsh-ponytail'], patch: '- insert:\n' })
  const status = runScript(dir, ['-SkipPnpm'])
  const { pkg, patch, json } = readState(dir)

  check('安装：退出码 0', () => assert.equal(status, 0))
  check('安装：bundles 末尾列出 dsh-tps-meter', () =>
    assert.deepEqual(json.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-ponytail', NAME]))
  check('安装：不往 patch 里写行（单一登记）', () =>
    assert.equal(countOccurrences(patch.lines, NAME), 0))
  check('安装：package.json 仍是合法 JSON 且无 BOM', () => {
    assert.doesNotThrow(() => JSON.parse(pkg.raw))
    assert.equal(pkg.bom, false)
  })
  check('安装：重复安装不产生第二份登记', () => {
    runScript(dir, ['-SkipPnpm'])
    const again = readState(dir).json
    assert.equal(again.dsh.profile.bundles.filter((x) => x === NAME).length, 1)
  })
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- 4. 老式安装迁移：patch 有行、bundles 没有 → 安装后只剩 bundles 一处 -----
{
  const dir = makeProfile({ bundles: ['@deepseek-ai/dsh-base'] })
  const status = runScript(dir, ['-SkipPnpm'])
  const { patch, json } = readState(dir)

  check('迁移：退出码 0', () => assert.equal(status, 0))
  check('迁移：遗留 patch 行被清除', () => assert.equal(countOccurrences(patch.lines, NAME), 0))
  check('迁移：security-guard 行不受牵连', () =>
    assert.equal(countOccurrences(patch.lines, 'dsh-security-guard'), 2))
  check('迁移：登记落到 dsh.profile.bundles', () =>
    assert.deepEqual(json.dsh.profile.bundles, ['@deepseek-ai/dsh-base', NAME]))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- 5. 边界：dsh-tps-meter 是 bundles 末项（无尾逗号）时也要保持 JSON 合法 --
{
  const dir = makeProfile({ bundles: ['@deepseek-ai/dsh-base', 'dsh-ponytail', NAME] })
  const status = runScript(dir, ['-Remove', '-SkipPnpm'])
  const { json } = readState(dir)

  check('末项边界：退出码 0', () => assert.equal(status, 0))
  check('末项边界：删末项后 JSON 合法、前项逗号被裁掉', () => {
    assert.deepEqual(json.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-ponytail'])
  })
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- 6. 不认识的结构就拒绝改（而不是猜着改坏配置） --------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-install-'))
  const compact = '{"name":"x","dependencies":{"dsh-tps-meter":"link:D:/x"},"dsh":{"profile":{"bundles":["a","dsh-tps-meter"]}}}\n'
  fs.writeFileSync(path.join(dir, 'package.json'), compact, 'utf8')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n', 'utf8')
  const status = runScript(dir, ['-Remove', '-SkipPnpm'])
  const after = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')

  check('紧凑 JSON：识别不了就非零退出并明确报错', () => assert.notEqual(status, 0))
  check('紧凑 JSON：文件未被改坏（原样保留）', () => assert.equal(after, compact))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- 7. 真实 profile 形状的自检（只读，不改动真实 profile） ------------------
{
  const real = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'package.json')
  if (fs.existsSync(real)) {
    const json = JSON.parse(fs.readFileSync(real, 'utf8'))
    const bundles = json.dsh?.profile?.bundles ?? []
    const deps = json.dependencies ?? {}
    check('真机 profile：bundles 里没有已卸载的悬空项', () => {
      const dangling = bundles.filter((name) => !(name in deps) && !name.startsWith('@deepseek-ai/'))
      assert.deepEqual(dangling, [], `悬空 bundle 项会让 DSH 起不来：${dangling.join(', ')}`)
    })
  }
}

console.log('')
if (failures.length > 0) {
  console.log(`${passed}/${passed + failures.length} 通过，${failures.length} 失败`)
  process.exit(1)
}
console.log(`${passed}/${passed} 全部通过`)
