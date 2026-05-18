# 115网盘整理

115 网盘自动化媒体文件整理系统。自动扫描指定目录，识别影片/剧集，按规范命名移动到对应目录，方便 Plex / Emby / Jellyfin 刮削。

## 功能特性

- **自动识别**：本地文件名解析 → TMDB 搜索 → AI 兜底（可选），三段式管道，前一级失败才进入下一级
- **智能分组**：子目录内文件自动归为一组；散落在根的文件按解析出的 `(标题, 年份)` 二次分组
- **智能分类**：电影 / 剧集自动区分，支持多版本（不同分辨率/编码）共存
- **灵活命名**：模板化重命名，内置 Plex / Emby / Jellyfin 预设，支持 `{varName}`、`{:02d}` 格式化和 `{{tmdb-xxx}}` 字面量
- **残留清理**：处理完成后自动清理源目录下的空文件夹（含一次快速路径 + 慢速回退）
- **定时扫描**：可配置周期自动执行整理；同时定期巡检 cookie 健康度
- **二维码登录**：网页扫码登录 115，自动维护 cookie
- **离线下载**：从一段文本中提取磁力/链接，批量提交到 115 离线
- **回收站工具**：浏览、还原、清空网盘回收站
- **未匹配条目**：手动复核 AI/TMDB 未能识别的组，支持人工指定 TMDB ID 重跑
- **Telegram 通知 + 机器人**：成功 / 失败 / cookie 过期事件推送；支持多 bot；可通过 bot 远程触发任务
- **可选增强**：
  - ffprobe 读取真实分辨率/编码（默认关闭）
  - AI 识别（OpenAI 兼容接口）作为最后兜底（默认关闭）

## 快速开始

### Docker（推荐）

仓库内 `docker-compose.yml` 监听 `2333` 端口，按需调整：

```bash
docker compose up -d
```

或裸 docker：

```bash
docker run -d \
  --name 115arrange \
  -p 2333:2333 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  ghcr.io/ham0mer/115pan:latest
```

更新：

```bash
docker compose pull && docker compose down && docker compose up -d && docker compose logs -f
```

### 本地运行

```bash
npm install
npm start          # 生产
npm run dev        # 开发（文件变更自动重启）
npm run migrate    # 仅执行数据库迁移
```

要求 Node.js >= 18。

## 配置

首次启动会读取 `config/default.json`，建议复制为 `config/config.json` 后修改（`config.json` 不会被 release/镜像覆盖）：

```json
{
  "server":    { "port": 2333, "host": "0.0.0.0" },
  "admin":     { "username": "admin", "password": "请修改为强密码" },
  "database":  { "path": "./data/app.db" },
  "logs":      { "dir": "./logs", "retainDays": 30, "level": "info" },
  "scheduler": { "cookieRefreshHours": 12, "autoRetryHours": 24 }
}
```

> 首次登录后，密码会以 bcrypt 哈希存入数据库，明文配置不再生效。JWT 密钥同样持久化到数据库。

其余运行时配置全部在 Web 界面维护，存储于 SQLite：

| 配置项 | 内容 |
| --- | --- |
| 整理配置 | 源 CID / 电影 CID / 剧集 CID、扩展名白名单、最小视频体积、定时间隔等 |
| TMDB | API Key、语言、地区 |
| AI | OpenAI 兼容 base_url、模型名、密钥（仅做兜底识别） |
| 命名模板 | 电影/剧集/季文件夹模板，可选预设 |
| Telegram | 多 bot 管理，事件订阅 |

## 使用流程

1. 访问 `http://<server>:2333`，用配置中的账号登录
2. **115 账号** → 扫码登录
3. **TMDB 配置** → 填写 API Key（可选填语言、地区）
4. **整理配置** → 设置源目录 CID、电影/剧集目标目录 CID、扩展名过滤、最小视频大小
5. **命名模板** → 选预设或自定义
6. **手动运行** 测试一次，在「日志」和「未匹配」中确认结果
7. 满意后开启 **定时任务**；如需推送可配置 **Telegram**

## 命名模板速查

模板引擎支持：

- `{title}`、`{year}`、`{tmdbId}`、`{season}`、`{episode}`、`{resolution}`、`{codec}`、`{audio}`、`{hdr}` 等变量（取决于解析/识别结果）
- 格式化：`{episode:02d}` → `01`、`02` ……
- 字面花括号：`{{tmdb-{tmdbId}}}` → `{tmdb-271110}`（Plex/Emby/Jellyfin 识别用）
- 空变量周围的分隔符会自动收敛，不会出现 `Name -  - 1080p` 这种缝隙

预设见 [src/services/template.js](src/services/template.js) 末尾的 `PRESETS`。

## 数据库与迁移

- 默认存储为 `data/app.db`（sql.js，纯 JS SQLite，单文件持久化，写入 300 ms 防抖）
- Schema 由 `src/migrations/` 下按文件名顺序的 `.sql` 文件管理，新增字段请加新文件（如 `003_xxx.sql`），**不要修改已存在的迁移**
- 单独执行迁移：`npm run migrate`

## 技术栈

- 后端：Node.js + Express
- 数据库：sql.js（纯 JS SQLite，单文件持久化）
- 前端：原生 JS SPA，无构建步骤，hash 路由
- 容器：基于官方 Node Alpine 镜像

## 目录结构

```
src/
  server.js          入口
  migrate.js         独立执行迁移
  migrations/        SQL 迁移（按文件名顺序）
  routes/            REST 路由（auth / 115 / config / tasks / tmdb / ai / templates / telegram / recycle 等）
  services/
    db.js            sql.js 包装（同步式 API）
    organizer.js     核心整理流程
    parser.js        文件名解析（纯正则管道）
    template.js      命名模板渲染
    115.js           115 API 客户端（统一重试 / 429 退避 / 鉴权判定）
    scheduler.js     定时任务（cookie 巡检 + 周期整理）
public/              前端 SPA（无构建）
config/              配置
data/                数据库（自动生成）
logs/                日志（自动生成）
```

## FAQ

**为什么扫描完成但没移动文件？**
看日志里的「分组完成: N 个媒体单元」与「未匹配」页。N=0 说明根本没识别出可处理的组；如果有组进了 `unmatched`，请手动指定 TMDB ID 重试。

**多版本同片如何处理？**
`placeVideo()` 在目标目录已存在同片时，会按分辨率/编码差异作为不同版本共存（命名带版本后缀），而不是覆盖。

**Cookie 过期了？**
配置 Telegram 后会推送，也可在网页端「115 账号」重新扫码。Scheduler 会按 `cookieRefreshHours` 周期做健康检查。

**能否禁用清理空目录？**
目前总是执行；空目录清理使用快速路径，失败自动回退到逐级递归。

## 免责声明

本项目仅供学习交流使用，请遵守 115.com 用户协议。使用产生的一切后果由使用者自行承担。

## License

MIT
