// V4 防护网：扫描所有已装插件，找出仍以 { kind: 'plugin' } 生产消息的旧格式代码。
// 命中即报出文件与行号；无命中说明当前链路不会触发 "producer-owned source kind" 报错。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOTS = [
  '/root/.dsh/profiles/web/node_modules',
  '/root/.dsh/dsh-go/plugins',
  '/opt/dsh/node_modules/@deepseek-ai',
]

const PATTERNS = [
  /kind\s*:\s*['"]plugin['"]/g,
  /"source"\s*:\s*\{\s*"kind"\s*:\s*"plugin"/g,
  /'source'\s*:\s*\{\s*'kind'\s*:\s*'plugin'/g,
]

function* walk(dir) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(p) }
    else if (/\.(js|mjs|cjs|ts)$/.test(e.name)) yield p
  }
}

const hits = []
for (const root of ROOTS) {
  for (const file of walk(root)) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    if (text.length > 4_000_000) continue
    for (const re of PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text))) {
        const line = text.slice(0, m.index).split('\n').length
        hits.push({ file, line, snippet: text.slice(m.index, m.index + 40).replace(/\s+/g, ' ') })
      }
    }
  }
}

console.log(JSON.stringify({ scanned: true, hits: hits.length, detail: hits.slice(0, 20) }, null, 1))
if (hits.length) process.exitCode = 2
