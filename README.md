# 115网盘整理

115 网盘自动化媒体文件整理系统。自动扫描指定目录，识别影片/剧集，按规范命名移动到对应目录，方便 Plex / Emby / Jellyfin 刮削。

## 功能特性

- **自动识别**：本地文件名解析 → TMDB 搜索 → AI 兜底（可选）
- **智能分类**：电影 / 剧集自动区分，支持多版本（不同分辨率/编码）共存
- **灵活命名**：模板化重命名，内置 Plex / Emby / Jellyfin 预设
- **定时扫描**：可配置周期自动执行整理
- **二维码登录**：网页扫码登录 115，自动维护 cookie
- **可选增强**：
  - ffprobe 读取真实分辨率/编码
  - AI 识别（OpenAI 兼容接口）作为最后兜底
  - Telegram 通知（成功 / 失败 / cookie 过期）

## 快速开始

### Docker（推荐）

```bash
docker run -d \
  --name 115arrange \
  -p 3000:3000 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  ghcr.io/ham0mer/115pan:latest
```

或使用 `docker-compose.yml`：

```bash
docker compose up -d
```

### 本地运行

```bash
npm install
npm start          # 生产
npm run dev        # 开发（文件变更自动重启）
```

要求 Node.js >= 18。

## 配置

首次启动会读取 `config/default.json`，建议复制为 `config/config.json` 后修改（`config.json` 不会被覆盖）：

```json
{
  "server":    { "port": 3000, "host": "0.0.0.0" },
  "admin":     { "username": "admin", "password": "请修改为强密码" },
  "database":  { "path": "./data/app.db" },
  "logs":      { "dir": "./logs", "retainDays": 30, "level": "info" },
  "scheduler": { "cookieRefreshHours": 12, "autoRetryHours": 24 }
}
```

> 首次登录后，密码会以 bcrypt 哈希存入数据库，明文配置不再生效。

其他运行时配置（TMDB Key、AI、Telegram、命名模板、源/目标目录等）全部在 Web 界面中维护，存储于 SQLite。

## 使用流程

1. 访问 `http://<server>:3000`，用配置中的账号登录
2. **115 账号** → 扫码登录
3. **TMDB 配置** → 填写 API Key（可选填语言、地区）
4. **整理配置** → 设置源目录 CID、电影/剧集目标目录 CID、扩展名过滤
5. **命名模板** → 选预设或自定义
6. **手动运行** 测试一次，确认结果后再开启 **定时任务**

## 技术栈

- 后端：Node.js + Express
- 数据库：sql.js（纯 JS SQLite，单文件持久化）
- 前端：原生 JS SPA，无构建步骤
- 容器：基于官方 Node Alpine 镜像

## 目录结构

```
src/
  server.js          入口
  migrate.js         独立执行迁移
  migrations/        SQL 迁移（按文件名顺序）
  services/
    db.js            sql.js 包装（同步式 API）
    organizer.js     核心整理流程
    parser.js        文件名解析
    template.js      命名模板渲染
    115.js           115 API 客户端
    scheduler.js     定时任务
public/              前端 SPA
config/              配置
data/                数据库（自动生成）
logs/                日志（自动生成）
```


## 免责声明

本项目仅供学习交流使用，请遵守 115.com 用户协议。使用产生的一切后果由使用者自行承担。

## License

MIT
