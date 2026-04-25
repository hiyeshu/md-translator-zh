<p align="center">
  <img src="assets/icon.png" width="80" height="80" alt="Markdown 中文翻译器">
</p>

<h1 align="center">Markdown 中文翻译器</h1>

<p align="center">
  把英文 Markdown 翻成中文，直接在编辑器里看。<br>
  开箱即用，改哪翻哪。
</p>

<p align="center">
  <a href="https://github.com/hiyeshu/md-translator-zh">GitHub</a> ·
  <a href="https://github.com/hiyeshu/md-translator-zh/issues">反馈</a>
</p>

---

## 安装

在 Cursor 或 VS Code 扩展面板搜索 `md-translator-zh`，点安装。

或者手动装：[Releases](https://github.com/hiyeshu/md-translator-zh/releases) 下载 `.vsix` 文件，Cursor 里按 `Cmd+Shift+P` → `Install from VSIX`。

---

## 怎么用

打开任意 `.md` 文件，按 `Cmd+Shift+T`（Windows `Ctrl+Shift+T`）。

会打开一个翻译面板，里面有：

- `Preview`：看渲染后的译文
- `Markdown`：看翻译后的 Markdown 源文
- 服务商下拉：`免费 / 火山引擎 / LLM`
- 工具栏：`同步 / 重翻 / 导出 / 设置`

`同步` 会尽量复用缓存追平当前文档。  
`重翻` 会忽略旧结果，整篇重跑。
`设置` 会打开面板右侧的设置抽屉。

## 特点

- **双视图** — `Preview` 看排版，`Markdown` 看源码
- **增量翻译** — 文档改动后尽量只翻改动部分
- **缓存复用** — 同一段文本不会反复请求
- **格式保护** — 代码块、链接、表格尽量原样保留
- **开箱即用** — 默认就是免费服务

## 服务商

| 服务商 | 配置 | 说明 |
|--------|------|------|
| 免费（默认） | 无需配置 | Google 网页端点 + MyMemory。能直接用，但可能限流 |
| 火山引擎 | 需要 AccessKeyId + SecretKey | 官方机器翻译接口。接入流程看 [API 接入流程概览](https://www.volcengine.com/docs/4640/130872?lang=zh) |
| LLM | 需要 API Key | OpenAI 风格兼容接口。默认按智谱 GLM 跑，默认模型是 `glm-4-flash`，接入步骤看 [智谱 LLM 接入教程](https://github.com/hiyeshu/md-translator-zh/blob/main/docs/zhipu-llm-translation.md) |

## 配置键

- `markdownTranslator.provider`
- `markdownTranslator.free.googleMirror`
- `markdownTranslator.volcengine.accessKeyId`
- `markdownTranslator.volcengine.secretKey`
- `markdownTranslator.volcengine.region`
- `markdownTranslator.llm.apiKey`
- `markdownTranslator.llm.baseUrl`
- `markdownTranslator.llm.model`

只想换智谱模型时，直接改 `markdownTranslator.llm.model` 就够了。

当前默认值是 `glm-4-flash`。这是智谱免费、速度也够快的那档。

## 命令

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| 打开翻译器 | `Cmd/Ctrl+Shift+T` | 分栏翻译界面 |
| 测试连接 | 命令面板 | 检查当前服务商 |
| 清除翻译缓存 | 命令面板 | 清掉所有缓存 |
| 清除当前服务商缓存 | 命令面板 | 只清当前服务商 |
| 显示缓存统计 | 命令面板 | 看文本缓存和文件缓存 |

也可以右键 `.md` 文件打开。

## 隐私

文档内容只发给你选的翻译服务，密钥存在本地设置里。

## License

MIT
