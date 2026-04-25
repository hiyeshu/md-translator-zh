# 火山机器翻译接入

这份文档给 `md-translator-zh` 用户看。

你要做的事很简单：

1. 注册火山引擎账号。
2. 完成实名认证。
3. 开通机器翻译。
4. 拿到 `AccessKeyId` 和 `SecretKey`。
5. 回到扩展里填配置。

## 收费

按 Bob 文档里的说明，文本翻译是：

- 每月免费 200 万字符
- 超出后 49 元 / 100 万字符
- 并发 10 次 / 秒

详情看官方价格页：
[火山引擎机器翻译计费说明](https://www.volcengine.com/docs/4640/68515)

## 1. 注册登录

先去火山引擎注册：
[https://www.volcengine.com/](https://www.volcengine.com/)

Bob 那篇文档提到，可以直接用抖音扫码登录。

## 2. 实名认证

没实名的话，后面就算拿到密钥也用不了。

认证入口：
[账号管理 - 实名认证](https://console.volcengine.com/user/authentication)

普通用户做个人认证就够了。

## 3. 开通机器翻译

开通入口：
[机器翻译控制台](https://console.volcengine.com/translate)

如果你打开后已经能看到用量数据，这一步可以跳过。

如果还没开通：

1. 进入页面。
2. 勾选服务条款。
3. 点“立即开通”。

## 4. 获取密钥

建议不要直接用主账号。

更稳的做法是：

1. 新建一个子用户。
2. 给这个子用户加机器翻译权限。
3. 给这个子用户创建密钥。

用户管理入口：
[身份管理 - 用户](https://console.volcengine.com/iam/identitymanage/user)

权限这一步，给子用户加：

- `TranslateFullAccess`

然后在子用户的“秘钥”页新建密钥。

你会拿到两项：

- `AccessKeyId`
- `SecretKey`

别把这两个值发给别人。

## 5. 回到扩展里填写

打开任意 Markdown 文件后：

1. 打开翻译面板。
2. 点工具栏里的 `设置`。
3. 把服务商切到 `火山引擎`。
4. 填这三项：

- `AccessKey ID`
- `Secret Key`
- `Region`

`Region` 默认填 `cn-north-1` 就行。

填完后点 `测试连接`。

如果能通过，就可以开始翻译。

## 扩展里的对应配置

如果你想直接改 VS Code 配置，对应键是：

- `markdownTranslator.provider`
- `markdownTranslator.volcengine.accessKeyId`
- `markdownTranslator.volcengine.secretKey`
- `markdownTranslator.volcengine.region`

建议值：

```json
{
  "markdownTranslator.provider": "volcengine",
  "markdownTranslator.volcengine.accessKeyId": "你的 AccessKeyId",
  "markdownTranslator.volcengine.secretKey": "你的 SecretKey",
  "markdownTranslator.volcengine.region": "cn-north-1"
}
```

## 失败时先查这几项

- 没实名
- 没开通机器翻译
- 子用户没加 `TranslateFullAccess`
- `AccessKeyId` / `SecretKey` 填错
- `Region` 不是 `cn-north-1`

## 来源

这份文档根据下面这页整理，并把最后一步改成了本扩展的配置方式：

- Bob: [火山翻译](https://bobtranslate.com/service/translate/volcengine.html)
