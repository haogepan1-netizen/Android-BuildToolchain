// 单库全链路安装：拉取 → SHA256 → 隔离解压 → 体检 → 原子提交（失败回滚）。
// 用法：node tests/install-one.mjs jdk21
import path from 'node:path'
import { installOne, progress } from '../lib/installer.js'

const id = process.argv[2]
if (!id) {
  console.error('usage: node tests/install-one.mjs <library-id>')
  process.exit(2)
}
const timer = setInterval(() => {
  if (progress.active) console.error(`${progress.pct}% ${progress.label}`)
}, 3000)
const r = await installOne(id)
clearInterval(timer)
console.log(JSON.stringify({
  id,
  ok: r.ok,
  error: r.error,
  version: r.manifest?.version,
  files: r.manifest?.files,
  verify: r.manifest?.verify,
  repair: r.manifest?.repair?.notes,
}, null, 1))
process.exitCode = r.ok ? 0 : 1
