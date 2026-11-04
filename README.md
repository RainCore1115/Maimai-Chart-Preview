# MAIMAI-CHART-PRIVIEW 舞萌谱面预览

舞萌 DX 谱面预览独立页。谱面数据来自 [mai-charts](https://cnb.cool/project-baka86/mai-charts)（CNB），
谱面分析数据来自 [AWMC chart-preview API](https://wiki.awmc.team/dev/chart-preview-api)，
宴会场（宴谱）曲目与谱面文件来自 [落雪查分器](https://maimai.lxns.net) 的公开接口
（`/api/v0/maimai/song/list` + `assets2.lxns.net/maimai/chart/{id}.txt`，宴谱在 `.adx` 中用
`&inote_7` 标注，口径与常规谱不同，故单独走落雪），音频与曲绘同样复用落雪公开资源。

上游项目：[Pimeng/Maimai-Chart-Preview](https://github.com/Pimeng/Maimai-Chart-Preview)；
本仓库为 fork，改动内容：

- 曲目目录 / simai 谱面文本改为读取 `mai-charts` 数据（`.adx` 包内的 `maidata.txt`），不再直接访问落雪的谱面接口；
- 新增谱面分析面板（物量、NPS、难度分类、雷达轴、特征谱型），数据来自 chart-preview API；
- 新增数据同步脚本 + 定时工作流（GitHub Actions + CNB 流水线），增量更新谱面数据。

## 谱面下载站

`/download` 提供按版本打包的 `.zip`（内含 maidata.txt / 音频 / 曲绘），来源为夸克分享盘，
另有 `adx` 分享盘补丁并入目录（见下）。

大包无法塞进 CNB git（单文件 256MiB 上限）或 CNB raw（100MiB 上限），故包本体托管在
CNB Release 制品（`project-baka86/otoge-db`，tag `packs-mirror`，主源）与本仓库的
GitHub Release（tag `packs-mirror`，备用），由 Pages Functions 转发：

- `GET /api/pack/<num>`：流式中转，透传 Range（断点续传），下载名保持原文件名；
- `GET /api/pack/<num>?direct=1`：302 到加速直链；
- `GET /api/pack/<num>?json=1`：返回直链 JSON。

中转首选 CNB Release，其次 `ghfast.top`、`gh-proxy.com` 两个 GitHub 加速节点，均失效时回退官方
有时效直链（需 Pages 环境变量 `GH_TOKEN`，已配置为 secret）。CNB 侧 `adx-packs` 里另有 ≤256MiB 的归档包。

下载页的主下载项即完整内容（maidata.txt + 音频 + 曲绘 + pv），以解压目录形式托管在
`project-baka86/mai-charts` 仓库 `packs/<版本>/`（上游 `sulieripple/mai-charts` 只读，故落在 fork）；
「完整包下载」指向 `/-/git/archive/main/packs/<版本>.zip`（CNB 直链，按目录即时打包，不支持 Range），
「浏览」指向仓库目录。上文的 `/api/pack/<num>` 保留为备用镜像与断点续传通道。

镜像一致性：CNB Release 与本仓库 GitHub Release 的同名制品必须字节一致，可用 GitHub API 的
`digest`（sha256）与 CNB Release 详情里的 `hash_value` 逐项对数。发现不一致时用 GitHub 制品
重新覆盖上传（先落盘校验本地 sha256 与 `digest` 一致，再 `asset-upload-url` → `PUT` → `verify`），
随后重新对数并抽检 `unzip -t`。

页面上的单曲下载也走歌曲目录归档（`packs/<版本>/<曲目>.zip`，含音频/曲绘/maidata），
曲名与封面对照；`/api/chart/<chartFileId>?diff=<2..6>` 仍保留，返回单个谱面的 maidata 文本（页面已不再提供入口）。
曲绘封面取自 Bot 插件资源（`MAIMAIDX_PATH/static/mai/cover`），按 songId 缩成 `public/data/covers/<songId>.webp`；
`public/data/song-dirs.json` 是曲名 → 仓库目录的映射（当前 740 首 / 764 个曲目×类型条目）。

## 数据流

```
┌──────────────────────────────┐      ┌─────────────────────────────────┐
┌──────────────────────────────┐      ┌─────────────────────────────────┐
│ AWMC chart-preview API       │      │ CNB: project-baka86/mai-charts  │
│ 谱面列表 + configAnalysis    │      │ .adx 谱面包 + music_data.json   │
└──────────────┬───────────────┘      └────────────────┬────────────────┘
               │ 定时增量拉取（GitHub Actions，每天 04:23）             │
               │                                       │
               │            ┌──────────────────────────┴─────────────┐
               │            │ 落雪：song/list + assets2 chart/{id}.txt│
               │            │ 宴会场曲目与谱面文件（id >= 100000）    │
               │            └──────────────────────────┬─────────────┘
               ▼                                       ▼
      ┌──────────────────────────────────────────────────────────┐
      │ 本仓库：scripts/sync-preview-data.mjs                    │
      │  public/data/catalog.json    曲目目录（普谱 mai-charts、 │
      │                              宴谱落雪，共 1275 首）      │
      │  public/data/simai/*.txt     从 .adx / assets2 提取的     │
      │                              maidata.txt（含宴谱）       │
      │  public/data/analysis/*.json 谱面分析快照                │
      │  data/preview-sync/*.json    API 指纹缓存（供 CNB 流水线）│
      └──────────────────────────────┬───────────────────────────┘
                                     │ 提交 + 构建
                                     ▼
                        GitHub Pages（浏览器同源读取 public/data）
```

**为什么数据要镜像到 GitHub？** CNB 的 raw 文件接口需要鉴权且 CORS 只允许 `docs.cnb.cool`，
浏览器无法直接读取；因此由 CI 把 CNB `.adx` 解析成静态数据后提交到本仓库，随站点同源发布。

## 快速开始

```bash
pnpm install
pnpm dev        # 本地开发（默认读取 public/data 下已提交的静态数据）
pnpm build      # 构建（tsc + vite build）
```

部署到 GitHub Pages 时构建命令需带 `VITE_BASE=/<仓库名>/`（工作流已处理）。

## 数据同步

### 1. 预览站数据（GitHub Actions）

工作流：[`.github/workflows/sync-data.yml`](.github/workflows/sync-data.yml)

- 每天 **北京时间 04:23** 自动执行，也可在 Actions 页面手动触发（可勾选全量刷新）；
- 需要仓库 Secret：`CHART_PREVIEW_API_KEY`（chart-preview API Key，必填）；
- 可选 Secret：`CNB_TOKEN`（CNB 访问令牌；mai-charts 为公开仓库时可省略，私有仓库必填）；
- 可选 Variables：`MAI_CHARTS_REPO`（默认 `https://cnb.cool/project-baka86/mai-charts.git`）、`MAI_CHARTS_REF`（默认 `main`）。

本地运行：

```bash
export CHART_PREVIEW_API_KEY=mk_live_xxx
export CNB_TOKEN=xxx                      # 可选
node scripts/sync-preview-data.mjs         # 增量
node scripts/sync-preview-data.mjs --full  # 强制全量刷新谱面分析
node scripts/sync-preview-data.mjs --adx-dir ../mc-meta   # 用本地已 checkout 的 mai-charts 目录
node scripts/sync-preview-data.mjs --skip-api              # 跳过 chart-preview API，仅重建曲目/谱面数据
```

同步逻辑：

| 数据 | 来源 | 增量方式 |
| --- | --- | --- |
| `public/data/catalog.json` | mai-charts `data/music_data.json` + `.adx` 内 `&title/&artist/&lv_N/&des_N`；宴谱取落雪 song list 的 `difficulties.utage` | 曲目列表变化才重建 |
| `public/data/simai/{chartFileId}.txt` | `.adx` 包内 `maidata.txt`；宴谱取 `assets2.lxns.net/maimai/chart/{id}.txt` | 按 `.adx` blob / 上次快照比对，命中缓存跳过 |
| `public/data/analysis/*.json` | chart-preview API `/charts/:chartKey` | 按 `views/ratingCount/commentCount/correctionCount/levelLabel` 指纹比对 |
| `data/preview-sync/chart-index.json` | 同上（列表快照） | 每次全量列表 + 指纹 |

### 2. mai-charts 数据更新（CNB 流水线）

CNB fork 仓库 [project-baka86/mai-charts](https://cnb.cool/project-baka86/mai-charts) 中的
`.cnb.yml` 配置了每天 **21:20（北京时间）** 的定时任务（另有推送触发与手动触发）：
从预览站发布的数据（jsDelivr / GitHub Pages 镜像，失败自动回退）读取
`chart-index.json`、`chart-analysis.json.gz`、`catalog.json`，把
`data/chart_analysis/*.json`、`data/chart_preview_index.json`、`data/music_data.json`、
`data/music_chart.json` 增量更新并提交。

> ⚠️ CNB 的 **Fork 仓库默认不自动触发流水线**，需仓库管理员在
> **设置 → 云原生构建** 勾选「允许自动触发」一次，详见
> [cnb-template/README.md](cnb-template/README.md)。

## 目录结构

```
scripts/
  sync-preview-data.mjs     # 预览站数据同步（GitHub Actions 入口）
  sync-maicharts.mjs        # mai-charts 增量更新（CNB 流水线入口）
  lib/api.mjs               # chart-preview API 客户端
  lib/catalog.mjs           # 曲名归一化 / adx 匹配 / 目录生成
  lib/maicharts-source.mjs  # mai-charts 数据源（本地目录 / partial clone / CNB raw）
  lib/zip.mjs               # .adx（ZIP）解析，提取 maidata.txt
cnb-template/               # 复制到 mai-charts 仓库的 .cnb.yml 与说明
public/data/                # 生成的静态数据（提交到仓库，随站点发布）
data/preview-sync/          # API 指纹缓存与快照（提交到仓库，供 CNB 流水线读取）
```

## 已知限制

- 普谱目录只包含「mai-charts 中存在 `.adx` 谱面包」的曲目（约 1210 首）；宴会场曲目（65 首，
  id >= 100000）来自落雪曲库，谱面文件拉取失败的曲目会暂不纳入目录，保证点进去一定能预览。
- 音频（`assets2.lxns.net`）与曲绘（`assets.lxns.net`）仍来自落雪公开资源，若资源缺失仅影响播放/封面。
- chart-preview API 只有被用户浏览/提交过的谱面才有分析数据；没有分析数据的谱面仍可正常预览，只是不显示分析面板。
- CNB 定时任务的执行身份是「最后修改 crontab 配置的用户」，若该用户被移出仓库，定时任务会失败。
- CNB Fork 仓库默认不自动触发流水线（Git 推送/定时任务），需要在仓库设置里勾选「允许自动触发」。

## ⭐ Feature

- 落雪原有内容（谱面预览、播放控制、全屏、分享链接等）
- 新增：谱面分析面板、mai-charts 数据源、增量同步工作流

## 致谢

- LxnsNetwork
- [Lxns 的 舞萌查分器](//maimai.lxns.net)
- [ReactBits](//reactbits.dev/)
- [mai-charts](https://cnb.cool/sulieripple/mai-charts)
- [AWMC chart-preview API](https://wiki.awmc.team/dev/chart-preview-api)

> 所有内容和素材等均取自 [舞萌 DX API 文档 | maimai DX 查分器](https://maimai.lxns.net/docs/api/maimai#%E5%85%AC%E5%85%B1-api)
> 和 [GitHub 上的 maimai-prober-frontend 项目](https://github.com/Lxns-Network/maimai-prober-frontend/tree/main/src/pages/public/Chart/renderers)，
> 只是根据落雪的源码以及公开 API 做了一个独立页，其内容遵循上游的开源许可证。
