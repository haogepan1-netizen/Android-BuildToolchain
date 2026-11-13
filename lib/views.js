// Views for the three panels. Pure JSON, drawn by the app.
import { LIBS } from './catalog.js'

const zh = (caps) => !String(caps?.locale || '').startsWith('en')

const NOTICE = {
  zh: [
    '一、环境说明：本插件在你的手机本地封装了一条 Android 构建链路。本机是 proot 模拟环境，没有完整 Linux 环境（无 systemd、受限 /proc），并非标准服务器发行版。',
    '二、能力边界：可做 APK 解包、重打包、签名、aapt2 资源编译、Gradle 构建验证与静态分析；不支持内核模块、原生 Docker、完整 NDK 交叉编译等依赖特权或完整 Linux 的功能。',
    '三、安装方式：安装框架本身不下载任何库。你在「库选择」里勾选哪一个，才拉取哪一个到本地，全部逐个 SHA256 校验，失败自动整目录回滚，不留半成品。',
    '四、空间与来源：全量约 1.2 GB。每库写入 manifest.json（版本、上游地址、镜像地址、SHA256、许可、安装时间），100% 可追溯。',
    '五、准入自检：启动时会检查可写目录、可执行位、归档工具与磁盘余量。若关键能力完全不可调用，插件会礼貌回绝安装并引导移除，不会强行留下残件。',
  ],
  en: [
    '1. This plugin wraps an Android build chain locally. The device is a proot-style environment without a full Linux userland (no systemd, restricted /proc).',
    '2. Scope: APK decode/rebuild, signing, aapt2, Gradle verification, static analysis. No kernel modules, Docker, or privileged NDK cross-builds.',
    '3. On-demand: the framework installs no library by default. Tick a library and only it is fetched, SHA256-verified, and rolled back entirely on failure.',
    '4. Size and traceability: ~1.2 GB for all. Every library gets manifest.json with version, upstream, mirror, SHA256, license and install time.',
    '5. Gate: startup checks writable storage, exec bit, archive tool and free space. If the basics are unavailable, installation is politely declined.',
  ],
}

export function noticeView(scope, caps) {
  const t = zh(caps) ? NOTICE.zh : NOTICE.en
  return {
    type: 'stack',
    title: zh(caps) ? '安装前须知' : 'Before you install',
    children: [
      { type: 'callout', tone: 'warn', text: zh(caps) ? '本机无完整 Linux 环境（proot 模拟），仅提供受限的 Android 构建能力。' : 'No full Linux userland here (proot). Only a restricted Android build chain is available.' },
      ...t.map((text) => ({ type: 'text', text })),
      { type: 'actions', items: [{ label: zh(caps) ? '去选择库' : 'Choose libraries', action: 'open-libs', style: 'primary' }] },
    ],
  }
}

export function toolchainView(scope, caps) {
  const z = zh(caps)
  return {
    type: 'stack',
    title: z ? '构建工具链' : 'Build toolchain',
    children: [
      { type: 'callout', tone: { $: 'data.envTone' }, text: { $: 'data.envText' } },
      {
        type: 'keyValue',
        items: [
          [z ? '已装' : 'Installed', { $: 'data.done' }],
          [z ? '状态' : 'Status', { $: 'data.status' }],
          [z ? '根目录' : 'Root', { $: 'data.home' }],
          ['V4 协议', { $: 'data.v4' }],
        ],
      },
      { type: 'progress', value: { $: 'data.pct' }, label: { $: 'data.pctLabel' }, caption: { $: 'data.pctCaption' }, tone: { $: 'data.pctTone' } },
      { type: 'list', items: { $: 'data.rows' } },
      {
        type: 'actions',
        items: [
          { label: z ? '库选择' : 'Libraries', action: 'open-libs', style: 'primary' },
          { label: z ? '刷新' : 'Refresh', action: 'refresh' },
          { label: z ? '须知' : 'Notice', action: 'open-notice' },
          { label: 'V4 自检', action: 'v4-scan' },
        ],
      },
    ],
  }
}

export function libsView(scope, caps) {
  const z = zh(caps)
  return {
    type: 'stack',
    title: z ? '按需选择' : 'Install on demand',
    children: [
      { type: 'text', tone: 'muted', text: z ? '勾选后才会下载并校验；未勾选不占空间。' : 'Only ticked libraries are fetched and verified.' },
      {
        type: 'list',
        items: LIBS.map((lib) => ({
          title: `${lib.title[z ? 'zh' : 'en']} · ${lib.version}`,
          subtitle: `${lib.source.sha256.slice(0, 16)}… · ${(lib.bytes / 1048576).toFixed(1)} MB`,
          trailing: { $: `data.t_${lib.id}` },
          action: { id: 'toggle', args: { lib: lib.id } },
        })),
      },
      {
        type: 'actions',
        items: [
          { label: z ? '开始安装所选' : 'Install selected', action: 'install', style: 'primary' },
          { label: z ? '全部取消' : 'Clear', action: 'clear' },
          { label: z ? '返回' : 'Back', action: 'open-toolchain' },
        ],
      },
    ],
  }
}
