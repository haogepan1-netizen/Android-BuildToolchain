// 打包：源码 + 已装清单快照 + BUILD-INFO → Android-BuildToolchain.tar.zst
// 只收源码与溯源记录，不收 ~/.dsh 下的实际二进制（体积与隐私）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { LIBS } from '../lib/catalog.js'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const OUT = '/root/abtoolchain-build/out'
const STAGE = path.join(OUT, 'Android-BuildToolchain')
const HOME = '/root/.dsh/android-buildtoolchain'
const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version

const SKIP = new Set(['node_modules', '.git', 'out', 'work', '*.tar.zst'])

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

fs.rmSync(STAGE, { recursive: true, force: true })
copyDir(REPO, STAGE)

// 溯源快照
const manDir = path.join(STAGE, 'manifests', 'installed')
fs.mkdirSync(manDir, { recursive: true })
const rows = []
for (const lib of LIBS) {
  const f = path.join(HOME, 'libs', lib.id, 'manifest.json')
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, path.join(manDir, `${lib.id}.json`))
    const m = JSON.parse(fs.readFileSync(f, 'utf8'))
    rows.push({ id: lib.id, version: m.version, sha256: m.source.sha256, license: m.source.license, verify: m.verify, files: m.files })
  } else {
    rows.push({ id: lib.id, version: lib.version, sha256: lib.source.sha256, license: lib.source.license, verify: { ok: false, detail: 'not installed in this snapshot' } })
  }
}
const buildInfo = {
  name: 'Android-BuildToolchain',
  version,
  builtAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version, os: os.release() },
  libraries: rows,
  notes: 'manifests/installed/*.json 为构建机上的真实安装记录快照；二进制本体不入包。',
}
fs.writeFileSync(path.join(STAGE, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2))
fs.writeFileSync(path.join(STAGE, 'manifests', 'index.json'), JSON.stringify({ schema: 'abt.manifest/1', generatedAt: buildInfo.builtAt, count: rows.length, libs: rows }, null, 2))

// tar.zst（zstd 无 CLI，用 python 的 zstandard 库）
const tarPath = path.join(OUT, 'Android-BuildToolchain.tar')
execFileSync('tar', ['-cf', tarPath, '-C', OUT, 'Android-BuildToolchain'])
const zst = path.join(OUT, 'Android-BuildToolchain.tar.zst')
execFileSync('python3', ['-c', `
import zstandard, sys, shutil
c = zstandard.ZstdCompressor(level=19)
with open("${tarPath}", "rb") as fi, open("${zst}", "wb") as fo:
    c.copy_stream(fi, fo)
`], { stdio: 'inherit' })
fs.rmSync(tarPath)

const hash = crypto.createHash('sha256').update(fs.readFileSync(zst)).digest('hex')
fs.writeFileSync(`${zst}.sha256`, `${hash}  Android-BuildToolchain.tar.zst\n`)
console.log(JSON.stringify({ zst, bytes: fs.statSync(zst).size, sha256: hash, version }, null, 1))
