export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram Webhook
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    // 文件下载
    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      return downloadFile(request, env);
    }

    // 健康检查
    if (url.pathname === "/") {
      return new Response(
        "OOI Telegram Drive is running.",
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        }
      );
    }

    return new Response("Not Found", { status: 404 });
  }
};


// ============================================================
// Telegram Webhook
// ============================================================

async function handleWebhook(request, env) {
  let update;

  try {
    update = await request.json();
  } catch {
    return ok();
  }

  const message = update.message;

  if (!message) {
    return ok();
  }

  const chatId = message.chat?.id;
  const userId = String(message.from?.id || "");
  const text = message.text?.trim() || "";

  // ----------------------------------------------------------
  // 获取自己的 Telegram ID
  // ----------------------------------------------------------

  if (text === "/id") {
    await sendMessage(
      env,
      chatId,
      `你的 Telegram ID：\n${userId}`
    );

    return ok();
  }

  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  if (text === "/start") {
    await sendMessage(
      env,
      chatId,
`☁️ OOI 私人网盘

发送文件给我，我会上传到 Cloudflare R2。

命令：

/id
查看自己的 Telegram ID

/list
查看最近文件

/delete 文件KEY
删除文件

支持：
📷 图片
📄 文档
🎬 视频
🎵 音频
📦 ZIP 等普通文件

当前 Telegram Bot 单文件上传上限约 20MB。`
    );

    return ok();
  }

  // ----------------------------------------------------------
  // ADMIN_ID 尚未设置
  // ----------------------------------------------------------

  if (!env.ADMIN_ID) {
    await sendMessage(
      env,
      chatId,
`⚠️ 尚未配置 ADMIN_ID。

请发送：

/id

取得你的 Telegram ID 后，在 Cloudflare Worker
运行时变量中添加：

ADMIN_ID=你的Telegram数字ID`
    );

    return ok();
  }

  // ----------------------------------------------------------
  // 仅允许管理员
  // ----------------------------------------------------------

  if (userId !== String(env.ADMIN_ID)) {
    await sendMessage(
      env,
      chatId,
      "⛔ 无权限使用此私人网盘。"
    );

    return ok();
  }

  // ----------------------------------------------------------
  // LIST
  // ----------------------------------------------------------

  if (text === "/list") {
    await listFiles(request, env, chatId);
    return ok();
  }

  // ----------------------------------------------------------
  // DELETE
  // ----------------------------------------------------------

  if (text.startsWith("/delete ")) {
    const key = text.slice(8).trim();

    if (!key) {
      await sendMessage(
        env,
        chatId,
        "用法：/delete 文件KEY"
      );

      return ok();
    }

    const object = await env.DRIVE.head(key);

    if (!object) {
      await sendMessage(
        env,
        chatId,
        "❌ 文件不存在。"
      );

      return ok();
    }

    await env.DRIVE.delete(key);

    await sendMessage(
      env,
      chatId,
      `🗑 已删除：\n${key}`
    );

    return ok();
  }

  // ----------------------------------------------------------
  // 获取文件信息
  // ----------------------------------------------------------

  const fileInfo = extractTelegramFile(message);

  if (!fileInfo) {
    await sendMessage(
      env,
      chatId,
      "请发送图片、文件、视频或音频。"
    );

    return ok();
  }

  // Telegram Bot API getFile 限制
  const MAX_SIZE = 20 * 1024 * 1024;

  if (
    fileInfo.size &&
    fileInfo.size > MAX_SIZE
  ) {
    await sendMessage(
      env,
      chatId,
      "❌ 文件超过 Telegram Bot 当前约 20MB 的下载限制。"
    );

    return ok();
  }

  try {
    await sendMessage(
      env,
      chatId,
      `⏳ 正在上传：${fileInfo.name}`
    );

    // --------------------------------------------------------
    // Telegram getFile
    // --------------------------------------------------------

    const api =
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}`;

    const getFileRes = await fetch(
      `${api}/getFile?file_id=${encodeURIComponent(fileInfo.fileId)}`
    );

    const getFileData = await getFileRes.json();

    if (!getFileData.ok || !getFileData.result?.file_path) {
      throw new Error(
        getFileData.description || "Telegram getFile 失败"
      );
    }

    const telegramPath =
      getFileData.result.file_path;

    // --------------------------------------------------------
    // 从 Telegram 下载
    // --------------------------------------------------------

    const telegramFileUrl =
      `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${telegramPath}`;

    const fileRes = await fetch(telegramFileUrl);

    if (!fileRes.ok || !fileRes.body) {
      throw new Error(
        `Telegram 文件下载失败：HTTP ${fileRes.status}`
      );
    }

    // --------------------------------------------------------
    // 生成 R2 Key
    // --------------------------------------------------------

    const safeName =
      sanitizeFilename(fileInfo.name);

    const randomId =
      crypto.randomUUID()
        .replaceAll("-", "")
        .slice(0, 10);

    const key =
      `${Date.now()}-${randomId}-${safeName}`;

    // --------------------------------------------------------
    // 流式写入 R2
    // 不把整个文件加载进 Worker 内存
    // --------------------------------------------------------

    await env.DRIVE.put(
      key,
      fileRes.body,
      {
        httpMetadata: {
          contentType:
            fileInfo.mimeType ||
            fileRes.headers.get("content-type") ||
            "application/octet-stream"
        },

        customMetadata: {
          originalName: fileInfo.name,
          uploader: userId
        }
      }
    );

    // --------------------------------------------------------
    // 生成下载 URL
    // --------------------------------------------------------

    const origin =
      env.PUBLIC_BASE_URL
        ? env.PUBLIC_BASE_URL.replace(/\/$/, "")
        : new URL(request.url).origin;

    const downloadUrl =
      `${origin}/file/${encodeURIComponent(key)}`;

    const sizeText =
      fileInfo.size
        ? formatBytes(fileInfo.size)
        : "未知";

    await sendMessage(
      env,
      chatId,
`✅ 上传成功

📄 文件：
${fileInfo.name}

📦 大小：
${sizeText}

🔗 下载：
${downloadUrl}

🗝 KEY：
${key}`
    );

  } catch (err) {

    console.error(err);

    await sendMessage(
      env,
      chatId,
      `❌ 上传失败：${err.message}`
    );
  }

  return ok();
}


// ============================================================
// 判断 Telegram 文件类型
// ============================================================

function extractTelegramFile(message) {

  // 普通文件
  if (message.document) {
    return {
      fileId: message.document.file_id,
      name:
        message.document.file_name ||
        `file-${Date.now()}`,
      mimeType:
        message.document.mime_type ||
        "application/octet-stream",
      size:
        message.document.file_size || 0
    };
  }

  // Telegram 照片
  if (
    message.photo &&
    message.photo.length
  ) {

    const photo =
      message.photo[
        message.photo.length - 1
      ];

    return {
      fileId: photo.file_id,
      name: `photo-${Date.now()}.jpg`,
      mimeType: "image/jpeg",
      size: photo.file_size || 0
    };
  }

  // 视频
  if (message.video) {
    return {
      fileId: message.video.file_id,
      name:
        message.video.file_name ||
        `video-${Date.now()}.mp4`,
      mimeType:
        message.video.mime_type ||
        "video/mp4",
      size:
        message.video.file_size || 0
    };
  }

  // 音频
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      name:
        message.audio.file_name ||
        `audio-${Date.now()}.mp3`,
      mimeType:
        message.audio.mime_type ||
        "audio/mpeg",
      size:
        message.audio.file_size || 0
    };
  }

  // 语音
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      name:
        `voice-${Date.now()}.ogg`,
      mimeType:
        message.voice.mime_type ||
        "audio/ogg",
      size:
        message.voice.file_size || 0
    };
  }

  // GIF / Animation
  if (message.animation) {
    return {
      fileId: message.animation.file_id,
      name:
        message.animation.file_name ||
        `animation-${Date.now()}.mp4`,
      mimeType:
        message.animation.mime_type ||
        "video/mp4",
      size:
        message.animation.file_size || 0
    };
  }

  return null;
}


// ============================================================
// 文件下载
// ============================================================

async function downloadFile(request, env) {
  const url = new URL(request.url);

  const encodedKey =
    url.pathname.slice("/file/".length);

  if (!encodedKey) {
    return new Response(
      "Missing file key",
      { status: 400 }
    );
  }

  let key;

  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response(
      "Invalid file key",
      { status: 400 }
    );
  }

  const object =
    await env.DRIVE.get(key);

  if (!object) {
    return new Response(
      "File not found",
      { status: 404 }
    );
  }

  const headers =
    new Headers();

  object.writeHttpMetadata(headers);

  headers.set(
    "etag",
    object.httpEtag
  );

  const originalName =
    object.customMetadata?.originalName ||
    key;

  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(originalName)}`
  );

  headers.set(
    "Cache-Control",
    "private, max-age=3600"
  );

  return new Response(
    object.body,
    {
      headers
    }
  );
}


// ============================================================
// 文件列表
// ============================================================

async function listFiles(request, env, chatId) {

  const result =
    await env.DRIVE.list({
      limit: 1000,
      include: [
        "customMetadata",
        "httpMetadata"
      ]
    });

  if (!result.objects.length) {

    await sendMessage(
      env,
      chatId,
      "📂 网盘目前为空。"
    );

    return;
  }

  const files =
    [...result.objects]
      .sort(
        (a, b) =>
          new Date(b.uploaded) -
          new Date(a.uploaded)
      )
      .slice(0, 20);

  const origin =
    env.PUBLIC_BASE_URL
      ? env.PUBLIC_BASE_URL.replace(/\/$/, "")
      : new URL(request.url).origin;

  let text =
    "☁️ 最近上传文件\n\n";

  for (const file of files) {

    const name =
      file.customMetadata?.originalName ||
      file.key;

    const url =
      `${origin}/file/${encodeURIComponent(file.key)}`;

    text +=
`${name}
${formatBytes(file.size)}
${url}

`;
  }

  await sendMessage(
    env,
    chatId,
    text.slice(0, 4000)
  );
}


// ============================================================
// Telegram sendMessage
// ============================================================

async function sendMessage(
  env,
  chatId,
  text
) {

  if (!env.TG_BOT_TOKEN) {
    throw new Error(
      "TG_BOT_TOKEN 未配置"
    );
  }

  await fetch(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    }
  );
}


// ============================================================
// Utils
// ============================================================

function sanitizeFilename(name) {

  return String(name)
    .replace(
      /[\\/:*?"<>|%#]/g,
      "_"
    )
    .replace(
      /[\u0000-\u001F]/g,
      ""
    )
    .slice(0, 180);
}


function formatBytes(bytes) {

  if (!bytes) {
    return "0 B";
  }

  const units = [
    "B",
    "KB",
    "MB",
    "GB"
  ];

  const i =
    Math.min(
      Math.floor(
        Math.log(bytes) /
        Math.log(1024)
      ),
      units.length - 1
    );

  return (
    (bytes /
      Math.pow(1024, i))
      .toFixed(
        i === 0 ? 0 : 2
      ) +
    " " +
    units[i]
  );
}


function ok() {
  return new Response(
    "OK",
    { status: 200 }
  );
}
