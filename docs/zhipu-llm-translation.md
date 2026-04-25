# 智谱 LLM 接入

这份文档给 `md-translator-zh` 用户看。

你要做的事很简单：

1. 注册智谱开放平台账号。
2. 创建自己的 `API Key`。
3. 回到扩展里把服务商切到 `LLM`。
4. 填好 `API Key / Base URL / Model`。
5. 点 `测试连接`。

## 默认模型

默认先用：

- `glm-4-flash`

原因很简单：

- 免费
- 速度快
- 用来翻 Markdown 够了

如果你后面想换更强的模型，直接改 `Model` 就行。

常见做法：

- 要免费和快：`glm-4-flash`
- 要更强效果：`glm-4-plus`

## 1. 注册登录

先去智谱开放平台：

[https://open.bigmodel.cn/](https://open.bigmodel.cn/)

注册并登录。

## 2. 获取 API Key

去 API Keys 页面创建自己的密钥：

[https://open.bigmodel.cn/usercenter/apikeys](https://open.bigmodel.cn/usercenter/apikeys)

你会拿到一串 `API Key`。

别把它发给别人。

## 3. 回到扩展里填写

打开任意 Markdown 文件后：

1. 打开翻译面板。
2. 点工具栏里的 `设置`。
3. 把服务商切到 `LLM`。
4. 填这三项：

- `API Key`
- `Base URL`
- `Model`

建议直接填：

- `Base URL`: `https://open.bigmodel.cn/api/paas/v4/`
- `Model`: `glm-4-flash`

填完后点 `测试连接`。

如果能通过，就可以开始翻译。

## 扩展里的对应配置

如果你想直接改 VS Code 配置，对应键是：

- `markdownTranslator.provider`
- `markdownTranslator.llm.apiKey`
- `markdownTranslator.llm.baseUrl`
- `markdownTranslator.llm.model`

建议值：

```json
{
  "markdownTranslator.provider": "llm",
  "markdownTranslator.llm.apiKey": "你的 API Key",
  "markdownTranslator.llm.baseUrl": "https://open.bigmodel.cn/api/paas/v4/",
  "markdownTranslator.llm.model": "glm-4-flash"
}
```

## 想换模型怎么做

不用改代码。

只改这一项：

- `markdownTranslator.llm.model`

比如你要换成别的智谱模型，就把它从 `glm-4-flash` 改掉。

## 失败时先查这几项

- `API Key` 填错了
- `Base URL` 不是 `https://open.bigmodel.cn/api/paas/v4/`
- `Model` 名字填错了
- 当前账号没有这个模型的调用权限
- 智谱接口临时限流或网络超时

## 来源

这份文档根据下面两页整理，并把最后一步改成了本扩展的配置方式：

- 智谱官方: [OpenAI API 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)
