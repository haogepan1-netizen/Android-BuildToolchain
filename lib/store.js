// State + manifest I/O and the environment gate (准入自检).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { HOME, LIBS_DIR, CACHE_DIR, LOG_DIR, STATE_FILE, LIBS, byId } from './catalog.js'

const SCHEMA = 'abt.manifest/1'

export function ensureDirs() {
  for (const d of [HOME, LIBS_DIR, CACHE_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true })
}

export function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return { schema: SCHEMA, installed: {}, ...s }
  } catch {
    return { schema: SCHEMA, installed: {}, createdAt: new Date().toISOString() }
  }
}

export function writeState(state) {
  ensureDirs()
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

export function libDir(lib) {
  return path.join(LIBS_DIR, lib.id)
}

export function readManifest(lib) {
  try {
    return JSON.parse(fs.readFileSync(path.join(libDir(lib), 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

// Written once per library, atomically, never edited by hand.
export function writeManifest(lib, extra) {
  const dir = libDir(lib)
  fs.mkdirSync(dir, { recursive: true })
  const manifest = {
    schema: SCHEMA,
    id: lib.id,
    title: lib.title,
    version: lib.version,
    group: lib.group,
    dest: path.join(dir, 'files'),
    archive: lib.kind,
    bytes: lib.bytes,
    source: lib.source,
    deps: lib.deps,
    post: lib.post || null,
    installedAt: new Date().toISOString(),
    installedBy: `abt@${process.env.DSH_VERSION || 'local'}`,
    ...extra,
  }
  const file = path.join(dir, 'manifest.json')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2))
  fs.renameSync(tmp, file)
  return manifest
}

export function installedIds() {
  return Object.keys(readState().installed)
}

export function refreshIndex() {
  ensureDirs()
  const list = installedIds().map((id) => {
    const m = readManifest(byId(id) || { id })
    return m ? { id, version: m.version, installedAt: m.installedAt, source: m.source, verify: m.verify } : { id }
  })
  fs.writeFileSync(path.join(HOME, 'index.json'), JSON.stringify({ schema: SCHEMA, generatedAt: new Date().toISOString(), count: list.length, libs: list }, null, 2))
}

function sh(cmd, args, timeout = 8000) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 20 })
    return { ok: true, out: String(out).trim() }
  } catch (err) {
    return { ok: false, out: String((err && (err.stdout || err.message)) || '').trim().slice(0, 300) }
  }
}

function freeBytes(p) {
  try {
    const s = fs.statfsSync(p)
    return s.bavail * s.bsize
  } catch {
    return -1
  }
}

// 准入自检：能不能真的跑起构建链路。
export function envCheck() {
  ensureDirs()
  const checks = []
  const push = (label, ok, detail, hard = false) => checks.push({ label, ok, detail, hard })

  let writable = false
  try {
    const probe = path.join(HOME, `.probe-${process.pid}`)
    fs.writeFileSync(probe, 'x')
    fs.unlinkSync(probe)
    writable = true
  } catch {}
  push('工作目录可写', writable, HOME, true)

  let exec = false
  try {
    const p = path.join(HOME, `.probe-${process.pid}.sh`)
    fs.writeFileSync(p, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(p, 0o755)
    exec = sh(p, []).ok
    fs.unlinkSync(p)
  } catch {}
  push('可执行位', exec, exec ? 'chmod 0755 可运行' : '文件系统不支持执行', true)

  const tar = sh('tar', ['--version'])
  push('归档工具', tar.ok, tar.ok ? tar.out.split('\n')[0] : '缺少 tar', true)

  // proot / 沙箱类环境没有完整 /proc 与 init。
  const fullLinux = sh('ls', ['/proc/1/root']).ok && fs.existsSync('/run/systemd/system')
  push('完整 Linux 环境', fullLinux, fullLinux ? 'systemd + /proc 齐全' : '无 /proc/1 或 systemd（proot 模拟环境）')

  const free = freeBytes(HOME)
  push('磁盘余量', free > 1_500_000_000, free < 0 ? '无法读取' : `${(free / 1e9).toFixed(1)} GB 可用`)

  const java = sh('java', ['-version'])
  push('系统 Java', java.ok, java.ok ? java.out.split('\n')[0] : '未安装（可装 JDK 21）')

  const hardBlock = checks.some((c) => c.hard && !c.ok)
  return {
    ok: !hardBlock,
    hardBlock,
    checks,
    // 用语：完全不可调用时走「礼貌回绝」分支。
    refusal: hardBlock
      ? {
          zh: '非常抱歉，本机缺少运行构建链路所需的基础能力（见上方未通过项），为避免在你的设备上留下半成品，本次安装已礼貌中止。卸载方式：设置 → 插件 → 构建工具链 → 移除，并删除 ~/.dsh/android-buildtoolchain。顺祝使用愉快。',
          en: 'Sorry — this device lacks the basics needed to run the build chain (see failed checks). To avoid leaving half-installed files, installation is politely declined. Remove it via Settings → Plugins → BuildToolchain.',
        }
      : null,
  }
}

export function libState(lib) {
  const st = readState()
  return st.installed[lib.id] || null
}

export function summary() {
  const st = readState()
  const total = LIBS.length
  const done = Object.values(st.installed).filter((x) => x.status === 'ready').length
  return { total, done, busy: st.busy || null }
}
