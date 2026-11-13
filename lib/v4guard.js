// V4 协议防护网：检测并（在需要时）适配旧格式 "{ kind: 'plugin' }" 消息源。
// 铁律顺序：先改源码 → 改不动才上 guard；绝不卸载核心插件。
import fs from 'node:fs'
import path from 'node:path'

const EXT = /\.(js|mjs|cjs)$/
// 只在"插件自己的目录"里找，不碰宿主迁移代码（v1→v2/v2→v3 里的旧格式是合法的）。
const PLUGIN_ROOTS = ['/root/.dsh/profiles/web/node_modules', '/root/.dsh/dsh-go/plugins']

let cache = { at: 0, value: null }

function packages(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 2) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (e.name.startsWith('@')) { walk(p, depth + 1); continue }
      if (fs.existsSync(path.join(p, 'package.json'))) out.push(p)
      if (e.name === 'node_modules') walk(p, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

function* jsFiles(dir) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* jsFiles(p) }
    else if (EXT.test(e.name)) yield p
  }
}

export function scanV4(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 60_000) return cache.value
  const hits = []
  for (const root of PLUGIN_ROOTS) {
    for (const dir of packages(root)) {
      for (const file of jsFiles(dir)) {
        let text = ''
        try { text = fs.readFileSync(file, 'utf8') } catch { continue }
        if (!text.includes('plugin')) continue
        const re = /kind\s*:\s*['"]plugin['"]\s*\}?/g
        let m
        while ((m = re.exec(text))) {
          const line = text.slice(0, m.index).split('\n').length
          hits.push({ file, line, pkg: path.basename(dir), snippet: text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ') })
        }
      }
    }
  }
  const value = { at: new Date().toISOString(), hits, ok: hits.length === 0 }
  cache = { at: Date.now(), value }
  return value
}

// 把 "{ kind: 'plugin' }" 改成 "{ kind: 'plugin:<插件名>' }"，先备份 .v4bak。
export function fixV4() {
  const { hits } = scanV4(true)
  const byPkg = new Map()
  for (const h of hits) {
    if (!byPkg.has(h.file)) byPkg.set(h.file, h.pkg)
  }
  const changed = []
  for (const [file, pkg] of byPkg) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const next = text.replace(/(kind\s*:\s*)(['"])plugin\2/g, (_, a, q) => `${a}${q}plugin:${pkg}${q}`)
    if (next !== text) {
      try {
        fs.copyFileSync(file, `${file}.v4bak`)
        fs.writeFileSync(file, next)
        changed.push(file)
      } catch {}
    }
  }
  cache = { at: 0, value: null }
  return { changed, hits: hits.length }
}

export function v4Summary() {
  const r = scanV4()
  return r.ok ? '正常（未发现旧格式）' : `发现 ${r.hits.length} 处以 kind:'plugin' 生产消息，需适配`
}
