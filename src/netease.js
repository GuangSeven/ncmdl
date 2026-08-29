const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PRESET_KEY = "0CoJUm6Qyw8W8jud";
const IV = "0102030405060708";
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

const QUALITY_ORDER = ["jymaster", "dolby", "sky", "jyeffect", "hires", "lossless", "exhigh", "higher", "standard"];
const QUALITY_ALIASES = {
  highres: "hires",
  lossless: "lossless",
  high: "exhigh",
  normal: "higher",
  standard: "standard"
};

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function randomSecretKey(length = 16) {
  const bytes = crypto.randomBytes(length);
  let secret = "";
  for (let index = 0; index < bytes.length; index++) {
    secret += BASE62[bytes[index] % BASE62.length];
  }
  return secret;
}

function aesEncrypt(text, key, iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

function rsaEncrypt(text, publicKeyPem) {
  const reversed = Buffer.from(text.split("").reverse().join(""), "utf8");
  const encrypted = crypto.publicEncrypt({
    key: publicKeyPem,
    padding: crypto.constants.RSA_PKCS1_PADDING
  }, reversed);
  return encrypted.toString("hex");
}

function weapiEncrypt(object) {
  const text = JSON.stringify(object);
  const secretKey = randomSecretKey(16);
  const params = aesEncrypt(aesEncrypt(text, PRESET_KEY, IV), secretKey, IV);
  const encSecKey = rsaEncrypt(secretKey, PUBLIC_KEY);
  return { params, encSecKey };
}

function parseCookie(cookieString = "") {
  return cookieString
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");
      if (index < 0) {
        cookies[part] = "";
        return cookies;
      }
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      cookies[key] = value;
      return cookies;
    }, {});
}

function getCsrfToken(cookieString = "") {
  const cookie = parseCookie(cookieString);
  return cookie.__csrf || cookie._csrf || "";
}

function normalizeQuality(quality) {
  const lower = String(quality || "").toLowerCase();
  return QUALITY_ALIASES[lower] || lower || "jymaster";
}

function getQualityFallbackOrder(quality) {
  const normalized = normalizeQuality(quality);
  const startIndex = QUALITY_ORDER.indexOf(normalized);
  if (startIndex < 0) {
    return QUALITY_ORDER.slice();
  }
  return QUALITY_ORDER.slice(startIndex);
}

function parseSongId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const patterns = [
    /[?&#]id=(\d+)/i,
    /song\?id=(\d+)/i,
    /song\/([0-9]+)/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function sanitizeFilename(filename) {
  if (!filename) return "downloaded_file";
  let sanitized = String(filename).replace(/\//g, "／");
  sanitized = sanitized.replace(/[<>:"\\|?*\x00-\x1F]/g, " ");
  sanitized = sanitized.trim().replace(/[\s.]+$/, "");
  if (!sanitized) return "downloaded_file";
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized;
}

function buildSongName(song, pattern = "artist-title") {
  const title = song?.name || "unknown";
  // weapi 详情返回 ar、公开接口返回 artists，两种结构都兼容
  const artists = Array.isArray(song?.ar) ? song.ar : Array.isArray(song?.artists) ? song.artists : [];
  const artist = artists.length > 0 ? artists.map((item) => item.name).filter(Boolean).join(" & ") : "unknown";
  switch (pattern) {
    case "title":
      return title;
    case "title-artist":
      return `${title} - ${artist}`;
    case "artist-title":
    default:
      return `${artist} - ${title}`;
  }
}

function guessExtension(downloadUrl, contentType) {
  try {
    const ext = path.extname(new URL(downloadUrl).pathname);
    if (ext) return ext;
  } catch (error) {
  }
  const mime = String(contentType || "").toLowerCase();
  if (mime.includes("flac")) return ".flac";
  if (mime.includes("mpeg")) return ".mp3";
  if (mime.includes("mp4")) return ".m4a";
  if (mime.includes("aac")) return ".aac";
  return ".mp3";
}

async function requestWeapi(endpoint, data, config = {}) {
  if (typeof fetch !== "function") {
    throw new Error("当前 Node 版本缺少 fetch，请使用 Node.js 18 或更高版本。");
  }
  const cookie = config.cookie || "";
  const userAgent = config.userAgent || DEFAULT_USER_AGENT;
  const csrfToken = getCsrfToken(cookie);
  const payload = Object.assign({}, data || {});
  if (!Object.prototype.hasOwnProperty.call(payload, "csrf_token")) {
    payload.csrf_token = csrfToken;
  }
  const { params, encSecKey } = weapiEncrypt(payload);
  const requestUrl = `https://interface.music.163.com/weapi${endpoint}?csrf_token=${encodeURIComponent(csrfToken)}`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://music.163.com",
      Referer: "https://music.163.com/",
      Cookie: cookie,
      "User-Agent": userAgent
    },
    body: new URLSearchParams({ params, encSecKey }).toString()
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`网易云接口请求失败：HTTP ${response.status} ${response.statusText}，${text.slice(0, 200)}`);
  }
  if (!text) {
    // 网易云风控：weapi 路由对非白名单请求直接返回 200 + 空 body（curl/Node/浏览器实测均如此）。
    // 标记 blockedByWaf，上层据此回退到未加密的公开接口。
    const error = new Error("网易云 weapi 接口返回空响应（可能被风控拦截）");
    error.blockedByWaf = true;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`网易云接口返回了非 JSON 内容：${text.slice(0, 200)}`);
  }
}

/**
 * 公开（非 weapi）接口请求：weapi 被风控拦截时的回退通道。
 * 公开接口无需 weapi 加密，但通常要求携带有效登录 Cookie。
 */
async function requestPublicApi(endpoint, query, config = {}) {
  if (typeof fetch !== "function") {
    throw new Error("当前 Node 版本缺少 fetch，请使用 Node.js 18 或更高版本。");
  }
  const cookie = config.cookie || "";
  const userAgent = config.userAgent || DEFAULT_USER_AGENT;
  const requestUrl = `https://music.163.com${endpoint}?${new URLSearchParams(query).toString()}`;
  const response = await fetch(requestUrl, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Origin: "https://music.163.com",
      Referer: "https://music.163.com/",
      Cookie: cookie,
      "User-Agent": userAgent
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`网易云接口请求失败：HTTP ${response.status} ${response.statusText}，${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`网易云接口返回了非 JSON 内容：${text.slice(0, 200)}`);
  }
}

async function getSongDetail(songId, config) {
  try {
    return await requestWeapi(
      "/api/v3/song/detail",
      {
        c: JSON.stringify([{ id: songId }]),
        ids: JSON.stringify([songId])
      },
      config
    );
  } catch (error) {
    if (!error.blockedByWaf) throw error;
    // weapi 被风控拦截时回退公开接口
    return requestPublicApi("/api/song/detail/", { id: songId, ids: `[${songId}]` }, config);
  }
}

/**
 * 获取专辑详情（含发行公司/发售日期/专辑艺人），标签写入用。
 */
async function getAlbumDetail(albumId, config) {
  if (!albumId) return null;
  try {
    return await requestWeapi("/api/v1/album", { id: albumId }, config);
  } catch (error) {
    if (!error.blockedByWaf) throw error;
    return requestPublicApi(`/api/album/${albumId}`, {}, config);
  }
}

/**
 * 获取歌词（lrc.lyric 为原文，tlyric.lyric 为翻译）。
 */
async function getLyric(songId, config) {
  try {
    return await requestWeapi(
      "/api/song/lyric/v1",
      { id: songId, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 },
      config
    );
  } catch (error) {
    if (!error.blockedByWaf) throw error;
    return requestPublicApi("/api/song/lyric", { id: songId, lv: 1, kv: 1, tv: 1 }, config);
  }
}

/**
 * 下载图片字节（专辑封面）。
 */
async function fetchImage(url, config = {}) {
  const userAgent = config.userAgent || DEFAULT_USER_AGENT;
  const response = await fetch(url, {
    headers: {
      Referer: "https://music.163.com/",
      "User-Agent": userAgent
    }
  });
  if (!response.ok) {
    throw new Error(`图片下载失败：HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function resolveDownloadUrl(songId, quality, config) {
  const qualities = getQualityFallbackOrder(quality);
  const endpointCandidates = [
    {
      endpoint: "/api/song/enhance/download/url/v1",
      buildData: (level) => ({ id: songId, level, encodeType: "mp3" })
    },
    {
      endpoint: "/api/song/enhance/player/url/v1",
      buildData: (level) => ({ ids: JSON.stringify([songId]), level, encodeType: "mp3" })
    }
  ];
  // weapi 被风控拦截后置 true：后续候选不再尝试 weapi，直接走公开接口
  let weapiBlocked = false;

  for (const level of qualities) {
    for (const candidate of endpointCandidates) {
      let result = null;
      if (!weapiBlocked) {
        try {
          result = await requestWeapi(candidate.endpoint, candidate.buildData(level), config);
        } catch (error) {
          if (!error.blockedByWaf) throw error;
          weapiBlocked = true;
        }
      }
      if (!result) {
        // 公开接口回退：结构与 weapi 的 v1 一致（data[0].url），无需加密
        result = await requestPublicApi(
          "/api/song/enhance/player/url/v1",
          {
            ids: `[${songId}]`,
            level,
            encodeType: "mp3",
            csrf_token: getCsrfToken(config.cookie || "")
          },
          config
        );
      }
      const data = Array.isArray(result?.data) ? result.data[0] : result?.data || result;
      const url = data?.url || data?.freeTrialInfo?.url || data?.privilege?.downloadUrl;
      if (url) {
        return { url, level, response: result };
      }
    }
  }

  throw new Error("没有拿到可下载地址，可能是账号权限不足或该歌曲不支持当前音质。");
}

async function downloadFile(downloadUrl, filePath, headers = {}) {
  if (typeof fetch !== "function") {
    throw new Error("当前 Node 版本缺少 fetch，请使用 Node.js 18 或更高版本。");
  }
  const response = await fetch(downloadUrl, {
    headers: Object.assign({
      Referer: "https://music.163.com/"
    }, headers)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}，${text.slice(0, 200)}`);
  }
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.part`;
  await fsPromises.rm(tempFile, { force: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempFile));
  await fsPromises.rm(filePath, { force: true });
  await fsPromises.rename(tempFile, filePath);
  return {
    contentType: response.headers.get("content-type") || "",
    contentLength: response.headers.get("content-length") || ""
  };
}

function buildSongOutputPath(song, config, downloadUrl, contentType) {
  const name = buildSongName(song, config.filenamePattern);
  const ext = guessExtension(downloadUrl, contentType);
  const fileName = sanitizeFilename(`${name}${ext}`);
  return path.join(config.downloadDir, fileName);
}

module.exports = {
  DEFAULT_USER_AGENT,
  QUALITY_ORDER,
  buildSongOutputPath,
  buildSongName,
  downloadFile,
  fetchImage,
  getAlbumDetail,
  getLyric,
  getQualityFallbackOrder,
  getSongDetail,
  guessExtension,
  normalizeQuality,
  parseCookie,
  parseSongId,
  requestPublicApi,
  requestWeapi,
  resolveDownloadUrl,
  sanitizeFilename
};