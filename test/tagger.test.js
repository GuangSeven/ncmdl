const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectSongMetadata,
  dateDesc,
  detectImageMime,
  tagFlac,
  tagMp3,
  writeMusicTags
} = require("../src/tagger");

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(payload),
    headers: { get: () => "application/json" },
  };
}

// ---------------- FLAC ----------------

/** 构造最小 FLAC：marker + STREAMINFO + PADDING + 音频帧数据 */
function buildMinimalFlac() {
  const streamInfo = Buffer.alloc(34, 0x11);
  const header1 = Buffer.from([0, 0, 0, 34]); // STREAMINFO, 非最后一块
  const padding = Buffer.alloc(64, 0);
  const header2 = Buffer.from([0x81, 0, 0, 64]); // PADDING, 最后一块
  return Buffer.concat([
    Buffer.from("fLaC", "ascii"),
    header1, streamInfo,
    header2, padding,
    Buffer.from("AUDIOFRAMES0123456789", "ascii"),
  ]);
}

function parseFlacBlocks(flac) {
  assert.equal(flac.slice(0, 4).toString("ascii"), "fLaC");
  let offset = 4;
  const blocks = [];
  while (offset < flac.length) {
    const headerByte = flac[offset];
    const isLast = (headerByte & 0x80) !== 0;
    const type = headerByte & 0x7f;
    const length = (flac[offset + 1] << 16) | (flac[offset + 2] << 8) | flac[offset + 3];
    const data = flac.slice(offset + 4, offset + 4 + length);
    blocks.push({ type, isLast, data });
    offset += 4 + length;
    if (isLast) break;
  }
  return { blocks, framesStart: offset };
}

function parseVorbisComments(data) {
  const vendorLen = data.readUInt32LE(0);
  const commentCount = data.readUInt32LE(4 + vendorLen);
  const tags = [];
  let offset = 4 + vendorLen + 4;
  for (let i = 0; i < commentCount; i++) {
    const len = data.readUInt32LE(offset);
    offset += 4;
    tags.push(data.slice(offset, offset + len).toString("utf8"));
    offset += len;
  }
  return tags;
}

test("tagFlac writes vorbis comments and keeps audio frames", () => {
  const input = buildMinimalFlac();
  const tags = [
    "TITLE=测试歌曲",
    "ARTIST=歌手A / 歌手B",
    "ALBUM=专辑名",
    "TRACKNUMBER=02",
    "DATE=2024-05-06",
    "ALBUMARTIST=专辑艺人",
    "PUBLISHER=唱片公司",
    "LYRICS=[00:00.00] 歌词内容",
  ];
  const output = tagFlac(input, { tags });
  const { blocks, framesStart } = parseFlacBlocks(output);

  const vc = blocks.find((b) => b.type === 4); // VORBIS_COMMENT
  assert.ok(vc, "should contain VORBIS_COMMENT block");
  const parsedTags = parseVorbisComments(vc.data);
  assert.ok(parsedTags.includes("TITLE=测试歌曲"));
  assert.ok(parsedTags.includes("DATE=2024-05-06"));
  assert.ok(parsedTags.includes("LYRICS=[00:00.00] 歌词内容"));
  assert.ok(parsedTags.includes("TRACKNUMBER=02"));

  // 音频帧数据保留
  assert.equal(output.slice(framesStart).toString("ascii"), "AUDIOFRAMES0123456789");
  // STREAMINFO 保留
  const si = blocks.find((b) => b.type === 0);
  assert.equal(si.data.length, 34);
  // 最后一块是 PADDING
  assert.equal(blocks[blocks.length - 1].type, 1);
  assert.equal(blocks[blocks.length - 1].isLast, true);
});

test("tagFlac writes picture block", () => {
  const input = buildMinimalFlac();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(16, 0xaa), Buffer.from([0xff, 0xd9])]);
  const output = tagFlac(input, { tags: ["TITLE=x"] }, jpeg, "image/jpeg");
  const { blocks } = parseFlacBlocks(output);
  const pic = blocks.find((b) => b.type === 6);
  assert.ok(pic, "should contain PICTURE block");
  // type=3(cover front), mime=image/jpeg, 数据在末尾
  assert.equal(pic.data.readUInt32BE(0), 3);
  const mimeLen = pic.data.readUInt32BE(4);
  assert.equal(pic.data.slice(8, 8 + mimeLen).toString("ascii"), "image/jpeg");
  const dataLenOffset = 8 + mimeLen + 4 + 0 + 16; // mime + descLen + desc + w/h/depth/colors(16)
  const dataLen = pic.data.readUInt32BE(dataLenOffset);
  assert.equal(dataLen, jpeg.length);
  assert.ok(pic.data.slice(dataLenOffset + 4).equals(jpeg));
});

test("tagFlac replaces existing comments", () => {
  const first = tagFlac(buildMinimalFlac(), { tags: ["TITLE=旧标题", "ARTIST=旧歌手"] });
  const second = tagFlac(first, { tags: ["TITLE=新标题"] });
  const { blocks } = parseFlacBlocks(second);
  const vc = blocks.find((b) => b.type === 4);
  const parsedTags = parseVorbisComments(vc.data);
  assert.ok(parsedTags.includes("TITLE=新标题"));
  assert.ok(!parsedTags.includes("ARTIST=旧歌手"), "old tags should be replaced");
});

test("tagFlac rejects non-flac input", () => {
  assert.throws(() => tagFlac(Buffer.from("RIFFnotflac"), { tags: [] }), /FLAC/);
});

test("tagFlac requires STREAMINFO", () => {
  const bad = Buffer.concat([Buffer.from("fLaC", "ascii"), Buffer.from([0x81, 0, 0, 4]), Buffer.alloc(4)]);
  assert.throws(() => tagFlac(bad, { tags: [] }), /STREAMINFO/);
});

// ---------------- MP3 ----------------

function parseId3(mp3) {
  assert.equal(mp3.slice(0, 3).toString("ascii"), "ID3");
  const version = mp3[3];
  if (!version) throw new Error("missing version byte");
  const size = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  const frames = {};
  let offset = 10;
  const end = 10 + size;
  while (offset + 10 <= end) {
    const id = mp3.slice(offset, offset + 4).toString("ascii");
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    // v2.3 帧大小是普通 32 位大端；v2.4 是 synchsafe（每字节 7 位）
    const frameSize =
      version === 4
        ? ((mp3[offset + 4] & 0x7f) << 21) | ((mp3[offset + 5] & 0x7f) << 14) | ((mp3[offset + 6] & 0x7f) << 7) | (mp3[offset + 7] & 0x7f)
        : mp3.readUInt32BE(offset + 4);
    frames[id] = mp3.slice(offset + 10, offset + 10 + frameSize);
    offset += 10 + frameSize;
  }
  return { frames, tagEnd: end, version };
}

function decodeTextFrame(frameData) {
  const encoding = frameData[0];
  const text = frameData.slice(1);
  if (encoding === 1) {
    return text.slice(2).toString("utf16le"); // 去掉 BOM
  }
  return text.toString("utf8");
}

test("tagMp3 inserts ID3v2.4 when absent", () => {
  const raw = Buffer.from("RAWMP3FRAMEDATA", "ascii");
  const output = tagMp3(raw, { title: "歌名", artist: "歌手", year: "2024-05-06" });
  const { frames, tagEnd, version } = parseId3(output);
  assert.equal(version, 4, "header should declare v2.4");
  assert.equal(decodeTextFrame(frames.TIT2), "歌名");
  assert.equal(decodeTextFrame(frames.TPE1), "歌手");
  // v2.4 用单个 TDRC 存完整日期（取代 v2.3 的 TYER/TDAT），且数字字符串用 encoding 0
  assert.equal(frames.TDRC[0], 0, "TDRC 编码应为 ISO-8859-1");
  assert.equal(decodeTextFrame(frames.TDRC), "2024-05-06");
  assert.equal(frames.TYER, undefined, "v2.4 标签不应出现 TYER");
  assert.equal(frames.TDAT, undefined, "v2.4 标签不应出现 TDAT");
  assert.equal(output.slice(tagEnd).toString("ascii"), "RAWMP3FRAMEDATA");
});

test("tagMp3 v2.4 帧大小用 synchsafe 编码（大帧也能正确解析）", () => {
  const lyric = "A".repeat(16700); // 帧体 > 32KB，逼出多字节 synchsafe 大小
  const output = tagMp3(Buffer.from("DATA"), { title: "t", lyric });
  const { frames } = parseId3(output);
  const usltOffset = output.indexOf(Buffer.from("USLT", "ascii"));
  assert.ok(usltOffset > 0, "should contain USLT frame");
  // v2.4 帧大小每字节最高位必须是 0；若回退成普通 32 位大端会破坏 synchsafe 约束
  assert.deepEqual(
    Array.from(output.slice(usltOffset + 4, usltOffset + 8)).map((b) => (b & 0x80) === 0),
    [true, true, true, true],
    "frame size must be synchsafe"
  );
  // USLT = encoding(1) + lang(3) + 描述符(2) + BOM(2) + 文本
  assert.equal(frames.USLT.slice(8).toString("utf16le"), lyric);
});

test("tagMp3 仅年份时写入 TDRC，且空年份不写帧", () => {
  const output = tagMp3(Buffer.from("DATA"), { title: "t", year: "2024" });
  const { frames } = parseId3(output);
  assert.equal(decodeTextFrame(frames.TDRC), "2024");
  assert.equal(frames.TYER, undefined);
  assert.equal(frames.TDAT, undefined);

  const empty = tagMp3(Buffer.from("DATA"), { title: "t", year: null });
  assert.equal(parseId3(empty).frames.TDRC, undefined);
});

function synchsafeTest(value) {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

test("tagMp3 替换已有 v2.4 标签：扩展头含在标签大小内，不额外跳过", () => {
  // 旧 v2.4：header(10) + 扩展头(4 synchsafe size 含自身 + 2 个 flag 字节 = 6) + TIT2 帧(共 14 字节)
  const frame = Buffer.concat([
    Buffer.from("TIT2"),
    synchsafeTest(4), Buffer.from([0, 0]),
    Buffer.from([0, 0x41, 0x42, 0]),
  ]);
  const extHeader = Buffer.concat([
    synchsafeTest(6), // 整个扩展头大小，synchsafe、含自身
    Buffer.from([0x01, 0x00]), // 1 个 flag 字节 + 扩展 flags=0
  ]);
  const tagSize = 6 + frame.length;
  const oldTag = Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([4, 0, 0x40]), // flags bit6: 有扩展头
    synchsafeTest(tagSize),
    extHeader,
    frame,
  ]);
  const input = Buffer.concat([oldTag, Buffer.from("MP3DATA", "ascii")]);
  const output = tagMp3(input, { album: "新专辑" });
  const { frames, tagEnd } = parseId3(output);
  assert.equal(decodeTextFrame(frames.TALB), "新专辑");
  assert.equal(frames.TIT2, undefined, "旧帧应被整体替换");
  assert.equal(output.slice(tagEnd).toString("ascii"), "MP3DATA", "不应因扩展头多跳字节而吃掉音频");
});

test("tagMp3 替换已有 v2.3 标签：扩展头同样含在标签大小内", () => {
  // v2.3 扩展头 = size(4, 不含自身) + flags(2) + padding size(4)，extSize=6 时磁盘上共 10 字节
  const frame = Buffer.concat([
    Buffer.from("TIT2"),
    Buffer.from([0, 0, 0, 4]), Buffer.from([0, 0]),
    Buffer.from([0, 0x41, 0x42, 0]),
  ]);
  const extHeader = Buffer.concat([
    Buffer.from([0, 0, 0, 6]),
    Buffer.from([0, 0]),
    Buffer.from([0, 0, 0, 0]),
  ]);
  const tagSize = extHeader.length + frame.length;
  const oldTag = Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([3, 0, 0x40]),
    synchsafeTest(tagSize),
    extHeader,
    frame,
  ]);
  const input = Buffer.concat([oldTag, Buffer.from("MP3DATA", "ascii")]);
  const output = tagMp3(input, { album: "新专辑" });
  const { frames, tagEnd } = parseId3(output);
  assert.equal(decodeTextFrame(frames.TALB), "新专辑");
  assert.equal(output.slice(tagEnd).toString("ascii"), "MP3DATA");
});

test("tagMp3 替换已有 v2.4 标签：脚部（footer）一并跳过", () => {
  // 旧 v2.4：header(10) + TIT2 帧(共 14 字节) + footer(10)，音频在 footer 之后；
  // 声明大小不含 footer（v2.4 §3.1：footer 存在时 = total size - 20）
  const frame = Buffer.concat([
    Buffer.from("TIT2"),
    synchsafeTest(4), Buffer.from([0, 0]),
    Buffer.from([0, 0x41, 0x42, 0]),
  ]);
  const tagSize = frame.length;
  const oldTag = Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([4, 0, 0x10]), // flags bit4: 有脚部
    synchsafeTest(tagSize),
    frame,
    Buffer.from("3DI", "ascii"),
    Buffer.from([4, 0, 0x10]),
    synchsafeTest(tagSize),
    Buffer.from("MP3DATA", "ascii"),
  ]);
  const output = tagMp3(oldTag, { album: "新专辑" });
  const { frames, tagEnd } = parseId3(output);
  assert.equal(decodeTextFrame(frames.TALB), "新专辑");
  assert.equal(output.slice(tagEnd).toString("ascii"), "MP3DATA", "footer 的 10 字节应被跳过");
});

test("tagMp3 replaces existing ID3 tag", () => {
  // 合法的旧 v2.3 标签：header(size=14) + TIT2 帧(4+4+2+4)
  const oldHeader = Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([3, 0, 0]),
    Buffer.from([0, 0, 0, 14]), // synchsafe 14
    Buffer.from("TIT2"), Buffer.from([0, 0, 0, 4]), Buffer.from([0, 0]),
    Buffer.from([0, 0xff, 0xfe, 0x00]),
  ]);
  const raw = Buffer.from("MP3DATA", "ascii");
  const input = Buffer.concat([oldHeader, raw]);
  const output = tagMp3(input, { title: "新歌名", album: "新专辑" });
  const { frames, tagEnd } = parseId3(output);
  assert.equal(decodeTextFrame(frames.TIT2), "新歌名");
  assert.equal(decodeTextFrame(frames.TALB), "新专辑");
  assert.equal(output.slice(tagEnd).toString("ascii"), "MP3DATA");
});

test("tagMp3 writes USLT lyric and APIC cover", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(8, 0xaa), Buffer.from([0xff, 0xd9])]);
  const output = tagMp3(Buffer.from("DATA"), {
    title: "t",
    lyric: "[00:00.00] 歌词",
    cover: { data: jpeg, mime: "image/jpeg" },
  });
  const { frames } = parseId3(output);
  assert.ok(frames.USLT, "should contain USLT");
  // USLT data = encoding(1) + lang(3) + descriptor(2) + text
  const usltText = frames.USLT.slice(6).toString("utf16le");
  assert.ok(usltText.includes("歌词"));
  assert.ok(frames.APIC, "should contain APIC");
  // APIC data = encoding(1) + mime + type(1) + descriptor(2) + picture
  assert.equal(frames.APIC.slice(1, 11).toString("ascii"), "image/jpeg");
});

test("tagMp3 writes TCON genre frame", () => {
  const output = tagMp3(Buffer.from("DATA"), { title: "t", genre: "流行; 摇滚" });
  const { frames } = parseId3(output);
  assert.equal(decodeTextFrame(frames.TCON), "流行; 摇滚");
});

test("tagMp3 writes COMM comment frame", () => {
  const output = tagMp3(Buffer.from("DATA"), { title: "t", comment: "专辑简介文本" });
  const { frames } = parseId3(output);
  const comm = frames.COMM;
  assert.ok(comm, "should contain COMM");
  // COMM = encoding(1) + language(3) + descriptor(2，UTF-16 空描述符) + text(BOM + UTF-16 + 终止符 00 00)
  assert.equal(comm[0], 1, "UTF-16 encoding");
  assert.equal(comm.slice(1, 4).toString("ascii"), "chi");
  assert.deepEqual(Array.from(comm.slice(4, 6)), [0, 0], "UTF-16 空描述符");
  assert.equal(comm.slice(8, -2).toString("utf16le"), "专辑简介文本");
  assert.deepEqual(Array.from(comm.slice(-2)), [0, 0], "文本以 UTF-16 终止符结尾");
});

test("tagMp3 APIC: mime 以 0x00 结尾且图片数据完整", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])]);
  const output = tagMp3(Buffer.from("DATA"), {
    title: "t",
    cover: { data: jpeg, mime: "image/jpeg" },
  });
  const { frames } = parseId3(output);
  const apic = frames.APIC;
  assert.ok(apic, "should contain APIC");
  // 解析方式与播放器一致：enc(1) + mime + 0x00 + type(1) + 描述符 + 图片
  const mimeEnd = apic.indexOf(0, 1);
  assert.ok(mimeEnd > 1, "mime must be null terminated");
  assert.equal(apic.slice(1, mimeEnd).toString("ascii"), "image/jpeg");
  assert.equal(apic[mimeEnd + 1], 3, "picture type should be cover front");
  const descStart = mimeEnd + 2;
  assert.deepEqual(Array.from(apic.slice(descStart, descStart + 2)), [0, 0], "UTF-16 空描述符");
  assert.ok(apic.slice(descStart + 2).equals(jpeg), "image bytes should be intact");
});

test("writeMusicTags: MP3 年份写入 TDRC（v2.4）并在摘要中报告", () => {
  const file = path.join(os.tmpdir(), `ncmdl-test-${process.pid}-${Date.now()}.mp3`);
  fs.writeFileSync(file, Buffer.from("MP3AUDIO", "ascii"));
  try {
    const summary = writeMusicTags(
      file,
      { name: "歌", ar: [{ name: "甲" }], al: { name: "专" } },
      {
        lyric: null,
        genre: [],
        albumDetail: { name: "专", publishTime: 1374940800000 },
        cover: null,
        coverMime: "image/jpeg",
      }
    );
    const { frames } = parseId3(fs.readFileSync(file));
    // dateDesc(1374940800000) === "2013-07-28"
    assert.equal(decodeTextFrame(frames.TDRC), "2013-07-28");
    assert.equal(frames.TYER, undefined, "v2.4 标签不应出现 TYER");
    assert.equal(frames.TDAT, undefined, "v2.4 标签不应出现 TDAT");
    assert.ok(summary.includes("日期=2013-07-28"));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("writeMusicTags: MP3 写入封面", () => {
  const file = path.join(os.tmpdir(), `ncmdl-test-${process.pid}-${Date.now()}.mp3`);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(32, 0x22), Buffer.from([0xff, 0xd9])]);
  fs.writeFileSync(file, Buffer.from("MP3AUDIO", "ascii"));
  try {
    const summary = writeMusicTags(
      file,
      { name: "歌", ar: [{ name: "甲" }], al: { name: "专" } },
      { lyric: null, genre: [], albumDetail: null, cover: jpeg, coverMime: "image/jpeg" }
    );
    const { frames } = parseId3(fs.readFileSync(file));
    const apic = frames.APIC;
    assert.ok(apic, "should contain APIC");
    const mimeEnd = apic.indexOf(0, 1);
    assert.equal(apic.slice(1, mimeEnd).toString("ascii"), "image/jpeg");
    assert.ok(apic.slice(mimeEnd + 4).equals(jpeg), "image bytes should be intact");
    assert.ok(summary.includes("封面"));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("tagMp3 skips empty optional fields", () => {
  const output = tagMp3(Buffer.from("DATA"), { title: "只有标题", track: null, disc: null, lyric: null, comment: null });
  const { frames } = parseId3(output);
  assert.ok(frames.TIT2);
  assert.equal(frames.TRCK, undefined);
  assert.equal(frames.TPOS, undefined);
  assert.equal(frames.USLT, undefined);
  assert.equal(frames.COMM, undefined);
});

// ---------------- 工具 ----------------

test("dateDesc formats YYYY-MM-DD", () => {
  assert.equal(dateDesc(1374940800000), "2013-07-28");
  assert.equal(dateDesc(0), "");
  assert.equal(dateDesc(null), "");
  assert.equal(dateDesc("bad"), "");
});

test("detectImageMime detects png and defaults jpeg", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  assert.equal(detectImageMime(png), "image/png");
  assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff])), "image/jpeg");
});

test("collectSongMetadata: 使用预取的专辑详情而不再请求", async () => {
  const meta = await collectSongMetadata(
    { name: "solo", al: { id: 5, name: "专辑" } },
    { cookie: "" },
    { id: 5, name: "专辑", company: "厂牌", publishTime: 0 }
  );
  assert.equal(meta.albumDetail.company, "厂牌");
  assert.equal(meta.lyric, null);
  assert.equal(meta.cover, null);
  assert.deepEqual(meta.genre, []);
});

test("collectSongMetadata: 合并翻译歌词并抓取曲风", async () => {
  const original = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/api/tag/list/get")) {
      return jsonResponse({ code: 200, data: [{ tagName: "爵士", enName: "Jazz" }] });
    }
    if (target.includes("/api/song/play/about/block/page")) {
      return jsonResponse({
        code: 200,
        data: {
          blocks: [
            {
              creatives: [
                {
                  creativeType: "songTag",
                  resources: [
                    { resourceType: "melody_style", uiElement: { mainTitle: { title: "爵士" } } },
                  ],
                },
              ],
            },
          ],
        },
      });
    }
    if (target.includes("/api/song/lyric")) {
      return jsonResponse({ lrc: { lyric: "[00:01.00]Hello" }, tlyric: { lyric: "[00:01.00]你好" } });
    }
    throw new Error(`unexpected request: ${target}`);
  };
  try {
    const meta = await collectSongMetadata(
      { id: 100, name: "s", al: { id: 5, name: "专辑" } },
      { cookie: "" },
      { id: 5, name: "专辑", company: "厂牌", publishTime: 0 }
    );
    assert.deepEqual(meta.genre, ["Jazz"]);
    assert.equal(meta.lyric, "[00:01.00]Hello\n[00:01.00]你好");
  } finally {
    global.fetch = original;
  }
});

test("collectSongMetadata: song 有详情但缺专辑简介时补请求专辑接口", async () => {
  const requested = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    requested.push(target);
    if (target.includes("/api/v1/album")) {
      return jsonResponse({
        code: 200,
        album: { id: 5, name: "专辑", publishTime: 0, company: "厂牌", description: "简介第一行\n简介第二行" },
      });
    }
    throw new Error(`unexpected request: ${target}`);
  };
  try {
    // 公开接口形态：song.album 自带 company/publishTime（属“已有详情”），但 description 是空串
    const meta = await collectSongMetadata(
      { name: "solo", album: { id: 5, name: "专辑", company: "厂牌", publishTime: 0, description: "" } },
      { cookie: "" }
    );
    assert.equal(meta.albumDetail.description, "简介第一行\n简介第二行");
    assert.ok(requested.some((t) => t.includes("/weapi/api/v1/album")), "应补请求专辑接口");
  } finally {
    global.fetch = original;
  }
});

test("collectSongMetadata: song 自带专辑简介时不再请求专辑接口", async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    const meta = await collectSongMetadata(
      {
        name: "solo",
        album: {
          id: 5,
          name: "专辑",
          company: "厂牌",
          publishTime: 0,
          description: "自带简介",
        },
      },
      { cookie: "" }
    );
    assert.equal(meta.albumDetail.description, "自带简介");
    assert.equal(calls, 0, "不应发起任何网络请求");
  } finally {
    global.fetch = original;
  }
});

test("writeMusicTags: 公开接口 shape（artists/album/disc）也写入碟号", () => {
  const file = path.join(os.tmpdir(), `ncmdl-test-${process.pid}-${Date.now()}.mp3`);
  fs.writeFileSync(file, Buffer.from("MP3AUDIO", "ascii"));
  try {
    writeMusicTags(
      file,
      { name: "歌", no: 3, disc: "02", artists: [{ name: "甲" }], album: { name: "专" } },
      { lyric: null, genre: [], albumDetail: null, cover: null, coverMime: "image/jpeg" }
    );
    const { frames } = parseId3(fs.readFileSync(file));
    assert.equal(decodeTextFrame(frames.TPOS), "02", "公开接口返回 disc 而非 cd");
    assert.equal(decodeTextFrame(frames.TRCK), "03");
    assert.equal(decodeTextFrame(frames.TPE1), "甲");
    assert.equal(decodeTextFrame(frames.TALB), "专");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("writeMusicTags: FLAC 写入 GENRE 并在摘要中报告流派", () => {
  const file = path.join(os.tmpdir(), `ncmdl-test-${process.pid}-${Date.now()}.flac`);
  fs.writeFileSync(file, buildMinimalFlac());
  try {
    const summary = writeMusicTags(
      file,
      { name: "歌", ar: [{ name: "甲" }, { name: "乙" }], al: { name: "专" } },
      { lyric: null, genre: ["流行", "摇滚"], albumDetail: null, cover: null, coverMime: "image/jpeg" }
    );
    const { blocks } = parseFlacBlocks(fs.readFileSync(file));
    const vc = blocks.find((b) => b.type === 4);
    const parsedTags = parseVorbisComments(vc.data);
    assert.ok(parsedTags.includes("GENRE=流行; 摇滚"));
    assert.ok(parsedTags.includes("ARTIST=甲; 乙"));
    assert.ok(summary.includes("流派=流行; 摇滚"));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("writeMusicTags: 专辑简介写入备注并在摘要中报告", () => {
  const flacFile = path.join(os.tmpdir(), `ncmdl-test-${process.pid}-${Date.now()}.flac`);
  fs.writeFileSync(flacFile, buildMinimalFlac());
  try {
    const summary = writeMusicTags(
      flacFile,
      { name: "歌", ar: [{ name: "甲" }], al: { name: "专" } },
      {
        lyric: null,
        genre: [],
        albumDetail: { name: "专", company: "厂牌", publishTime: 100, description: "这是专辑简介\n第二行" },
        cover: null,
        coverMime: "image/jpeg",
      }
    );
    const { blocks } = parseFlacBlocks(fs.readFileSync(flacFile));
    const vc = blocks.find((b) => b.type === 4);
    const parsedTags = parseVorbisComments(vc.data);
    assert.ok(parsedTags.includes("COMMENT=这是专辑简介\n第二行"));
    assert.ok(summary.includes("备注"));
  } finally {
    fs.rmSync(flacFile, { force: true });
  }

  const mp3File = path.join(os.tmpdir(), `ncmdl-test-${process.pid}-${Date.now()}.mp3`);
  fs.writeFileSync(mp3File, Buffer.from("MP3AUDIO", "ascii"));
  try {
    writeMusicTags(
      mp3File,
      { name: "歌", ar: [{ name: "甲" }], al: { name: "专" } },
      {
        lyric: null,
        genre: [],
        albumDetail: { name: "专", company: "厂牌", publishTime: 100, description: "这是专辑简介" },
        cover: null,
        coverMime: "image/jpeg",
      }
    );
    const { frames } = parseId3(fs.readFileSync(mp3File));
    assert.ok(frames.COMM, "should contain COMM");
    assert.equal(frames.COMM.slice(8, -2).toString("utf16le"), "这是专辑简介");
  } finally {
    fs.rmSync(mp3File, { force: true });
  }
});

test("writeMusicTags: 专辑没有简介时不写备注", () => {
  const file = path.join(os.tmpdir(), `ncmdl-test-${process.pid}-${Date.now()}.mp3`);
  fs.writeFileSync(file, Buffer.from("MP3AUDIO", "ascii"));
  try {
    const summary = writeMusicTags(
      file,
      { name: "歌", ar: [{ name: "甲" }], al: { name: "专" } },
      {
        lyric: null,
        genre: [],
        albumDetail: { name: "专", company: "厂牌", publishTime: 0, description: "" },
        cover: null,
        coverMime: "image/jpeg",
      }
    );
    const { frames } = parseId3(fs.readFileSync(file));
    assert.equal(frames.COMM, undefined);
    assert.ok(!summary.includes("备注"));
  } finally {
    fs.rmSync(file, { force: true });
  }
});
