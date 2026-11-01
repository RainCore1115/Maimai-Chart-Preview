# mai-charts 数据同步（CNB 定时流水线）

本目录是给 **mai-charts 仓库**（CNB fork）使用的流水线模板。把它复制到 mai-charts 仓库根目录即可。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `.cnb.yml` | CNB 定时任务（每天 21:20）与页面手动触发流水线 |
| `scripts/sync-maicharts.mjs` | 数据同步脚本（与预览站仓库同源，复制自 `Maimai-Chart-Preview` 仓库） |
| `scripts/lib/api.mjs` | chart-preview API 客户端 |
| `scripts/lib/catalog.mjs` | maidata / 曲目目录工具 |

同步脚本默认**不会**向 `music_data.json` 添加 adx 尚未提供的新曲目（避免破坏站点下载链接），
新曲目会完整记录在 `data/chart_preview_index.json` 与 `data/chart_analysis/`。
如需把新曲目以最小字段补进 `music_data.json`，加 `--add-new-songs` 参数。

## 部署步骤

```bash
# 1. 在 mai-charts（CNB fork）仓库根目录执行：
mkdir -p scripts/lib
cp /path/to/Maimai-Chart-Preview/cnb-template/.cnb.yml .cnb.yml
cp /path/to/Maimai-Chart-Preview/scripts/sync-maicharts.mjs scripts/
cp /path/to/Maimai-Chart-Preview/scripts/lib/api.mjs scripts/lib/
cp /path/to/Maimai-Chart-Preview/scripts/lib/catalog.mjs scripts/lib/

# 2. 提交并推送
git add .cnb.yml scripts/
git commit -m "ci: 添加 chart-preview API 数据定时同步流水线"
git push
```

推送后，CNB 会自动解析 `.cnb.yml` 中的 `crontab` 配置（定时任务以最后修改该配置的用户身份执行）。

## 数据流

```
┌─────────────────────────────┐        ┌──────────────────────────────────────┐
│ GitHub Actions（每天 04:23） │        │ CNB 流水线（每天 21:20）              │
│ 调用 chart-preview API      │ 快照    │ 读取预览站仓库的 API 快照              │
│ 增量拉取列表 + 谱面分析      │ ─────▶ │ data/chart_analysis/*.json（C）       │
│ 生成 public/data/*          │        │ data/chart_preview_index.json（B）    │
│ data/preview-sync/*.json    │        │ data/music_data.json 等级/谱师补充（B）│
└─────────────────────────────┘        │ data/music_chart.json 等级标签（B）    │
                                       └──────────────────────────────────────┘
```

CNB 流水线的 `CNB_TOKEN` 由平台自动注入，作用域限定在当前仓库，无需额外配置密钥。

## 可选：在 CNB 内直接调用 API

如果希望 CNB 流水线不依赖 GitHub 快照、直接调用 chart-preview API：

1. 在 CNB 创建一个**密钥仓库**，添加文件 `env.prod.yml`：

   ```yaml
   CHART_PREVIEW_API_KEY: "mk_live_xxx"
   ```

2. 在 `.cnb.yml` 的 job 中加入：

   ```yaml
   imports:
     - https://cnb.cool/<你的组织>/<密钥仓库>/-/blob/main/env.prod.yml
   ```

脚本检测到 `CHART_PREVIEW_API_KEY` 环境变量时会直接调用 API，否则读取预览站快照。
