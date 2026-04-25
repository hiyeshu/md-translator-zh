# Markdown 中文翻译器

一个给 Markdown 用的中文翻译插件。现在固定输出简体中文，支持分栏预览、差异翻译、缓存和多服务商接入。

## 用法

1. 在 VS Code 里打开 `.md` 文件。
2. 按 `Ctrl+Shift+T`，Mac 用 `Cmd+Shift+T`。
3. 选好翻译服务商。
4. 开始翻译。

## 现在有什么

- 左边原文，右边译文，同步滚动
- 只翻改动的段落，省 API 费
- 保留 Markdown 结构，不乱代码块、链接和表格
- 默认免费，也支持 Google、Azure、自定义 API

## 设置

设置页现在用 `markdownTranslator.*`。旧的 `mdcarrot.*` 还兼容，但不再继续展示。

默认免费：

```json
{
  "markdownTranslator.provider": "free"
}
```

可选镜像：

```json
{
  "markdownTranslator.free.googleMirror": "https://your-google-mirror.example.com"
}
```

Google 官方 API:

```json
{
  "markdownTranslator.provider": "google",
  "markdownTranslator.google.apiKey": "YOUR_API_KEY"
}
```

Azure:

```json
{
  "markdownTranslator.provider": "azure",
  "markdownTranslator.azure.key": "YOUR_KEY",
  "markdownTranslator.azure.region": "eastus"
}
```

自定义 API:

```json
{
  "markdownTranslator.provider": "custom",
  "markdownTranslator.custom.endpoint": "https://your-api.example.com/v1/translate",
  "markdownTranslator.custom.token": "YOUR_TOKEN"
}
```

自定义 API 默认会收到这类请求：

```json
{
  "texts": ["Hello"],
  "sourceLang": "auto",
  "targetLang": "zh-CN",
  "format": "text",
  "provider": "custom"
}
```

## 命令

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| 打开 Markdown 中文翻译器 | `Ctrl+Shift+T` | 打开分栏翻译界面 |
| 测试翻译服务连接 | 命令面板 | 检查服务配置 |
| 清除翻译缓存 | 命令面板 | 清空缓存 |

## 隐私

API Key 存在 VS Code 设置里。文档内容只会发给你选的翻译服务。默认免费会请求 Google 网页端点和 MyMemory，稳定性不保证。

## 说明

- 现在仓库是从已安装扩展反拷出来的，代码是编译产物
- 图标还是旧图，还没重画
- 许可证沿用 MIT
