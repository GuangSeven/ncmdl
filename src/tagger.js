/**
 * 音乐文件标签写入器（无第三方依赖）
 *
 * - FLAC：Vorbis Comment + PICTURE 块（参考 myuserscripts 的 MetaFlac 实现移植为 Node 版）
 * - MP3：ID3v2.3 标签（标题/歌手/专辑/曲目/碟号/年份/专辑艺人/发行公司/歌词/封面）
 *
 * 文本帧统一用 UTF-16（带 BOM）编码，兼容中文。
 */

const path = require("node:path");

// ---------------- FLAC ----------------

const FLAC_STREAMINFO = 0;
const FLAC_PADDING = 1;
const FLAC_APPLICATION = 2;
const FLAC_SEEKTABLE = 3;
const FLAC_VORBIS_COMMENT = 4;
const FLAC_CUESHEET = 5;
const FLAC_PICTURE = 6;

function buildVorbisComment(vendor, tags) {
  const vendorBytes = Buffer.from(vendor || "reference libFLAC 1.4.3 20230623", "utf8");
  const tagBuffers = tags.map((t) => Buffer.from(t, "utf8"));
  const total = 4 + vendorBytes.length + 4 + tagBuffers.reduce((s, b) => s + 4 + b.length, 0);
  const out = Buffer.alloc(total);
  let off = 0;
  out.writeUInt32LE(vendorBytes.length, off);
  off += 4;
  vendorBytes.copy(out, off);
  off += vendorBytes.length;
  out.writeUInt32LE(tagBuffers.length, off);
  off += 4;
  for (const b of tagBuffers) {
    out.writeUInt32LE(b.length, off);
    off += 4;
    b.copy(out, off);
    off += b.length;
  }
  return out;
}

function buildPictureBlock(picture, mime) {
  const data = Buffer.isBuffer(picture) ? picture : Buffer.from(picture);
  const mimeBytes = Buffer.from(mime, "ascii");
  const descBytes = Buffer.alloc(0);
  const type = Buffer.alloc(4);
  type.writeUInt32BE(3, 0); // cover (front)
  const mimeLen = Buffer.alloc(4);
  mimeLen.writeUInt32BE(mimeBytes.length, 0);
  const descLen = Buffer.alloc(4);
  descLen.writeUInt32BE(descBytes.length, 0);
  const width = Buffer.alloc(4);
  const height = Buffer.alloc(4);
  const depth = Buffer.alloc(4);
  depth.writeUInt32BE(24, 0);
  const colors = Buffer.alloc(4);
  const dataLen = Buffer.alloc(4);
  dataLen.writeUInt32BE(data.length, 0);
  return Buffer.concat([type, mimeLen, mimeBytes, descLen, descBytes, width, height, depth, colors, dataLen, data]);
}

/**
 * 为 FLAC 字节流写入 Vorbis Comment 与封面，返回新字节流。
 * 保留 STREAMINFO / SEEKTABLE 等块，替换已有的 Comment/Picture。
 *
 * @param {Buffer} flac
 * @param {{vendor?: string, tags?: string[]}} options  tags 形如 ["TITLE=xxx", "ARTIST=yyy"]
 * @param {Buffer|null} picture
 * @param {string} [pictureMime]
 * @returns {Buffer}
 */
function tagFlac(flac, options, picture = null, pictureMime = "image/jpeg") {
  const tags = options.tags || [];
  const vendor = options.vendor || "reference libFLAC 1.4.3 20230623";
  if (!Buffer.isBuffer(flac)) flac = Buffer.from(flac);
  if (flac.slice(0, 4).toString("ascii") !== "fLaC") {
    throw new Error("不是有效的 FLAC 文件");
  }

  let offset = 4;
  const blocks = []; // { type, data, isLast }
  while (offset < flac.length) {
    const headerByte = flac[offset];
    const isLast = (headerByte & 0x80) !== 0;
    const type = headerByte & 0x7f;
    const length = (flac[offset + 1] << 16) | (flac[offset + 2] << 8) | flac[offset + 3];
    offset += 4;
    const data = flac.slice(offset, offset + length);
    offset += length;
    blocks.push({ type, data, isLast });
    if (isLast) break;
  }
  const framesStart = offset;

  const keepTypes = [FLAC_APPLICATION, FLAC_SEEKTABLE, FLAC_CUESHEET];
  const out = [];
  out.push(flac.slice(0, 4));

  // 第一块必须是 STREAMINFO
  let appendedStreamInfo = false;
  for (const block of blocks) {
    if (block.type === FLAC_STREAMINFO) {
      out.push(buildMetadataBlock(FLAC_STREAMINFO, block.data, false));
      appendedStreamInfo = true;
    } else if (keepTypes.includes(block.type)) {
      out.push(buildMetadataBlock(block.type, block.data, false));
    }
    // VORBIS_COMMENT / PICTURE / PADDING 由下面重建
  }
  if (!appendedStreamInfo) {
    throw new Error("FLAC 文件缺少 STREAMINFO 块");
  }

  // 重建 Vorbis Comment
  out.push(buildMetadataBlock(FLAC_VORBIS_COMMENT, buildVorbisComment(vendor, tags), false));

  // 封面
  if (picture && picture.length > 0) {
    out.push(buildMetadataBlock(FLAC_PICTURE, buildPictureBlock(picture, pictureMime), false));
  }

  // 保留原 PADDING（若无则补 8192 字节）
  let padding = blocks.find((b) => b.type === FLAC_PADDING);
  const paddingSize = padding ? Math.max(padding.data.length, 8192) : 8192;
  out.push(buildMetadataBlock(FLAC_PADDING, Buffer.alloc(paddingSize, 0), true));

  return Buffer.concat([...out, flac.slice(framesStart)]);
}

function buildMetadataBlock(type, data, isLast) {
  const header = Buffer.alloc(4);
  let t = type;
  if (isLast) t += 0x80;
  header[0] = t;
  header[1] = (data.length >> 16) & 0xff;
  header[2] = (data.length >> 8) & 0xff;
  header[3] = data.length & 0xff;
  return Buffer.concat([header, data]);
}

// ---------------- MP3 (ID3v2.3) ----------------

function utf16WithBom(str) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(str), "utf16le")]);
}

function buildId3Frame(id, data) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length, 0);
  return Buffer.concat([Buffer.from(id, "ascii"), size, Buffer.from([0, 0]), data]);
}

function buildTextFrame(id, value) {
  if (value === undefined || value === null || String(value).length === 0) return null;
  return buildId3Frame(id, Buffer.concat([Buffer.from([1]), utf16WithBom(value)]));
}

function synchsafe(value) {
  const out = Buffer.alloc(4);
  out[0] = (value >> 21) & 0x7f;
  out[1] = (value >> 14) & 0x7f;
  out[2] = (value >> 7) & 0x7f;
  out[3] = value & 0x7f;
  return out;
}

function detectImageMime(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  return "image/jpeg";
}

/**
 * 构建完整 ID3v2.3 标签。
 * @param {object} tags  { title, artist, album, track, disc, year, albumArtist, publisher, lyric, cover:{mime,data} }
 */
function buildId3v23(tags = {}) {
  const frames = [];
  const addText = (id, value) => {
    const frame = buildTextFrame(id, value);
    if (frame) frames.push(frame);
  };

  addText("TIT2", tags.title);
  addText("TPE1", tags.artist);
  addText("TALB", tags.album);
  addText("TRCK", tags.track);
  addText("TPOS", tags.disc);
  addText("TDRC", tags.year);
  addText("TPE2", tags.albumArtist);
  addText("TPUB", tags.publisher);

  if (tags.lyric) {
    const encoding = Buffer.from([1]);
    const language = Buffer.from("chi", "ascii");
    const descriptor = Buffer.from([0, 0]); // UTF-16 空描述符
    const lyric = utf16WithBom(tags.lyric);
    frames.push(buildId3Frame("USLT", Buffer.concat([encoding, language, descriptor, lyric])));
  }

  if (tags.cover && tags.cover.data && tags.cover.data.length > 0) {
    const coverData = Buffer.isBuffer(tags.cover.data) ? tags.cover.data : Buffer.from(tags.cover.data);
    const mime = tags.cover.mime || detectImageMime(coverData);
    const encoding = Buffer.from([1]);
    const mimeBytes = Buffer.from(mime, "ascii");
    const type = Buffer.from([3]); // cover (front)
    const descriptor = Buffer.from([0, 0]); // UTF-16 空描述符
    frames.push(
      buildId3Frame("APIC", Buffer.concat([encoding, mimeBytes, type, descriptor, coverData]))
    );
  }

  const paddingBytes = Buffer.alloc(1024, 0);
  const size = frames.reduce((s, f) => s + f.length, 0) + paddingBytes.length;
  const header = Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([3, 0]), // v2.3.0
    Buffer.from([0]), // flags: 无压缩/加密/扩展头
    synchsafe(size),
  ]);
  return Buffer.concat([header, ...frames, paddingBytes]);
}

/**
 * 为 MP3 字节流写入 ID3v2.3 标签，返回新字节流。
 * 若文件头已有 ID3 则整体替换（避免旧帧残留）。
 */
function tagMp3(mp3, tags) {
  if (!Buffer.isBuffer(mp3)) mp3 = Buffer.from(mp3);
  const id3 = buildId3v23(tags);
  if (mp3.slice(0, 3).toString("ascii") === "ID3") {
    const versionMajor = mp3[3];
    // 读取原标签大小（synchsafe），兼容 v2.3/v2.4；v2.2 头同样 10 字节
    const size =
      ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
    let tagEnd = 10 + size;
    // v2.4 若有扩展头（flags bit6），需跳过扩展头
    if (versionMajor === 4 && (mp3[5] & 0x40) !== 0 && tagEnd + 4 <= mp3.length) {
      const extSize = ((mp3[tagEnd] & 0x7f) << 21) | ((mp3[tagEnd + 1] & 0x7f) << 14) | ((mp3[tagEnd + 2] & 0x7f) << 7) | (mp3[tagEnd + 3] & 0x7f);
      tagEnd += 4 + extSize;
    }
    return Buffer.concat([id3, mp3.slice(tagEnd)]);
  }
  return Buffer.concat([id3, mp3]);
}

// ---------------- 元数据收集与入口 ----------------

const netease = require("./netease");

function dateDesc(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSongArtists(song) {
  const list = Array.isArray(song?.ar) ? song.ar : Array.isArray(song?.artists) ? song.artists : [];
  return list.map((a) => a.name).filter(Boolean);
}

/** weapi 详情用 al、公开接口用 album，两种结构都兼容 */
function getSongAlbum(song) {
  return song?.al || song?.album || null;
}

/**
 * 收集标签所需的所有元数据（歌词 / 专辑详情 / 封面）。
 * 每个数据源独立容错：单个失败不阻断整体，返回 null 字段。
 * 公开接口的 song.album 已含 company/publishTime/artists，无需额外请求。
 *
 * @returns {Promise<{lyric: string|null, albumDetail: object|null, cover: Buffer|null, coverMime: string}>}
 */
async function collectSongMetadata(song, config) {
  const songId = song?.id;
  const album = getSongAlbum(song);
  const albumId = album?.id;
  const picUrl = album?.picUrl;
  // 公开接口 song.album 自带完整专辑信息；weapi 的 al 只有基础字段，需要补请求
  const albumHasDetail = album && (album.company || album.publishTime || Array.isArray(album.artists));

  const [lyric, albumDetail, coverRes] = await Promise.allSettled([
    songId ? netease.getLyric(songId, config).then((r) => r?.lrc?.lyric || null) : Promise.resolve(null),
    albumId && !albumHasDetail
      ? netease.getAlbumDetail(albumId, config).then((r) => r?.album || r || null)
      : Promise.resolve(albumHasDetail ? album : null),
    picUrl ? netease.fetchImage(picUrl, config) : Promise.resolve(null),
  ]);

  return {
    lyric: lyric.status === "fulfilled" ? lyric.value : null,
    albumDetail: albumDetail.status === "fulfilled" ? albumDetail.value : null,
    cover: coverRes.status === "fulfilled" ? coverRes.value : null,
    coverMime: coverRes.status === "fulfilled" && coverRes.value ? detectImageMime(coverRes.value) : "image/jpeg",
  };
}

/**
 * 构造标签字段并写入音乐文件（按扩展名选择 FLAC/MP3 写入器）。
 * 就地改写文件。
 *
 * @param {string} filePath
 * @param {object} song    歌曲详情对象
 * @param {{lyric: string|null, albumDetail: object|null, cover: Buffer|null, coverMime: string}} meta
 * @returns {string} 写入的标签摘要
 */
function writeMusicTags(filePath, song, meta) {
  const ext = path.extname(filePath).toLowerCase();
  const artists = getSongArtists(song);
  const album = getSongAlbum(song);
  const trackNo = song?.no && song.no > 0 ? String(song.no).padStart(2, "0") : null;
  const discNo = song?.cd ? String(song.cd) : null;
  const albumDetail = meta.albumDetail || album || {};
  const year = dateDesc(albumDetail.publishTime);
  const publisher = albumDetail.company || null;
  const albumArtists = Array.isArray(albumDetail.artists)
    ? albumDetail.artists.map((a) => a.name).join(" / ")
    : null;
  const lyric = meta.lyric || null;

  const tags = {
    title: song?.name || null,
    artist: artists.join(" / ") || null,
    album: album?.name || null,
    track: trackNo,
    disc: discNo,
    year,
    albumArtist: albumArtists,
    publisher,
    lyric,
  };

  const input = require("node:fs").readFileSync(filePath);
  let output;
  if (ext === ".flac") {
    const flacTags = [];
    if (tags.title) flacTags.push(`TITLE=${tags.title}`);
    if (tags.artist) flacTags.push(`ARTIST=${tags.artist}`);
    if (tags.album) flacTags.push(`ALBUM=${tags.album}`);
    if (tags.track) flacTags.push(`TRACKNUMBER=${tags.track}`);
    if (tags.disc) flacTags.push(`DISCNUMBER=${tags.disc}`);
    if (tags.year) flacTags.push(`DATE=${tags.year}`);
    if (tags.albumArtist) flacTags.push(`ALBUMARTIST=${tags.albumArtist}`);
    if (tags.publisher) flacTags.push(`PUBLISHER=${tags.publisher}`);
    if (tags.lyric) flacTags.push(`LYRICS=${tags.lyric}`);
    output = tagFlac(input, { tags: flacTags }, meta.cover, meta.coverMime);
  } else if (ext === ".mp3") {
    output = tagMp3(input, { ...tags, cover: meta.cover ? { data: meta.cover, mime: meta.coverMime } : null });
  } else {
    throw new Error(`不支持的文件类型: ${ext}`);
  }

  require("node:fs").writeFileSync(filePath, output);
  return [
    tags.title && `标题=${tags.title}`,
    tags.artist && `歌手=${tags.artist}`,
    tags.album && `专辑=${tags.album}`,
    tags.year && `日期=${tags.year}`,
    tags.track && `曲目=${tags.track}`,
    tags.lyric && "歌词",
    meta.cover && "封面",
  ]
    .filter(Boolean)
    .join("，");
}

module.exports = {
  collectSongMetadata,
  dateDesc,
  detectImageMime,
  tagFlac,
  tagMp3,
  writeMusicTags,
};
