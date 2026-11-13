# V4 消息协议适配（防翻车铁律）

## 报错特征

```
format v4 message requires a producer-owned source kind
```

含义：v4 会话要求消息 `source.kind` 是**生产者自有**的标识（如 `runtime-context`、`tool`、`compact-basic`），
不允许仍是旧格式的裸 `"plugin"`。

宿主里的触发器在 `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`：

```js
if (kind === "plugin") return rewritePluginSource(source, seq, role)   // 迁移期合法
...
throw new SessionFormatError("format v4 message requires a producer-owned source kind")  // 生产期非法
```

## 处置顺序（不可颠倒）

1. **改源码**：在 `node_modules` 里定位报错插件，全局搜索 `{ kind: 'plugin' }` / `kind: "plugin"`，
   改成 `{ kind: 'plugin:<插件名>' }`。本插件的 `lib/v4guard.js` 提供 `fixV4()`：
   命中文件先备份 `.v4bak`，再替换，只在插件自己的目录内动刀。
2. **加防护**：改源码无效时，安装 `dsh-plugin-guard` 拦截旧格式消息，避免主任务中断。
3. **绝对禁忌**：不卸载 `pluginwriter`、Java 工具链、`adb` 等核心插件；只改代码适配。

## 自检

- 面板「构建工具链」→ `V4 协议` 一行显示当前状态；
- 点「V4 自检」重扫；命中时再点一次可自动适配（`tests/v4-scan.mjs` 提供同一逻辑的命令行版）。

## 当前结论（2026-11-13）

扫描 `profiles/web/node_modules` 与 `dsh-go/plugins`：**未发现**以 `{ kind: 'plugin' }` 生产消息的插件。
宿主 `dsh-session-format-v1-to-v2` / `v2-to-v3` 与 jsonl 持久化里的同名写法属于**迁移期**合法代码，不在适配范围。
因此本机无需打补丁，防护网以「自检 + 一键适配」形式待命。
