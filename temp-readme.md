
# Vocab Lite

**Vocab Lite** 是一个轻量级的背单词 Web App，旨在帮助你通过简单的界面高效记忆词汇。项目使用 **Alpine.js** 和 **Tailwind CSS** 打造，数据存储在浏览器的 LocalStorage 中，支持离线使用。

## 特性

* **最小技术栈**：无打包器，纯 HTML、CSS、JavaScript。
* **支持 PWA**：支持离线缓存，离线时可继续学习。
* **自定义词表**：支持导入 JSON 或 CSV 格式的词表。
* **复习机制**：基于 **Leitner 箱**（1-5箱）管理词汇复习。
* **AI 辅助**：通过集成 DeepSeek 提供的 AI 助手来获得词汇的定义和例句。
* **多种学习模式**：包括 **记忆模式** 和 **拼写模式**（可以选择学习阶段使用哪种模式）。

## 使用说明

### 功能概览

1. **选择词表**：通过内置词表或导入本地 JSON/CSV 文件。
2. **设置目标**：设定每日学习的新词数量和复习/新词的比例。
3. **学习与复习**：支持 **记忆模式** 和 **拼写模式**，你可以自由切换。
4. **AI 辅助**：点击右下角的 AI 按钮，通过 DeepSeek 获取词汇定义和例句。

### 主要界面

* **首页**：简短介绍和使用指南。
* **学习页**：支持记忆和拼写模式的学习。
* **复习页**：基于 Leitner 箱的复习功能。
* **词表页**：选择或导入词表。
* **目标页**：设置每日学习目标。
* **设置页**：配置 AI 设置、主题等。

### 数据存储

* **LocalStorage** 用于存储设置、词表和学习进度。
* 可以通过导入/导出功能备份或恢复数据。

### AI 设置

* 在设置页中配置 **DeepSeek API** 的代理地址（默认通过 Cloudflare Workers 提供代理服务），你也可以使用自己的 API Key。

## 本地开发与预览

你可以通过以下方式启动项目，进行本地预览：

### 1. 使用 Python 服务器

如果你的系统已经安装了 Python，可以使用以下命令启动一个本地开发服务器：

```bash
python3 -m http.server 5173
```

### 2. 使用 `serve` 启动服务器

你也可以使用 `serve` 来启动一个本地服务器。首先需要安装 `serve`：

```bash
npm install -g serve
```

然后在项目根目录运行：

```bash
serve .
```

然后在浏览器中访问 `http://localhost:5173` 或默认端口。

## 部署到 GitHub Pages

1. 创建一个新的 GitHub 仓库，推送所有代码到 `main` 分支。
2. 在 GitHub 仓库的 Settings 页，选择 `Pages`。
3. 在 `Source` 选择 `main` 分支，目录选择 `/`。
4. GitHub 会自动部署，稍等片刻即可访问你的背单词 App。

## 配置 AI 代理（Cloudflare Workers）

### 1. 设置 Cloudflare Worker

你可以使用 Cloudflare Workers 作为 API 代理，避免在前端暴露 API Key。按照以下步骤配置：

* 首先，登录到 Cloudflare 并创建一个 Worker。
* 将 `proxy-worker/cloudflare.js` 文件的内容复制到 Worker 编辑器。
* 在 Cloudflare 的 Workers 设置中添加 `DEEPSEEK_API_KEY` 和 `CLIENT_TOKEN`（用于验证）。

### 2. 部署 Worker

```bash
npm install -g wrangler
wrangler login
# 在 Worker 项目文件夹中
wrangler deploy
```

部署完成后，你将获得一个代理 API 地址，如：`https://<your-worker>.workers.dev/api/chat`，将其填入前端的 `AI_BASE` 配置中。

### 3. 配置前端

在 `app.js` 中配置代理地址：

```javascript
const DEFAULT_SETTINGS = {
  theme: 'system',
  study: { defaultTab: 'home' },
  daily: { newPerDay: 10, ratio: 0.5 },
  ai: {
    base: 'https://<your-worker>.workers.dev/api/chat',  // 填写你的代理地址
    model: 'deepseek-chat',
    temperature: 0.7,
    max_tokens: 512,
    system: 'You are a helpful English vocabulary tutor.',
    maxTurns: 6,
    userKey: '',  // 用户自有 API Key（可选）
    persistUserKey: false
  }
};
```

## 配置 AI 代理的环境变量（Cloudflare）

在 Cloudflare Worker 中，你需要配置以下两个密钥作为环境变量：

```bash
wrangler secret put DEEPSEEK_API_KEY  # DeepSeek API 密钥
wrangler secret put CLIENT_TOKEN     # 客户端令牌（可以是任意字符串）
```

## 项目结构

```
vocab-lite/
├── index.html               # 单页应用入口
├── style.css                # 自定义样式，主要依赖 Tailwind CSS
├── app.js                   # 业务逻辑：词表、学习、复习、拼写模式、AI
├── ai.js                    # AI 代理交互逻辑
├── wordlists/               # 词表文件夹（可选的 demo 和 cet4 示例）
│   ├── demo.json            # 示例词表
│   └── cet4.json            # CET4 词表（100个词汇）
├── sw.js                    # Service Worker：离线缓存静态资源
├── manifest.webmanifest     # PWA 配置
├── README.md                # 项目说明文档
└── proxy-worker/            # Cloudflare Worker 代理配置
    └── cloudflare.js        # 代理逻辑，转发到 DeepSeek API
```

## 常见问题

### 1. **GitHub Pages 404 错误**

如果你部署到 GitHub Pages 后遇到 404 错误，可能是因为是单页应用（SPA）。你需要设置 `404.html` 为 `index.html` 的副本来支持 SPA 回退。

### 2. **如何导入和导出数据？**

* **导出**：点击「设置」页的「导出 LocalStorage」，将当前数据导出为 JSON 文件。
* **导入**：点击「设置」页的「导入 JSON」按钮，选择一个 JSON 文件进行恢复。

## License

This project is licensed under the MIT License.

