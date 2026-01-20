使用Cloud flare workers部署一个telegram bot在线图床

支持返回Markdown和直链的图床链接


cf环境配置如下：

在代码编辑器左上角点击“后退”按钮回到 Worker 详情页：

点击 Settings -> Variables。

在 Environment Variables 点击 Add variable：

TG_BOT_TOKEN: 填入 @BotFather 给你的 Token。

TG_CHAT_ID: 填入你的 Telegram 用户 ID（用于安全校验，只有你能用）。

点击 Save and deploy。
