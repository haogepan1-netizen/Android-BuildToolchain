# manifests/

- 运行时清单在 `~/.dsh/android-buildtoolchain/libs/<id>/manifest.json`（每库一份，安装时原子写入）。
- `~/.dsh/android-buildtoolchain/index.json` 是汇总索引。
- 本目录在仓库里只放说明；`scripts/pack.mjs` 打包时会生成 `manifests/installed/*.json` 快照与
  `manifests/index.json`，随 `.tar.zst` 一起发布，用于证明构建机上的真实安装状态。
- 字段定义见 `schemas/manifest.schema.json`；没有 manifest 的目录不属于本工具链。
