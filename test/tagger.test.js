const assert = require("node:assert/strict");
const test = require("node:test");

const { dateDesc, detectImageMime, tagFlac, tagMp3 } = require("../src/tagger");

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

function parseId3v23(mp3) {
  assert.equal(mp3.slice(0, 3).toString("ascii"), "ID3");
  const size = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  const frames = {};
  let offset = 10;
  const end = 10 + size;
  while (offset + 10 <= end) {
    const id = mp3.slice(offset, offset + 4).toString("ascii");
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = mp3.readUInt32BE(offset + 4);
    frames[id] = mp3.slice(offset + 10, offset + 10 + frameSize);
    offset += 10 + frameSize;
  }
  return { frames, tagEnd: end };
}

function decodeTextFrame(frameData) {
  const encoding = frameData[0];
  const text = frameData.slice(1);
  if (encoding === 1) {
    return text.slice(2).toString("utf16le"); // 去掉 BOM
  }
  return text.toString("utf8");
}

test("tagMp3 inserts ID3v2.3 when absent", () => {
  const raw = Buffer.from("RAWMP3FRAMEDATA", "ascii");
  const output = tagMp3(raw, { title: "歌名", artist: "歌手", year: "2024-05-06" });
  const { frames, tagEnd } = parseId3v23(output);
  assert.equal(decodeTextFrame(frames.TIT2), "歌名");
  assert.equal(decodeTextFrame(frames.TPE1), "歌手");
  assert.equal(decodeTextFrame(frames.TDRC), "2024-05-06");
  assert.equal(output.slice(tagEnd).toString("ascii"), "RAWMP3FRAMEDATA");
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
  const { frames, tagEnd } = parseId3v23(output);
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
  const { frames } = parseId3v23(output);
  assert.ok(frames.USLT, "should contain USLT");
  // USLT data = encoding(1) + lang(3) + descriptor(2) + text
  const usltText = frames.USLT.slice(6).toString("utf16le");
  assert.ok(usltText.includes("歌词"));
  assert.ok(frames.APIC, "should contain APIC");
  // APIC data = encoding(1) + mime + type(1) + descriptor(2) + picture
  assert.equal(frames.APIC.slice(1, 11).toString("ascii"), "image/jpeg");
});

test("tagMp3 skips empty optional fields", () => {
  const output = tagMp3(Buffer.from("DATA"), { title: "只有标题", track: null, disc: null, lyric: null });
  const { frames } = parseId3v23(output);
  assert.ok(frames.TIT2);
  assert.equal(frames.TRCK, undefined);
  assert.equal(frames.TPOS, undefined);
  assert.equal(frames.USLT, undefined);
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
