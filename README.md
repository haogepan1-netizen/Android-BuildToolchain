# Android-BuildToolchain

> 在 DSH 里按需搭建 Android APK 构建链：安装框架不下任何库，勾选哪个才装哪个。
> 每个库独立解压、SHA256 校验、失败整目录回滚、写 `manifest.json` 可追溯。

[![dsh-go plugin](https://img.shields.io/badge/dsh--go-plugin-0.4.0-blue)](https://github.com/haogepan1-netizen)

## 为什么

手机上的构建环境经常是「一把梭装完，缺什么不知道，坏了没法修」。这个插件把构建链拆成 13 个独立单元：

- **框架零依赖**：装插件只写三个 UI 面板，不下载任何二进制。
- **按需拉取**：勾选 → 本地镜像拉取 → SHA256 校验 → 隔离目录解压 → 结果校验 → 原子提交。
- **失败回滚**：任何一步失败，暂存目录整个删除，不留半成品。
- **100% 可追溯**：`libs/<id>/manifest.json` 记录版本、上游、镜像、SHA256、许可、安装时间、校验与修复结果。
- **JDK 自愈**：JDK 21 / 27 装完自动体检，必要时用 `jlink` 重建完整运行时。

## 界面

| 位置 | 内容 |
| --- | --- |
| 对话详情页 · 插件页签 | 「构建工具链」：环境体检、已装清单、实时进度 |
| 全部功能 | 「安装前须知」「库选择」 |
| 输入框上方状态条 | `构建链 3/13` 或 `安装 gradle 42%` |
| 输入框「+」工具 | 「工具链」直达面板 |

「安装前须知」明确标注本机 **无完整 Linux 环境**（proot 模拟）；准入自检不通过时礼貌回绝并引导移除。

## 目录

```
~/.dsh/android-buildtoolchain/
├── index.json                # 汇总清单
├── state.json                # 运行态（已装/勾选/错误）
├── cache/                    # 下载缓存（SHA256 已校验）
├── logs/<id>.log             # 每库安装日志
└── libs/<id>/
    ├── manifest.json         # 溯源记录（见 schemas/manifest.schema.json）
    └── files/                # 解压后的载荷
```

## 库清单

| id | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| `jdk21` | 21.0.12.1 | GPLv2+CE | LTS，构建主力 |
| `jdk27` | 27-ea | GPLv2+CE | 预览版，仅验证 |
| `gradle` | 9.0.0 | Apache-2.0 | 依赖 jdk21 |
| `sdk` | static-aarch64 | Android SDK | aapt2 / zipalign / apksigner |
| `apktool` | toolkit | mixed | 反编译 / 重打包 |
| `keystone` | 0.9.2 | GPLv2 | arm64 汇编引擎 |
| `androguard` | 4.1.4 | Apache-2.0 | APK 静态分析 |
| `frida` | 17.26.2 | LGPL-2.1 | Gadget arm64 |
| `il2cpp` | 6.7.46 | MIT | Il2CppDumper |
| `webview` | main | Apache-2.0 | WebView 工程模板 |
| `unitypy` | master | MIT | Unity 资源解析 |
| `r2pipe` | master | MIT | radare2 脚本桥 |

## 实现

```
lib/
├── catalog.js      # 库目录：版本、来源、SHA256、依赖、校验规则
├── store.js        # 状态/清单读写 + 准入自检 + 原子写
├── installer.js    # 拉取→校验→隔离解压→体检→原子提交→回滚
├── extract.py      # 隔离解压（zip/tar.gz/tar.xz/xz/deb），全程限定在目标目录
├── views.js        # 三个面板的视图
└── index.js        # 清单声明与事件处理
```

安装流程：

```
依赖检查 → 拉取到 cache/ → SHA256 → 解压到 files.tmp-<ts>/
→ JDK 体检/修复 → 目标校验 → 原子 rename 到 files/ → 写 manifest.json → 更新 index.json
     ↘ 任一步失败：rm -rf files.tmp-<ts>，state 记 error，其余库不受影响
```

## 安装

```sh
dsh plugin --profile web add /path/to/Android-BuildToolchain
```

装上即生效。改动 `lib/` 后需在 App 的「引擎」页重启引擎。

## 测试

```sh
node tests/install-one.mjs jdk21   # 单库全链路安装 + 校验
node tests/smoke.mjs              # 全部已装库冒烟测试
```

## 许可

MIT（本插件）。各库沿用其原始许可，逐一见 `manifest.json` 的 `source.license`。
