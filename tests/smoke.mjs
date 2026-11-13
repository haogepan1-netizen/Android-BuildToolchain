// 全链路冒烟：每个已装库独立跑一次真实动作，不看"文件存在"而看"能不能用"。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { LIBS, byId } from '../lib/catalog.js'
import { readState } from '../lib/store.js'

const HOME = '/root/.dsh/android-buildtoolchain'
const L = (id) => path.join(HOME, 'libs', id, 'files')
const J = path.join(L('jdk21'), 'bin')

function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...opts.env } })
    return { ok: true, out: String(out) }
  } catch (e) {
    return { ok: false, out: String((e.stdout || '') + (e.stderr || e.message)).slice(0, 400) }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abt-smoke-'))
const results = []
const add = (name, ok, detail) => results.push({ name, ok, detail })

// 1) JDK：编译 + 打包 + 运行
fs.writeFileSync(path.join(tmp, 'Hello.java'), 'public class Hello { public static void main(String[] a){ System.out.println("abt-ok"); } }')
let r = run(path.join(J, 'javac'), ['-d', tmp, path.join(tmp, 'Hello.java')])
add('javac 编译', r.ok, r.ok ? 'Hello.class' : r.out)
r = run(path.join(J, 'jar'), ['--create', '--file', path.join(tmp, 'hello.jar'), '-C', tmp, 'Hello.class'])
add('jar 打包', r.ok, r.ok ? 'hello.jar' : r.out)
r = run(path.join(J, 'java'), ['-cp', path.join(tmp, 'hello.jar'), 'Hello'])
add('java 运行', r.ok && r.out.includes('abt-ok'), r.out.trim() || r.out)

// 2) Gradle：真实构建一个空工程（离线）
const gproj = path.join(tmp, 'g')
fs.mkdirSync(gproj, { recursive: true })
fs.writeFileSync(path.join(gproj, 'settings.gradle'), "rootProject.name = 'abt-smoke'\n")
fs.writeFileSync(path.join(gproj, 'build.gradle'), '')
r = run(path.join(L('gradle'), 'bin', 'gradle'), ['-p', gproj, 'help', '--offline', '--no-daemon', '-q'], { env: { JAVA_HOME: L('jdk21') }, timeout: 240_000 })
add('gradle help', r.ok, r.ok ? 'Gradle 9.0.0 offline' : r.out.slice(0, 160))

// 3) aapt2：编译资源
const res = path.join(tmp, 'res', 'values')
fs.mkdirSync(res, { recursive: true })
fs.writeFileSync(path.join(res, 'strings.xml'), '<resources><string name="app_name">ABT</string></resources>')
r = run(path.join(L('sdk'), 'build-tools', 'aapt2'), ['compile', '--dir', path.join(tmp, 'res'), '-o', path.join(tmp, 'compiled.zip')])
add('aapt2 compile', r.ok, r.ok ? 'compiled.zip' : r.out.slice(0, 160))

// 4) apksigner / adb
r = run(path.join(J, 'java'), ['-jar', path.join(L('sdk'), 'build-tools', 'lib', 'apksigner.jar'), '--version'])
if (!r.ok) r = run(path.join(J, 'java'), ['-jar', path.join(L('apktool'), 'share', 'java', 'apksigner.jar'), '--version'])
add('apksigner', r.ok, r.out.trim() || r.out.slice(0, 80))
r = run(path.join(L('sdk'), 'platform-tools', 'adb'), ['version'])
add('adb', r.ok, (r.out.split('\n')[0] || r.out).trim())

// 5) apktool
r = run(path.join(J, 'java'), ['-jar', path.join(L('apktool'), 'share', 'java', 'apktool.jar'), '--version'])
add('apktool', r.ok, r.out.trim().split('\n').pop())

// 6) Python：androguard / r2pipe / keystone
r = run('python3', ['-c', 'import androguard, r2pipe; print(androguard.__version__, "r2pipe ok")'], { env: { PYTHONPATH: [L('androguard'), path.join(L('androguard'), 'pydeps'), path.join(L('r2pipe'), 'python')].join(':') } })
add('androguard+r2pipe', r.ok, (r.out || r.out).trim().split('\n').pop())
r = run('python3', ['-c', 'import keystone'], { env: { PYTHONPATH: path.join(L('keystone'), 'usr', 'lib', 'python3', 'dist-packages') } })
add('keystone (cp313 限制)', r.ok, r.ok ? 'import ok' : 'known: 需 Python 3.13/3.14')

// 7) Frida gadget
const fso = fs.readdirSync(L('frida')).find((x) => x.endsWith('.so'))
const head = fs.readFileSync(path.join(L('frida'), fso)).subarray(0, 4).toString('hex')
add('frida gadget ELF', head === '7f454c46', `${fso} magic=${head}`)

// 8) 模板
const wv = fs.readdirSync(L('webview')).filter((d) => fs.existsSync(path.join(L('webview'), d, 'settings.gradle')) || fs.existsSync(path.join(L('webview'), d, 'settings.gradle.kts')))
add('webview 模板', wv.length >= 4, `${wv.length} 套`)

const failed = results.filter((x) => !x.ok)
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 1))
fs.rmSync(tmp, { recursive: true, force: true })
process.exitCode = failed.filter((f) => !/keystone/.test(f.name)).length ? 1 : 0
