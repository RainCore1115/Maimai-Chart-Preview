# mai-charts 侧：chart-preview 数据定时增量更新

本目录是复制到 [mai-charts](https://cnb.cool/project-baka86/mai-charts)（CNB）仓库的流水线配置与脚本，
作用是把 [AWMC chart-preview API](https://wiki.awmc.team/dev/chart-preview-api) 的谱面数据
每天增量写入 mai-charts 仓库。

## 数据流

```
┌──────────────────────────────┐        ┌──────────────────────────────────────┐
│ GitHub Actions（每天 04:23）  │ Pages  │ CNB 流水线（每天 21:20）              │
│ 调用 chart-preview API       │ 镜像   │ 读取预览站发布的 API 快照              │
│ 增量拉取列表 + 谱面分析       │ ─────▶ │ data/chart_analysis/*.json（C）       │
│ 生成 public/data/* 并部署     │        │ data/chart_preview_index.json（B）    │
└──────────────────────────────┘        │ data/music_data.json 等级/谱师补充（B）│
                                        │ data/music_chart.json 等级标签（B）    │
                                        └──────────────────────────────────────┘
```

流水线默认从预览站发布的数据读取快照（按顺序尝试，失败自动回退）：

1. `https://cdn.jsdelivr.net/gh/RainCore1115/Maimai-Chart-Preview@main/public/data`
2. `https://raincore1115.github.io/Maimai-Chart-Preview/data`

只读取 3 个文件：`chart-index.json`、`chart-analysis.json.gz`（全部分析聚合，约 2.8MB）、`catalog.json`，
不依赖 GitHub git 协议，国内网络更稳定。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `.cnb.yml` | 流水线配置：`web_trigger`（手动）/ `push`（推送）/ `crontab: 20 21 * * *`（每天 21:20 北京时间） |
| `scripts/sync-maicharts.mjs` | 同步脚本（写入 data/chart_analysis、chart_preview_index、music_data、music_chart） |
| `scripts/lib/api.mjs` | chart-preview API 客户端（配置了 API Key 时使用） |
| `scripts/lib/catalog.mjs` | 等级解析等工具函数 |

写入内容：

- `data/chart_analysis/{songId}_{kind}_{difficulty}.json` + `_index.json`：每个谱面的完整分析（含 `configAnalysis`）；
- `data/chart_preview_index.json`：chart-preview API 谱面索引快照（含未收录进 mai-charts 的新曲目）；
- `data/music_data.json`：**已有曲目**的等级、谱师、BPM、艺术家增量补充；
- `data/music_chart.json`：已有曲目的难度等级标签同步。

> 默认**不会**向 `music_data.json` 添加缺少 `.adx` 包的新曲目（避免破坏站点下载链接），
> 新曲目完整记录在 `chart_preview_index.json` / `chart_analysis/` 中。
> 如需补入曲线数据，运行 `node scripts/sync-maicharts.mjs --add-new-songs`。

## 首次启用（重要）

CNB 出于安全考虑，**Fork 出来的仓库默认不自动触发流水线**（Git 推送、定时任务事件都不触发），
需要仓库管理员手动开启一次：

1. 打开 <https://cnb.cool/project-baka86/mai-charts/-/settings/build>
   （或仓库页面 → **设置** → **云原生构建**）；
2. 勾选 **「允许自动触发」**（如需让后续 fork 也自动触发，可同时勾选「Fork 的仓库默认允许自动触发」）；
3. 保存后，推送事件与每天 21:20 的定时任务才会按 `.cnb.yml` 执行。

也可以不用等定时任务，直接在流水线页面手动运行：
仓库页面 → **流水线** → 选择 `main` 分支 → 运行「手动同步谱面数据」（`web_trigger`）。

## 可选：让流水线直接调用 API

默认走预览站快照，无需配置任何密钥。如果希望 CNB 侧不依赖 GitHub，可直接调用 chart-preview API：

1. 新建一个 **密钥仓库**（CNB 私有仓库），添加文件 `env.prod.yml`：

   ```yaml
   CHART_PREVIEW_API_KEY: mk_live_xxxxxxxx
   ```

2. 在本仓库 `.cnb.yml` 顶部加入（把 `your-group/secret-repo` 换成实际路径）：

   ```yaml
   imports:
     - https://cnb.cool/your-group/secret-repo/-/blob/main/env.prod.yml
   ```

脚本检测到 `CHART_PREVIEW_API_KEY` 后会直接调用
`https://v.wmc.pub/api/v1`，不再读取预览站快照。

## 复制到 mai-charts 仓库

```bash
# 在 mai-charts 仓库根目录执行
mkdir -p scripts/lib
cp .cnb.yml .
cp scripts/sync-maicharts.mjs scripts/
cp scripts/lib/api.mjs scripts/lib/
cp scripts/lib/catalog.mjs scripts/lib/
git add .cnb.yml scripts
git commit -m "ci: 添加 chart-preview API 谱面数据定时同步"
git push
```

当前 fork 仓库已完成上述提交，提交号见历史记录。

## 手动运行（本地调试）

```bash
# 在 mai-charts 仓库根目录
node scripts/sync-maicharts.mjs --dry-run            # 只统计不写入
node scripts/sync-maicharts.mjs                       # 写入文件
node scripts/sync-maicharts.mjs --preview-dir ../Maimai-Chart-Preview  # 用本地预览站仓库
CHART_PREVIEW_API_KEY=mk_live_xxx node scripts/sync-maicharts.mjs        # 直接调 API
```

脚本退出码非 0 表示同步失败；流水线会在「提交」阶段用 `git add -A data/` + `[ci skip]` 提交，
不会循环触发。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 推送/定时任务没有触发流水线 | 按上面「首次启用」勾选「允许自动触发」 |
| 流水线报「所有镜像上都不可用」 | 预览站尚未部署完成，或网络无法访问 jsDelivr/GitHub Pages；可配置 `CHART_PREVIEW_API_KEY` 直接走 API |
| 数据没有变化 | 正常现象：脚本按指纹比对，无变化时以「没有数据变更」退出 |
| 提交后定时任务负责人变更 | 定时任务执行身份是最后修改 crontab 配置的用户，更换负责人后需重新提交一次 `.cnb.yml` |
