export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram Webhook
    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

      if (!env.TG_WEBHOOK_SECRET || secret !== env.TG_WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }

      return handleWebhook(request, env);
    }

    // 带签名的文件下载
    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      return downloadFile(request, env);
    }

    // 健康检查
    if (url.pathname === "/") {
      return new Response("OOI Telegram Drive is running.", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

// ============================================================
// 基础配置
// ============================================================

// 下载链接有效期：24 小时
const DOWNLOAD_TTL = 24 * 60 * 60;

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

  // 私人模式：仅允许 ADMIN_ID
  if (!env.ADMIN_ID || userId !== String(env.ADMIN_ID)) {
    return ok();
  }

  // 获取自己的 Telegram ID
  if (text === "/id") {
    await sendMessage(env, chatId, `你的 Telegram ID：\n${userId}`);
    return ok();
  }

  // START
  if (text === "/start") {
    await sendMessage(
      env,
      chatId,
      `☁️ OOI 私人网盘\n\n` +
      `发送文件给我，我会上传到 Cloudflare R2。\n\n` +
      `命令：\n\n` +
      `/id\n查看自己的 Telegram ID\n\n` +
      `/list\n查看最近文件，并重新生成 24 小时下载链接\n\n` +
      `/delete 文件KEY\n删除文件\n\n` +
      `支持：\n` +
      `📷 图片\n` +
      `📄 文档\n` +
      `🎬 视频\n` +
      `🎵 音频\n` +
      `📦 ZIP 等普通文件\n\n` +
      `🔐 下载链接有效期：24 小时\n` +
      `📌 当前 Telegram Bot 单文件上传上限约 20MB。`
    );

    return ok();
  }

  // LIST
  if (text === "/list") {
    if (!env.DOWNLOAD_SECRET) {
      await sendMessage(
        env,
        chatId,
        "❌ DOWNLOAD_SECRET 未配置。请先在 Cloudflare 运行时密钥中添加。"
      );
      return ok();
    }

    await listFiles(request, env, chatId);
    return ok();
  }

  // DELETE
  if (text.startsWith("/delete ")) {
    const key = text.slice(8).trim();

    if (!key) {
      await sendMessage(env, chatId, "用法：/delete 文件KEY");
      return ok();
    }

    const object = await env.DRIVE.head(key);

    if (!object) {
      await sendMessage(env, chatId, "❌ 文件不存在。");
      return ok();
    }

    await env.DRIVE.delete(key);
    await sendMessage(env, chatId, `🗑 已删除：\n${key}`);
    return ok();
  }

  // 获取文件信息
  const fileInfo = extractTelegramFile(message);

  if (!fileInfo) {
    await sendMessage(env, chatId, "请发送图片、文件、视频或音频。");
    return ok();
  }

  if (!env.DOWNLOAD_SECRET) {
    await sendMessage(
      env,
      chatId,
      "❌ DOWNLOAD_SECRET 未配置，暂不能生成安全下载链接。"
    );
    return ok();
  }

  // Telegram Bot API getFile 限制
  const MAX_SIZE = 20 * 1024 * 1024;

  if (fileInfo.size && fileInfo.size > MAX_SIZE) {
    await sendMessage(
      env,
      chatId,
      "❌ 文件超过 Telegram Bot 当前约 20MB 的下载限制。"
    );
    return ok();
  }

  try {
    await sendMessage(env, chatId, `⏳ 正在上传：${fileInfo.name}`);

    // Telegram getFile
    const api = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}`;

    const getFileRes = await fetch(
      `${api}/getFile?file_id=${encodeURIComponent(fileInfo.fileId)}`
    );

    const getFileData = await getFileRes.json();

    if (!getFileData.ok || !getFileData.result?.file_path) {
      throw new Error(
        getFileData.description || "Telegram getFile 失败"
      );
    }

    const telegramPath = getFileData.result.file_path;

    // 从 Telegram 下载
    const telegramFileUrl =
      `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${telegramPath}`;

    const fileRes = await fetch(telegramFileUrl);

    if (!fileRes.ok || !fileRes.body) {
      throw new Error(
        `Telegram 文件下载失败：HTTP ${fileRes.status}`
      );
    }

    // 生成 R2 Key
    const safeName = sanitizeFilename(fileInfo.name);

    const randomId = crypto.randomUUID()
      .replaceAll("-", "")
      .slice(0, 10);

    const key =
      `${Date.now()}-${randomId}-${safeName}`;

    // 流式写入 R2
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

    // 生成 24 小时签名下载 URL
    const downloadUrl =
      await createSignedDownloadUrl(
        request,
        env,
        key
      );

    const sizeText =
      fileInfo.size
        ? formatBytes(fileInfo.size)
        : "未知";

    await sendMessage(
      env,
      chatId,
      `✅ 上传成功\n\n` +
      `📄 文件：\n${fileInfo.name}\n\n` +
      `📦 大小：\n${sizeText}\n\n` +
      `🔗 下载（24小时有效）：\n${downloadUrl}\n\n` +
      `🗝 KEY：\n${key}`
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
// 文件下载：必须带有效 exp + sig
// ============================================================

async function downloadFile(request, env) {
  const url = new URL(request.url);

  if (!env.DOWNLOAD_SECRET) {
    return new Response(
      "DOWNLOAD_SECRET is not configured",
      { status: 503 }
    );
  }

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

  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (!exp || !sig) {
    return new Response(
      "Missing signature",
      { status: 403 }
    );
  }

  if (!/^\d+$/.test(exp)) {
    return new Response(
      "Invalid expiration",
      { status: 403 }
    );
  }

  const expiresAt = Number(exp);

  const now =
    Math.floor(Date.now() / 1000);

  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    return new Response(
      "Invalid expiration",
      { status: 403 }
    );
  }

  if (now > expiresAt) {
    return new Response(
      "Link expired",
      { status: 403 }
    );
  }

  const valid =
    await verifyDownloadSignature(
      env,
      key,
      exp,
      sig
    );

  if (!valid) {
    return new Response(
      "Invalid signature",
      { status: 403 }
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

  // 私人链接不做公共缓存
  headers.set(
    "Cache-Control",
    "private, no-store"
  );

  headers.set(
    "X-Content-Type-Options",
    "nosniff"
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

async function listFiles(
  request,
  env,
  chatId
) {

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

  let text =
    "☁️ 最近上传文件（下载链接24小时有效）\n\n";

  let count = 0;

  for (const file of files) {

    const name =
      file.customMetadata?.originalName ||
      file.key;

    const url =
      await createSignedDownloadUrl(
        request,
        env,
        file.key
      );

    const block =
      `${name}\n` +
      `${formatBytes(file.size)}\n` +
      `${url}\n\n`;

    // Telegram 单条消息限制约 4096 字符
    if (
      (text + block).length >
      3900
    ) {
      break;
    }

    text += block;
    count++;
  }

  if (count === 0) {
    text +=
      "文件较多或链接过长，请稍后重试。";
  }

  await sendMessage(
    env,
    chatId,
    text
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

  const res =
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

  if (!res.ok) {

    const body =
      await res.text();

    throw new Error(
      `Telegram sendMessage 失败：HTTP ${res.status} ${body}`
    );
  }
}

// ============================================================
// Signed URL：HMAC-SHA256
// ============================================================

async function getDownloadHmacKey(env) {

  if (!env.DOWNLOAD_SECRET) {
    throw new Error(
      "DOWNLOAD_SECRET 未配置"
    );
  }

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      env.DOWNLOAD_SECRET
    ),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    [
      "sign",
      "verify"
    ]
  );
}

async function createDownloadSignature(
  env,
  key,
  exp
) {

  const cryptoKey =
    await getDownloadHmacKey(env);

  const data =
    new TextEncoder().encode(
      `${key}\n${exp}`
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      data
    );

  return arrayBufferToBase64Url(
    signature
  );
}

async function verifyDownloadSignature(
  env,
  key,
  exp,
  signature
) {

  try {

    const cryptoKey =
      await getDownloadHmacKey(env);

    const data =
      new TextEncoder().encode(
        `${key}\n${exp}`
      );

    const signatureBytes =
      base64UrlToUint8Array(
        signature
      );

    return await crypto.subtle.verify(
      "HMAC",
      cryptoKey,
      signatureBytes,
      data
    );

  } catch {
    return false;
  }
}

async function createSignedDownloadUrl(
  request,
  env,
  key
) {

  const exp =
    Math.floor(Date.now() / 1000) +
    DOWNLOAD_TTL;

  const sig =
    await createDownloadSignature(
      env,
      key,
      String(exp)
    );

  const origin =
    env.PUBLIC_BASE_URL
      ? env.PUBLIC_BASE_URL.replace(
          /\/$/,
          ""
        )
      : new URL(request.url).origin;

  return (
    `${origin}/file/` +
    `${encodeURIComponent(key)}` +
    `?exp=${exp}` +
    `&sig=${encodeURIComponent(sig)}`
  );
}

function arrayBufferToBase64Url(
  buffer
) {

  const bytes =
    new Uint8Array(buffer);

  let binary = "";

  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {
    binary +=
      String.fromCharCode(
        bytes[i]
      );
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToUint8Array(
  input
) {

  let base64 =
    input
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  while (
    base64.length % 4
  ) {
    base64 += "=";
  }

  const binary =
    atob(base64);

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes;
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
