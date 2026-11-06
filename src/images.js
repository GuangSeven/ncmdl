/**
 * 高清图片下载：歌手图片（artist）与专辑封面（cover）。
 *
 * 网易云图片服务（p1/p2/p3/p4.music.126.net）的地址常带 `?param=300y300` 这类缩略图参数，
 * 去掉 `param` 即可拿到原图（实测专辑封面 433~4000 像素、歌手头像 400~9837 像素）。
 * 本模块负责：
 *   - 把接口返回的图片地址归一化成原图地址（去掉缩略图参数、http -> https、去重）
 *   - 从歌手/专辑接口对象里收集候选图片地址，并按「肖像优先、横幅兜底」排序
 *   - 识别图片的真实格式与像素尺寸（接口地址常以 .jpg 结尾，内容其实是 PNG）
 *   - 按「目标文件已存在则跳过」的规则原子写入，并在同一次运行内按目标路径去重，
 *     保证整张专辑/多个专辑共用歌手文件夹时图片只下载一次
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const netease = require("./netease");

/** 歌手图片/专辑封面的固定文件名（扩展名按真实图片格式决定） */
const ARTIST_IMAGE_NAME = "artist";
const ALBUM_COVER_NAME = "cover";

/** 网易云缩略图查询参数名：?param=300y300 / ?param=1024y1024 */
const THUMBNAIL_PARAM = "param";

/** 查找已存在图片时依次尝试的扩展名 */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];

/**
 * 网易云「没有图片」时返回的默认占位图 id（p1~p4 各主机共用同一 path）。
 * 默认头像是 1024x1024 的 JPEG、默认封面是 640x420 的 PNG，看起来与正常图片无异；
 * 没有肖像的冷门歌手会返回它们，必须过滤，否则歌手文件夹会被塞进默认头像。
 */
const PLACEHOLDER_IMAGE_IDS = ["18686200114669622", "5639395138885805"];

/**
 * 判断图片地址是否为网易云默认占位图。
 *
 * @param {string} url
 * @returns {boolean}
 */
function isPlaceholderImageUrl(url) {
  const text = String(url == null ? "" : url);
  if (!text) return false;
  return PLACEHOLDER_IMAGE_IDS.some((id) => text.includes(`/${id}.`));
}

/**
 * 归一化图片地址：http 升级为 https、去掉网易云缩略图参数 `param`。
 * 非 http(s) 地址或无法解析时返回空串。
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeImageUrl(rawUrl) {
  const text = String(rawUrl == null ? "" : rawUrl).trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  url.protocol = "https:";
  // 去掉缩略图参数即得到原图；其它查询参数原样保留
  url.searchParams.delete(THUMBNAIL_PARAM);
  return url.toString();
}

/**
 * 批量归一化图片地址并去重（同时过滤默认占位图），保持传入顺序。
 *
 * @param {Array<string|undefined|null>} candidates
 * @returns {string[]}
 */
function collectHighQualityImageUrls(candidates) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const urls = [];
  const seen = new Set();
  for (const candidate of list) {
    const url = normalizeImageUrl(candidate);
    if (!url || seen.has(url) || isPlaceholderImageUrl(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** 递归摊平数组（兼容 song.ar / album.artists 等不同层级结构）。 */
function flatten(list) {
  const items = Array.isArray(list) ? list : [list];
  const out = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      out.push(...flatten(item));
    } else if (item) {
      out.push(item);
    }
  }
  return out;
}

/**
 * 收集歌手图片候选地址（已去缩略图参数并去重）。
 * 肖像字段（avatar / img1v1Url）优先于横幅字段（cover / picUrl）。
 *
 * @param {...(object|object[])} sources 歌手详情对象、歌曲 ar/artists 数组，可多层嵌套
 * @returns {string[]}
 */
function collectArtistImageUrls(...sources) {
  const candidates = [];
  for (const artist of flatten(sources)) {
    if (!artist || typeof artist !== "object") continue;
    candidates.push(artist.avatar, artist.img1v1Url, artist.cover, artist.picUrl);
  }
  return collectHighQualityImageUrls(candidates);
}

/**
 * 收集专辑封面候选地址（已去缩略图参数并去重），picUrl 优先于 blurPicUrl。
 *
 * @param {...(object|object[])} sources 专辑详情对象，可多层嵌套
 * @returns {string[]}
 */
function collectAlbumCoverUrls(...sources) {
  const candidates = [];
  for (const album of flatten(sources)) {
    if (!album || typeof album !== "object") continue;
    candidates.push(album.picUrl, album.blurPicUrl, album.coverUrl, album.cover);
  }
  return collectHighQualityImageUrls(candidates);
}

/**
 * 按字节魔数识别图片真实格式。
 *
 * @param {Buffer} buffer
 * @returns {{mime: string, ext: string}|null}
 */
function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: "image/png", ext: ".png" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: ".webp" };
  }
  if (buffer.toString("ascii", 0, 3) === "GIF") {
    return { mime: "image/gif", ext: ".gif" };
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mime: "image/bmp", ext: ".bmp" };
  }
  return null;
}

/** 解析 JPEG 的 SOF 段拿宽高。 */
function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无长度的独立标记：SOI / EOI / RSTn / TEM
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 >= buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** 解析 WebP 的 VP8X / VP8 / VP8L 头拿宽高。 */
function readWebpSize(buffer) {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

/**
 * 读取图片像素尺寸（支持 PNG / JPEG / WebP / GIF / BMP）。
 * 只用于日志与「高清」核对，解析失败时返回 null，不影响下载。
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number}|null}
 */
function readImageSize(buffer) {
  const format = detectImageFormat(buffer);
  if (!format) return null;
  if (format.ext === ".png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (format.ext === ".gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (format.ext === ".bmp" && buffer.length >= 26) {
    return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (format.ext === ".webp") return readWebpSize(buffer);
  if (format.ext === ".jpg") return readJpegSize(buffer);
  return null;
}

/**
 * 查找目标 base 路径下已存在的图片文件（如 cover.jpg / cover.png）。
 * 存在且非空即视为已完成，避免重复下载。
 *
 * @param {string} targetBasePath 不含扩展名的目标路径
 * @returns {Promise<{filePath: string, size: number}|null>}
 */
async function findExistingImage(targetBasePath) {
  for (const ext of IMAGE_EXTENSIONS) {
    const filePath = `${targetBasePath}${ext}`;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size > 0) {
        return { filePath, size: stat.size };
      }
    } catch {
      // 不存在则继续尝试下一个扩展名
    }
  }
  return null;
}

/**
 * 依次尝试候选地址下载图片，成功后按真实格式落盘（临时文件 + 重命名，避免半截文件）。
 * 全部失败时返回 failed 状态而不抛错：图片属于附加产物，不应中断歌曲下载。
 *
 * @param {string} targetBasePath 不含扩展名的目标路径，如 `<专辑文件夹>/cover`
 * @param {string[]} urls 已归一化的候选地址（按清晰度优先级排序）
 * @param {object} config 传给 fetchImage 的配置（User-Agent 等）
 * @returns {Promise<{status: "created"|"skipped"|"failed", filePath?: string, url?: string, mime?: string, size?: number, width?: number, height?: number, error?: string}>}
 */
async function saveImage(targetBasePath, urls, config = {}) {
  const existing = await findExistingImage(targetBasePath);
  if (existing) {
    return { status: "skipped", filePath: existing.filePath, size: existing.size };
  }

  const candidates = collectHighQualityImageUrls(urls);
  const failures = [];
  for (const url of candidates) {
    let buffer;
    try {
      buffer = await netease.fetchImage(url, config);
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
      continue;
    }
    const format = detectImageFormat(buffer);
    if (!format) {
      failures.push(`${url}: 返回内容不是可识别的图片`);
      continue;
    }
    const dimensions = readImageSize(buffer) || {};
    const filePath = `${targetBasePath}${format.ext}`;
    const tempFile = `${filePath}.part`;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(tempFile, buffer);
      // Windows 下 rename 不能覆盖已有文件，先删后改；目标文件此时已确认不存在
      await fs.rm(filePath, { force: true });
      await fs.rename(tempFile, filePath);
      return {
        status: "created",
        filePath,
        url,
        mime: format.mime,
        size: buffer.length,
        width: dimensions.width || 0,
        height: dimensions.height || 0,
      };
    } catch (error) {
      failures.push(`${url}: 写入文件失败（${error.message}）`);
      await fs.rm(tempFile, { force: true }).catch(() => {});
    }
  }

  return {
    status: "failed",
    error: failures.join("；") || "没有可用的图片地址",
  };
}

/**
 * 创建一次下载任务内使用的图片下载器：
 * - 同一目标路径（歌手文件夹 / 专辑文件夹）只下载一次，整张专辑的并发歌曲共享同一个 Promise
 * - 目标文件已存在则跳过（重跑不重复下载）
 *
 * @param {object} config 下载配置（userAgent 等）
 */
function createImageDownloader(config = {}) {
  const tasks = new Map();

  const runOnce = (key, loader) => {
    if (!tasks.has(key)) tasks.set(key, loader());
    return tasks.get(key);
  };

  return {
    /**
     * 在歌手文件夹根目录保存歌手高清图片（artist.*）。
     *
     * @param {string} folderPath 歌手文件夹路径
     * @param {{artistId?: number, artists?: object[]}} [options]
     *        artistId 用于请求歌手详情（首选高清肖像）；artists 为兜底图片来源（歌曲 ar 等）
     */
    downloadArtistImage(folderPath, options = {}) {
      return runOnce(`artist:${String(folderPath)}`, async () => {
        try {
          const targetBase = path.join(folderPath, ARTIST_IMAGE_NAME);
          const existing = await findExistingImage(targetBase);
          if (existing) {
            return { status: "skipped", filePath: existing.filePath, size: existing.size };
          }
          const urls = [];
          const artistId = Number(options.artistId);
          if (Number.isInteger(artistId) && artistId > 0) {
            const artistDetail = await netease.getArtistDetail(artistId, config);
            urls.push(...collectArtistImageUrls(artistDetail));
          }
          urls.push(...collectArtistImageUrls(options.artists || []));
          const candidates = collectHighQualityImageUrls(urls);
          if (candidates.length === 0) return { status: "unavailable" };
          return await saveImage(targetBase, candidates, config);
        } catch (error) {
          return { status: "failed", error: error.message };
        }
      });
    },

    /**
     * 在专辑文件夹根目录保存专辑高清封面（cover.*）。
     *
     * @param {string} folderPath 专辑文件夹路径
     * @param {object|object[]} albums 专辑详情对象（可多个，按优先级排列）
     */
    downloadAlbumCover(folderPath, albums) {
      return runOnce(`album:${String(folderPath)}`, async () => {
        try {
          const targetBase = path.join(folderPath, ALBUM_COVER_NAME);
          const existing = await findExistingImage(targetBase);
          if (existing) {
            return { status: "skipped", filePath: existing.filePath, size: existing.size };
          }
          const urls = collectAlbumCoverUrls(albums);
          if (urls.length === 0) return { status: "unavailable" };
          return await saveImage(targetBase, urls, config);
        } catch (error) {
          return { status: "failed", error: error.message };
        }
      });
    },
  };
}

module.exports = {
  ALBUM_COVER_NAME,
  ARTIST_IMAGE_NAME,
  collectAlbumCoverUrls,
  collectArtistImageUrls,
  collectHighQualityImageUrls,
  createImageDownloader,
  detectImageFormat,
  findExistingImage,
  isPlaceholderImageUrl,
  normalizeImageUrl,
  readImageSize,
  saveImage,
};
