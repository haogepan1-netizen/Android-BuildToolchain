// Installer: fetch -> verify sha256 -> isolated extract -> verify -> atomic commit.
// Any failure removes the staging dir entirely (rollback), nothing half-installed stays.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HOME, LIBS_DIR, CACHE_DIR, LOG_DIR, CACHE_DIR as CACHE, byId, LIBS } from './catalog.js'
import { ensureDirs, readState, writeState, libDir, writeManifest, readManifest, envCheck, refreshIndex } from './store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTRACTOR = path.join(HERE, 'extract.py')

export const progress = { active: null, pct: 0, label: '', error: '', finishedAt: 0 }

function setProgress(libId, pct, label) {
  progress.active = libId
  progress.pct = Math.max(0, Math.min(100, Math.round(pct)))
  progress.label = label
}

function log(libId, line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, `${libId}.log`), `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

function sha256File(file, onPct) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const total = fs.statSync(file).size || 1
    let done = 0
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 })
    s.on('data', (b) => {
      h.update(b)
      done += b.length
      if (onPct) onPct(done / total)
    })
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

function copyWithProgress(src, dest, onPct) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(src).size || 1
    let done = 0
    const rs = fs.createReadStream(src, { highWaterMark: 1 << 20 })
    const ws = fs.createWriteStream(dest)
    rs.on('data', (b) => {
      done += b.length
      if (onPct) onPct(done / total)
    })
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('close', resolve)
    rs.pipe(ws)
  })
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (b) => (out += b))
    p.stderr.on('data', (b) => {
      err += b
      const m = /PROGRESS (\d+) ?(.*)/.exec(String(b))
      if (m && opts.onProgress) opts.onProgress(Number(m[1]), m[2].trim())
    })
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, opts.timeout || 600_000)
    let settled = false
    const finish = (code) => { if (settled) return; settled = true; clearTimeout(t); try { p.kill('SIGKILL') } catch {}; resolve({ code, out, err }) }
    p.on('exit', (code) => setTimeout(() => finish(code), 150))
    p.on('close', (code) => finish(code))
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: String(e.message) }) })
  })
}

// JDK 缺损依赖修复：先直跑，失败则补 LD_LIBRARY_PATH，再不行用 jlink 重编一个完整运行时。
export async function repairJdk(files) {
  const bin = path.join(files, 'bin')
  const notes = []
  const tryJava = async (env) => run(path.join(bin, 'java'), ['-version'], { env: { ...process.env, ...env }, timeout: 30_000 })
  let r = await tryJava({})
  notes.push(`java -version -> ${r.code === 0 ? 'ok' : 'fail'}`)
  if (r.code !== 0) {
    r = await tryJava({ LD_LIBRARY_PATH: path.join(files, 'lib') + ':' + path.join(bin) })
    notes.push(`retry with LD_LIBRARY_PATH -> ${r.code === 0 ? 'ok' : 'fail'}`)
  }
  const modules = fs.existsSync(path.join(files, 'lib', 'modules'))
  const hasJavac = fs.existsSync(path.join(bin, 'javac'))
  const hasJlink = fs.existsSync(path.join(bin, 'jlink'))
  notes.push(`modules=${modules} javac=${hasJavac} jlink=${hasJlink}`)

  // 模块表缺失时用 jlink 重建完整运行时（含 java.se 全家桶与编译/签名工具）。
  if (r.code !== 0 && hasJlink && modules) {
    const out = path.join(files, 'runtime-repaired')
    const fix = await run(path.join(bin, 'jlink'), [
      '--module-path', path.join(files, 'lib'),
      '--add-modules', 'ALL-MODULE-PATH',
      '--no-header-files', '--no-man-pages',
      '--output', out,
    ], { timeout: 300_000 })
    notes.push(`jlink -> ${fix.code === 0 ? 'ok' : 'fail ' + (fix.err || '').slice(0, 160)}`)
    if (fix.code === 0) {
      const j = await run(path.join(out, 'bin', 'java'), ['-version'], { timeout: 30_000 })
      notes.push(`repaired java -> ${j.code === 0 ? 'ok' : 'fail'}`)
      if (j.code === 0) return { ok: true, notes, java: path.join(out, 'bin', 'java') }
    }
  }
  return { ok: r.code === 0, notes, java: path.join(bin, 'java') }
}

export async function verifyLib(lib, files) {
  const p = (...a) => path.join(files, ...a)
  const exists = (...a) => fs.existsSync(p(...a))
  switch (lib.id) {
    case 'jdk21':
    case 'jdk27': {
      const r = await run(p('bin', 'java'), ['-version'], { timeout: 30_000 })
      return { ok: r.code === 0, detail: (r.err || r.out).split('\n')[0] }
    }
    case 'gradle': {
      const r = await run(p('bin', 'gradle'), ['-v','--no-daemon'], { timeout: 180_000, env: { ...process.env, JAVA_HOME: path.join(libDir(byId('jdk21')), 'files') } })
      if (r.code !== 0) return { ok: false, detail: `gradle -v code=${r.code} err=${(r.err || '').replace(/\s+/g, ' ').slice(0, 160)}` }
      const line = r.out.split('\n').find((l) => /^Gradle \d/.test(l.trim()))
      return { ok: !!line, detail: line || `no version line (out=${r.out.slice(0, 80).replace(/\s+/g, ' ')})` }
    }
    case 'sdk': {
      const aapt2 = p('build-tools', 'aapt2')
      if (!fs.existsSync(aapt2)) return { ok: false, detail: 'build-tools/aapt2 missing' }
      const r = await run(aapt2, ['version'], { timeout: 20_000 })
      const adb = exists('platform-tools', 'adb')
      return { ok: r.code === 0 || /aapt2|Android/i.test(r.out + r.err), detail: `aapt2 + adb=${adb}` }
    }
    case 'apktool': {
      const jar = [p('share', 'java', 'apktool.jar'), p('apktool.jar')].find((f) => fs.existsSync(f))
      if (!jar) return { ok: false, detail: 'apktool.jar missing' }
      const javaBin = [path.join(libDir(byId('jdk21')), 'files', 'bin', 'java'), p('jvm', 'bin', 'java')].find((f) => fs.existsSync(f))
      if (!javaBin) return { ok: true, detail: 'apktool.jar present (无可用 java)' }
      const r = await run(javaBin, ['-jar', jar, '--version'], { timeout: 90_000 })
      const out = `${r.out}\n${r.err}`
      const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(out.replace(/^WARNING.*$/gm, ''))
      return { ok: r.code === 0 && !!m, detail: m ? `apktool ${m[1]}` : `code=${r.code} ${out.replace(/\s+/g, ' ').slice(0, 120)}` }
    }
    case 'keystone': {
      const sp = path.join(files, 'usr', 'lib', 'python3', 'dist-packages')
      let so = ''
      try { so = fs.readdirSync(path.join(sp, 'keystone')).find((f) => f.endsWith('.so')) || '' } catch {}
      if (!so) return { ok: false, detail: 'libkeystone .so missing' }
      const abi = (so.match(/cpython-(\d+)/) || [])[1] || '?'
      const r = await run('python3', ['-c', 'import keystone;print(keystone.__version__)'], { timeout: 30_000, env: { ...process.env, PYTHONPATH: sp } })
      if (r.code === 0) return { ok: true, detail: `keystone ${(r.out || '').trim()} (cp${abi})` }
      return { ok: false, detail: `二进制为 cp${abi}，本机 Python 3.12 无法 import（已保留 .so）` }
    }
    case 'androguard': {
      const deps = path.join(files, 'pydeps')
      const pp = [files, deps].join(path.delimiter)
      const r = await run('python3', ['-c', 'import androguard;print(androguard.__version__)'], { timeout: 60_000, env: { ...process.env, PYTHONPATH: pp } })
      return { ok: r.code === 0, detail: (r.out || r.err).trim().split('\n').pop() }
    }
    case 'frida': {
      let so = null
      try { so = fs.readdirSync(files).find((f) => f.endsWith('.so')) } catch {}
      if (!so) return { ok: false, detail: 'no .so payload' }
      const size = fs.statSync(p(fs.readdirSync(files).find((f) => f.endsWith('.so')))).size
      return { ok: size > 1_000_000, detail: `${so} ${(size / 1048576).toFixed(1)} MB` }
    }
    case 'il2cpp':
      return { ok: exists('Il2CppDumper.dll'), detail: exists('Il2CppDumper.dll') ? 'Il2CppDumper.dll' : 'dll missing' }
    case 'webview': {
      const found = []
      const scan = (d, depth) => {
        let ents = []
        try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of ents) {
          if (e.isDirectory() && depth < 3) scan(path.join(d, e.name), depth + 1)
          else if (e.name === 'settings.gradle' || e.name === 'settings.gradle.kts') found.push(path.relative(files, path.join(d, e.name)))
        }
      }
      scan(files, 0)
      return { ok: found.length > 0, detail: found.length ? `${found.length} 套工程模板` : 'settings.gradle missing' }
    }
    case 'unitypy':
      return { ok: exists('UnityPy', '__init__.py'), detail: exists('UnityPy', '__init__.py') ? 'UnityPy package' : 'missing' }
    case 'r2pipe':
      return { ok: exists('python', 'r2pipe') || exists('r2pipe.py'), detail: exists('python', 'r2pipe') ? 'python/r2pipe' : 'missing' }
    default:
      return { ok: true, detail: 'no verifier' }
  }
}

export function isInstalled(id) {
  const st = readState()
  const m = st.installed[id]
  return !!(m && (m.status === 'ready' || m.status === 'degraded') && fs.existsSync(path.join(libDir(byId(id)), 'files')))
}

export async function installOne(id) {
  ensureDirs()
  const lib = byId(id)
  if (!lib) throw new Error(`未知库：${id}`)
  const dir = libDir(lib)
  const staging = path.join(dir, `files.tmp-${Date.now()}`)
  const cacheFile = path.join(CACHE, path.basename(lib.source.mirror))

  const state = readState()
  state.installed[id] = { ...(state.installed[id] || {}), status: 'installing', startedAt: new Date().toISOString() }
  writeState(state)
  log(id, `install start version=${lib.version}`)

  try {
    // 1) 依赖先装
    for (const dep of lib.deps) {
      if (!isInstalled(dep)) {
        setProgress(id, 1, `先安装依赖 ${dep}`)
        await installOne(dep)
      }
    }

    // 2) 拉取（本地镜像优先，缺则用缓存）
    setProgress(id, 2, '准备下载')
    if (!fs.existsSync(cacheFile)) {
      fs.mkdirSync(CACHE, { recursive: true })
      await copyWithProgress(lib.source.mirror, `${cacheFile}.part`, (r) => setProgress(id, 2 + r * 18, `下载中 ${Math.round(r * 100)}%`))
      fs.renameSync(`${cacheFile}.part`, cacheFile)
    } else {
      setProgress(id, 20, '使用本地缓存')
    }

    // 3) 校验 SHA256
    setProgress(id, 21, '校验 SHA256')
    const digest = await sha256File(cacheFile, (r) => setProgress(id, 21 + r * 9, `校验 ${Math.round(r * 100)}%`))
    if (digest !== lib.source.sha256) throw new Error(`SHA256 不匹配：期望 ${lib.source.sha256.slice(0, 12)}… 实得 ${digest.slice(0, 12)}…`)

    // 4) 隔离解压
    setProgress(id, 32, '隔离解压')
    fs.mkdirSync(staging, { recursive: true })
    const ex = await run('python3', [EXTRACTOR, lib.kind, cacheFile, staging], {
      timeout: 900_000,
      onProgress: (p, note) => setProgress(id, 32 + p * 0.33, `解压 ${note || p + '%'}`),
    })
    if (ex.code !== 0) throw new Error(`解压失败：${(ex.err || ex.out).slice(-300)}`)

    // 4.5) zip/tar 解出的脚本常丢可执行位，统一补齐（仅 bin 与 .sh）
    fixExecBits(staging)

    // 5) JDK 修复 / 常规校验
    setProgress(id, 68, '完整性校验')
    let post = null
    if (lib.post === 'pip-deps') {
      const out = path.join(staging, 'pydeps')
      const args = ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', out, ...lib.pipDeps]
      const pr = await run('python3', args, { timeout: 600_000 })
      log(id, `pip-deps ${pr.code} ${(pr.err || '').slice(-200)}`)
      if (pr.code !== 0) throw new Error(`依赖安装失败：${(pr.err || '').slice(-200)}`)
    }
    if (lib.post === 'jdk-repair') {
      post = await repairJdk(staging)
      log(id, `jdk-repair ${JSON.stringify(post.notes)}`)
      if (!post.ok) throw new Error(`JDK 修复失败：${post.notes.join('; ')}`)
    }
    const v = await verifyLib(lib, staging)
    log(id, `verify ${v.ok} ${v.detail}`)
    if (!v.ok && !lib.verifySoft) throw new Error(`校验未通过：${v.detail}`)

    // 6) 原子提交
    setProgress(id, 92, '写入清单')
    fs.rmSync(path.join(dir, 'files'), { recursive: true, force: true })
    fs.renameSync(staging, path.join(dir, 'files'))
    const files = countFiles(path.join(dir, 'files'))
    const manifest = writeManifest(lib, { verify: { ok: v.ok, detail: v.detail }, repair: post, files, cacheFile })

    const st2 = readState()
    st2.installed[id] = { status: v.ok ? 'ready' : 'degraded', version: lib.version, installedAt: manifest.installedAt, dir, files, sha256: lib.source.sha256, bytes: lib.bytes }
    writeState(st2)
    refreshIndex()
    setProgress(id, 100, '完成')
    progress.error = ''
    progress.finishedAt = Date.now()
    log(id, `install ok files=${files}`)
    return { ok: true, manifest }
  } catch (err) {
    // 回滚：删净暂存与半成品，只留一条错误记录
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch {}
    const st3 = readState()
    st3.installed[id] = { ...(st3.installed[id] || {}), status: 'error', error: String(err.message || err).slice(0, 300), failedAt: new Date().toISOString() }
    writeState(st3)
    progress.error = String(err.message || err)
    progress.finishedAt = Date.now()
    log(id, `install failed: ${progress.error}`)
    return { ok: false, error: progress.error }
  }
}

function fixExecBits(root) {
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.sh') || ['bin', 'build-tools', 'platform-tools', 'tools'].includes(path.basename(d))) {
        try { fs.chmodSync(p, 0o755) } catch {}
      }
    }
  }
  walk(root)
}

function countFiles(root) {
  let n = 0
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else n++
    }
  }
  walk(root)
  return n
}

export function uninstall(id) {
  const lib = byId(id)
  if (!lib) return { ok: false, error: '未知库' }
  const dir = libDir(lib)
  fs.rmSync(dir, { recursive: true, force: true })
  const st = readState()
  delete st.installed[id]
  writeState(st)
  refreshIndex()
  return { ok: true }
}

export async function installMany(ids, onUpdate) {
  ensureDirs()
  const results = []
  for (const id of ids) {
    const r = await installOne(id)
    results.push({ id, ...r })
    if (onUpdate) onUpdate(id, r)
  }
  progress.active = null
  return results
}

export { envCheck, LIBS }
