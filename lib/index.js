// Android-BuildToolchain — on-demand APK build chain for dsh-go.
// The app only draws views; everything here runs in the DSH engine (Node).
import { LIBS, byId } from './catalog.js'
import { readState, writeState, envCheck, summary, readManifest, libDir } from './store.js'
import { installMany, uninstall, progress, isInstalled } from './installer.js'
import { noticeView, toolchainView, libsView } from './views.js'
import { scanV4, fixV4, v4Summary } from './v4guard.js'

export const name = 'local-android-buildtoolchain'

let envCache = { at: 0, val: null }
function env() {
  if (!envCache.val || Date.now() - envCache.at > 30_000) envCache = { at: Date.now(), val: envCheck() }
  return envCache.val
}

function selectedList() {
  const st = readState()
  return Array.isArray(st.selected) ? st.selected.filter((id) => byId(id)) : []
}

function tailFor(id, z) {
  const st = readState()
  const rec = st.installed[id]
  if (progress.active === id) return z ? `安装中 ${progress.pct}%` : `${progress.pct}%`
  if (rec?.status === 'ready') return z ? `已装 ${rec.version}` : `ok ${rec.version}`
  if (rec?.status === 'degraded') return z ? '已装(受限)' : 'limited'
  if (rec?.status === 'error') return z ? '失败' : 'failed'
  const sel = selectedList().includes(id)
  return sel ? (z ? '已勾选' : 'selected') : (z ? '未装' : 'not installed')
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const z = (scope, caps) => !String(caps?.locale || '').startsWith('en')

    // 状态条：输入框上方一行，3 秒级刷新
    ctx.dshGo.strip('status', (scope, emit, caps) => {
      const { done, total } = summary()
      const tick = () => {
        const s = summary()
        const busy = progress.active
        if (busy) {
          emit({ text: z(scope, caps) ? `安装 ${byId(busy)?.id || ''} ${progress.pct}%` : `Installing ${progress.pct}%`, icon: 'wrench', tone: 'info' })
        } else {
          emit({ text: z(scope, caps) ? `构建链 ${s.done}/${s.total}` : `Toolchain ${s.done}/${s.total}`, icon: 'wrench', tone: s.done ? 'good' : 'muted' })
        }
      }
      tick()
      const t = setInterval(tick, 3000)
      return () => clearInterval(t)
    })

    // 主面板：环境体检 + 已装清单 + 实时进度
    ctx.dshGo.panel('toolchain', {
      view: toolchainView,
      data: (scope, emit, caps) => {
        const tick = () => {
          const e = env()
          const s = summary()
          const busy = progress.active
          const t = tailFor
          emit({
            envTone: e.hardBlock ? 'bad' : 'info',
            envText: e.hardBlock
              ? (z(scope, caps) ? '准入未通过，安装已礼貌中止' : 'Gate failed, install declined')
              : (z(scope, caps) ? '环境可用 · proot 模拟（无完整 Linux 环境）' : 'Usable · proot, not full Linux'),
            done: `${s.done}/${s.total}`,
            v4: v4Summary(),
            status: busy ? `${busy} · ${progress.pct}% · ${progress.label}` : (progress.error ? `上次失败：${progress.error.slice(0, 40)}` : (z(scope, caps) ? '空闲' : 'idle')),
            home: '~/.dsh/android-buildtoolchain',
            pct: busy ? progress.pct : (progress.error ? 0 : 100 * (s.done / Math.max(1, s.total))),
            pctLabel: busy ? (progress.label || '安装中') : (z(scope, caps) ? '就绪' : 'ready'),
            pctCaption: busy ? `${busy}` : (z(scope, caps) ? '勾选库后才会下载' : 'libraries install on demand'),
            pctTone: progress.error ? 'bad' : (busy ? 'info' : 'good'),
            rows: s.done === 0
              ? [{ title: z(scope, caps) ? '尚未安装任何库' : 'No library yet', subtitle: z(scope, caps) ? '去「库选择」勾选需要的工具' : 'Open Libraries to pick one', icon: 'info' }]
              : LIBS.filter((l) => isInstalled(l.id)).map((l) => ({
                  title: `${l.title[z(scope, caps) ? 'zh' : 'en']} ${l.version}`,
                  subtitle: `${l.source.license} · ${l.source.sha256.slice(0, 10)}…`,
                  trailing: tailFor(l.id, z(scope, caps)),
                  icon: 'folder',
                  tone: 'good',
                })),
          })
        }
        tick()
        const t = setInterval(tick, 1500)
        return () => clearInterval(t)
      },
      actions: {
        'open-libs': () => ({ open: 'panel:libs' }),
        'open-notice': () => ({ open: 'panel:notice' }),
        refresh: () => ({ refresh: true, toast: '已刷新' }),
        'v4-scan': () => {
          const r = scanV4(true)
          return { toast: r.ok ? 'V4 协议正常' : `发现 ${r.hits.length} 处旧格式`, refresh: true }
        },
        'v4-fix': () => {
          const r = fixV4()
          return { toast: r.changed.length ? `已适配 ${r.changed.length} 个文件` : '无需适配', refresh: true }
        },
      },
    })

    // 须知页
    ctx.dshGo.panel('notice', {
      view: noticeView,
      actions: { 'open-libs': () => ({ open: 'panel:libs' }) },
    })

    // 库选择页：勾选 → 安装，逐个校验、失败回滚
    ctx.dshGo.panel('libs', {
      view: libsView,
      data: (scope, emit, caps) => {
        const tick = () => {
          const obj = { selected: selectedList() }
          for (const l of LIBS) obj[`t_${l.id}`] = tailFor(l.id, z(scope, caps))
          emit(obj)
        }
        tick()
        const t = setInterval(tick, 2000)
        return () => clearInterval(t)
      },
      actions: {
        toggle: (scope, event) => {
          const id = event?.args?.lib
          if (!byId(id)) return { toast: '未知库' }
          const st = readState()
          const sel = new Set(selectedList())
          sel.has(id) ? sel.delete(id) : sel.add(id)
          st.selected = [...sel]
          writeState(st)
          return { refresh: true, toast: `${byId(id).title.zh} ${sel.has(id) ? '已勾选' : '已取消'}` }
        },
        clear: () => {
          const st = readState()
          st.selected = []
          writeState(st)
          return { refresh: true, toast: '已清空勾选' }
        },
        install: async () => {
          const e = env()
          if (e.hardBlock) return { toast: '准入未通过，已礼貌回绝安装' }
          if (progress.active) return { toast: '已有安装进行中' }
          const ids = selectedList()
          if (!ids.length) return { toast: '先勾选要安装的库' }
          // 后台执行，面板靠 data 轮询进度；失败自动回滚
          installMany(ids, () => {}).catch(() => {})
          return { toast: `开始安装 ${ids.length} 个库`, refresh: true }
        },
        'open-toolchain': () => ({ open: 'panel:toolchain' }),
      },
    })
  })
}
