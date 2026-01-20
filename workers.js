export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') {
      return this.handleWebhook(request, env);
    }
    return new Response('Bot is running...', { status: 200 });
  },

  async handleWebhook(request, env) {
    const botToken = env.TG_BOT_TOKEN;
    const imgurClientId = env.IMGUR_CLIENT_ID || '546c25a59c58ad7'; // 如果没设置，先用这个公共 ID 测试
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response('OK', { status: 200 });
    }

    if (body.message && body.message.photo) {
      const photos = body.message.photo;
      const fileId = photos[photos.length - 1].file_id;

      try {
        // 1. 获取 TG 文件
        const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
        const fileData = await fileRes.json();
        const filePath = fileData.result.file_path;

        // 2. 下载图片
        const imageRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
        const imageArrayBuffer = await imageRes.arrayBuffer();

        // 3. 上传到 Imgur
        const imgurRes = await fetch('https://api.imgur.com/3/image', {
          method: 'POST',
          headers: {
            Authorization: `Client-ID ${imgurClientId}`,
          },
          body: imageArrayBuffer
        });

        const imgurData = await imgurRes.json();

        if (!imgurData.success) {
          throw new Error(imgurData.data.error || 'Imgur 上传失败');
        }

        const imgUrl = imgurData.data.link;

        // 4. 回复用户
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: body.message.chat.id,
            text: `<b>✅ Imgur 上传成功！</b>\n\n` +
                  `<b>Markdown:</b>\n<code>![image](${imgUrl})</code>\n\n` +
                  `<b>直链:</b>\n${imgUrl}`,
            parse_mode: 'HTML'
          })
        });

      } catch (err) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: body.message.chat.id,
            text: `❌ 失败: ${err.message}`
          })
        });
      }
    }
    return new Response('OK', { status: 200 });
  }
};
