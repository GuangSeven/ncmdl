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

/**
 * 解析专辑 ID：支持专辑链接、`album:123` / `album=123` 前缀，以及带 #/album 的路由。
 * 裸数字无法区分歌曲/专辑，因此不在此处理（由 parseTarget 按歌曲兜底）。
 */
function parseAlbumId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const prefixed = raw.match(/^album[:=](\d+)$/i);
  if (prefixed) return Number(prefixed[1]);
  if (!/album/i.test(raw)) return null;
  const patterns = [
    /album\?id=(\d+)/i,
    /album\/(\d+)/i,
    /[?&#]id=(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * 解析单个下载目标：专辑优先于歌曲（专辑链接同样带 ?id=，避免被当成歌曲）。
 * @returns {{type: "song"|"album", id: number}|null}
 */
function parseTarget(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const albumId = parseAlbumId(raw);
  if (albumId) return { type: "album", id: albumId };
  const songId = parseSongId(raw);
  if (songId) return { type: "song", id: songId };
  return null;
}

/**
 * 把一组输入（字符串或字符串数组）按空白/中英文逗号分号顿号切分为目标 token。
 */
function splitTargetList(values) {
  const list = Array.isArray(values) ? values : [values];
  const tokens = [];
  for (const value of list) {
    const parts = String(value == null ? "" : value).split(/[\s,，;；、]+/);
    for (const part of parts) {
      if (part) tokens.push(part);
    }
  }
  return tokens;
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

/**
 * 公开接口的 POST 表单请求（旧版明文接口，无需 weapi 加密）。
 */
async function requestPublicApiPost(endpoint, form, config = {}) {
  if (typeof fetch !== "function") {
    throw new Error("当前 Node 版本缺少 fetch，请使用 Node.js 18 或更高版本。");
  }
  const cookie = config.cookie || "";
  const userAgent = config.userAgent || DEFAULT_USER_AGENT;
  const requestUrl = `https://music.163.com${endpoint}`;
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
    body: new URLSearchParams(form).toString()
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
 * 批量获取歌曲详情（weapi 被风控时回退公开接口），并按传入顺序返回。
 * 专辑内所有歌曲可一次请求取回，避免逐首请求。
 */
async function getSongDetails(songIds, config) {
  const ids = (Array.isArray(songIds) ? songIds : [songIds])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return [];
  let result;
  try {
    result = await requestWeapi(
      "/api/v3/song/detail",
      { c: JSON.stringify(ids.map((id) => ({ id }))), ids: JSON.stringify(ids) },
      config
    );
  } catch (error) {
    if (!error.blockedByWaf) throw error;
    result = await requestPublicApi("/api/song/detail/", { ids: JSON.stringify(ids) }, config);
  }
  const songs = Array.isArray(result?.songs) ? result.songs : [];
  const byId = new Map(songs.map((song) => [song.id, song]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
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
 * 获取专辑及其曲目列表（兼容 weapi 的 `{album:{songs}}` 与公开接口的 `{album, songs}`）。
 * @returns {Promise<{album: object|null, songs: object[]}>}
 */
async function getAlbumSongs(albumId, config) {
  const detail = await getAlbumDetail(albumId, config);
  if (!detail) return { album: null, songs: [] };
  const album = detail.album || detail;
  const songs = Array.isArray(album?.songs)
    ? album.songs
    : Array.isArray(detail.songs)
      ? detail.songs
      : [];
  return { album, songs };
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

function lrcTimeToMs(stamp) {
  const match = String(stamp).match(/^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = (match[3] || "0").padEnd(3, "0").slice(0, 3);
  return minutes * 60000 + seconds * 1000 + Number(fraction);
}

function parseLrcTags(line) {
  const tags = [];
  const regex = /\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    const ms = lrcTimeToMs(match[1]);
    if (ms !== null) tags.push({ raw: match[1], ms });
  }
  return tags;
}

// 曲风中文名 -> 英文名映射，进程内缓存，避免每首歌重复拉取整棵分类树
let styleTagMapCache = null;

/**
 * 获取网易云曲风分类树，构建「中文名 -> 英文名」映射（如 流行 -> Pop）。
 * 数据来自公开接口 `POST /api/tag/list/get`。结果按进程缓存。
 */
async function getStyleTagMap(config) {
  if (styleTagMapCache) return styleTagMapCache;
  const result = await requestPublicApiPost("/api/tag/list/get", {}, config);
  const map = new Map();
  const walk = (list) => {
    for (const tag of Array.isArray(list) ? list : []) {
      const tagName = tag?.tagName;
      if (tagName) {
        // 曲风名本身已是英文（无中文）时保留原样，避免 R&B -> Rhythm and blues 这类冗余
        const isLatin = !/[\u4e00-\u9fff]/.test(tagName);
        map.set(tagName, isLatin ? tagName : tag.enName || tagName);
      }
      if (tag?.childrenTags) walk(tag.childrenTags);
    }
  };
  walk(result?.data);
  styleTagMapCache = map;
  return map;
}

/** 清空曲风映射缓存（测试用）。 */
function clearStyleTagCache() {
  styleTagMapCache = null;
}

/** 统一曲风名拼写：`Hiphop` / `Hip Hop` / `hip hop` -> `Hip-Hop`。 */
function normalizeGenreName(name) {
  return String(name || "").replace(/\bhip\s?hop\b/gi, "Hip-Hop");
}

/**
 * 把曲风名翻译成英文（映射不到时保留原名），并统一 `Hip-Hop` 等拼写。
 */
function translateGenreTag(title, tagMap) {
  const name = String(title || "").trim();
  if (!name) return name;
  return normalizeGenreName(tagMap.has(name) ? tagMap.get(name) : name);
}

/**
 * 拆分曲风名：复合名「父-子」（如 摇滚-流行摇滚）拆成父项与子项两段，
 * 大项、小项当作彼此独立的标签，不保留隶属关系。
 * 整名本身即分类树中的一个标签（如 Jump-Up）时不拆。
 */
function splitGenreTitle(title, tagMap) {
  const name = String(title || "").trim();
  if (!name) return [];
  if (!name.includes("-") || tagMap.has(name)) return [name];
  return name
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 获取歌曲曲风（流派）标签，返回英文名数组，如 `["Pop"]`、`["Rock", "Pop Rock"]`、`["Jazz"]`。
 *
 * 数据来自歌曲百科基础信息接口：以 `songId` 明文 POST 请求
 * `/api/song/play/about/block/page`，其中 creativeType 为 `songTag`
 * 的 creative 下的 `melody_style` 资源即为官方曲风；再经 `/api/tag/list/get`
 * 的分类树把中文名映射为英文，复合名「父-子」拆成独立的多个标签
 * （如 摇滚-流行摇滚 -> ["Rock", "Pop Rock"]）。无数据时返回 []。
 *
 * @param {number|string} songId
 * @param {object} config
 * @returns {Promise<string[]>}
 */
async function getSongGenreTags(songId, config) {
  if (!songId) return [];
  const [wikiRes, mapRes] = await Promise.allSettled([
    requestPublicApiPost("/api/song/play/about/block/page", { songId }, config),
    getStyleTagMap(config),
  ]);
  if (wikiRes.status !== "fulfilled") throw wikiRes.reason;
  const tagMap = mapRes.status === "fulfilled" ? mapRes.value : new Map();

  const result = wikiRes.value;
  const blocks = Array.isArray(result?.data?.blocks) ? result.data.blocks : [];
  const genres = [];
  for (const block of blocks) {
    const creatives = Array.isArray(block?.creatives) ? block.creatives : [];
    for (const creative of creatives) {
      if (creative?.creativeType !== "songTag") continue;
      const resources = Array.isArray(creative?.resources) ? creative.resources : [];
      for (const resource of resources) {
        if (resource?.resourceType !== "melody_style") continue;
        const title = resource?.uiElement?.mainTitle?.title;
        if (!title) continue;
        for (const segment of splitGenreTitle(title, tagMap)) {
          const english = translateGenreTag(segment, tagMap);
          if (english && !genres.includes(english)) genres.push(english);
        }
      }
    }
  }
  return genres;
}

/**
 * 合并原文与翻译歌词为双语歌词：按时间戳把翻译行插到对应原文行之后。
 * 无原文返回 null；无翻译时原样返回原文；时间戳对不上时保留原歌词。
 *
 * @param {string|null} original    lrc.lyric（原文）
 * @param {string|null} translation tlyric.lyric（翻译）
 * @returns {string|null}
 */
function mergeLyric(original, translation) {
  const base = String(original || "").replace(/\r\n?/g, "\n").trim();
  if (!base) return null;
  const trans = String(translation || "").replace(/\r\n?/g, "\n").trim();
  if (!trans) return base;

  const translationByTime = new Map();
  for (const line of trans.split("\n")) {
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) continue;
    for (const tag of parseLrcTags(line)) {
      if (!translationByTime.has(tag.ms)) translationByTime.set(tag.ms, text);
    }
  }
  if (translationByTime.size === 0) return base;

  const merged = [];
  for (const line of base.split("\n")) {
    merged.push(line);
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const tag of parseLrcTags(line)) {
      const translated = translationByTime.get(tag.ms);
      if (translated && translated !== text) {
        merged.push(`[${tag.raw}]${translated}`);
        break;
      }
    }
  }
  return merged.join("\n");
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

function getSongArtists(song) {
  const list = Array.isArray(song?.ar) ? song.ar : Array.isArray(song?.artists) ? song.artists : [];
  return list.map((item) => item.name).filter(Boolean);
}

function getSongAlbumOf(song) {
  return song?.al || song?.album || null;
}

/**
 * 歌手文件夹名以「歌曲所在专辑的所属歌手」为准（专辑详情 artists），
 * 拿不到专辑歌手时退回单曲歌手，最后兜底「未知歌手」。
 */
function resolveAlbumArtistName(song, albumInfo) {
  const albumArtists = Array.isArray(albumInfo?.artists)
    ? albumInfo.artists.map((item) => item.name).filter(Boolean)
    : [];
  if (albumArtists.length > 0) return albumArtists.join(" & ");
  if (albumInfo?.albumArtist) return String(albumInfo.albumArtist);
  const songArtists = getSongArtists(song);
  if (songArtists.length > 0) return songArtists.join(" & ");
  return "未知歌手";
}

/**
 * 生成下载路径：<下载目录>/<专辑所属歌手>/<专辑名>/<文件名>。
 * @param {object} song 歌曲详情
 * @param {object} config 配置（含 downloadDir / filenamePattern）
 * @param {string} downloadUrl 下载地址（用于推断扩展名）
 * @param {string} contentType 响应类型（用于推断扩展名）
 * @param {object|null} [albumInfo] 专辑详情，提供时按其中的 artists 作为歌手文件夹名
 */
function buildSongOutputPath(song, config, downloadUrl, contentType, albumInfo = null) {
  const name = buildSongName(song, config.filenamePattern);
  const ext = guessExtension(downloadUrl, contentType);
  const fileName = sanitizeFilename(`${name}${ext}`);
  const album = getSongAlbumOf(song);
  const albumFolder = sanitizeFilename(album?.name || "未知专辑");
  const artistFolder = sanitizeFilename(resolveAlbumArtistName(song, albumInfo));
  return path.join(config.downloadDir, artistFolder, albumFolder, fileName);
}

module.exports = {
  DEFAULT_USER_AGENT,
  QUALITY_ORDER,
  buildSongOutputPath,
  buildSongName,
  clearStyleTagCache,
  downloadFile,
  fetchImage,
  getAlbumDetail,
  getAlbumSongs,
  getLyric,
  getQualityFallbackOrder,
  getSongGenreTags,
  getSongDetail,
  getSongDetails,
  guessExtension,
  mergeLyric,
  normalizeQuality,
  parseAlbumId,
  parseCookie,
  parseSongId,
  parseTarget,
  requestPublicApi,
  requestWeapi,
  resolveAlbumArtistName,
  resolveDownloadUrl,
  sanitizeFilename,
  splitTargetList
};