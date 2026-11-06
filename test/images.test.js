const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectAlbumCoverUrls,
  collectArtistImageUrls,
  collectHighQualityImageUrls,
  createImageDownloader,
  detectImageFormat,
  isPlaceholderImageUrl,
  normalizeImageUrl,
  readImageSize,
  saveImage,
} = require("../src/images");

function withMockFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = original;
    });
}

function imageResponse(buffer, contentType = "image/png") {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(payload),
    headers: { get: () => "application/json" },
  };
}

/** 构造带 IHDR 的最小 PNG（只需前 24 字节即可解析宽高）。 */
function pngBuffer(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** 构造含 APP0 + SOF0 的最小 JPEG。 */
function jpegBuffer(width, height) {
  const app0 = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const tail = Buffer.from([0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  return Buffer.concat([app0, sof, tail]);
}

async function makeTempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ncmdl-images-test-"));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("normalizeImageUrl: 去掉缩略图参数并升级 https", () => {
  assert.equal(
    normalizeImageUrl("https://p1.music.126.net/ab==/1.jpg?param=300y300"),
    "https://p1.music.126.net/ab==/1.jpg"
  );
  assert.equal(
    normalizeImageUrl("http://p2.music.126.net/ab==/1.jpg"),
    "https://p2.music.126.net/ab==/1.jpg"
  );
  assert.equal(
    normalizeImageUrl("https://p1.music.126.net/ab==/1.jpg?param=300y300&foo=1"),
    "https://p1.music.126.net/ab==/1.jpg?foo=1",
    "非缩略图参数应保留"
  );
  assert.equal(normalizeImageUrl(""), "");
  assert.equal(normalizeImageUrl(undefined), "");
  assert.equal(normalizeImageUrl("不是图片地址"), "");
  assert.equal(normalizeImageUrl("ftp://p1.music.126.net/a.jpg"), "");
});

test("collectHighQualityImageUrls: 归一化、去重并保持顺序", () => {
  const urls = collectHighQualityImageUrls([
    "https://p1.music.126.net/a==/1.jpg?param=300y300",
    "https://p1.music.126.net/a==/1.jpg",
    "http://p1.music.126.net/b==/2.jpg?param=300y300",
    null,
    "",
  ]);
  assert.deepEqual(urls, [
    "https://p1.music.126.net/a==/1.jpg",
    "https://p1.music.126.net/b==/2.jpg",
  ]);
});

test("isPlaceholderImageUrl: 识别网易云默认头像/默认封面占位图", () => {
  assert.equal(
    isPlaceholderImageUrl("https://p1.music.126.net/VnZiScyynLG7atLIZ2YPkw==/18686200114669622.jpg"),
    true,
    "默认头像"
  );
  assert.equal(
    isPlaceholderImageUrl("http://p3.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg?param=300y300"),
    true,
    "默认封面"
  );
  assert.equal(isPlaceholderImageUrl("https://p1.music.126.net/o_IrNP7JnUeuMAXAa9Sbcg==/109951173438974262.jpg"), false);
  assert.equal(isPlaceholderImageUrl(""), false);
});

test("collectHighQualityImageUrls: 默认占位图会被过滤，不下发下载", () => {
  const urls = collectHighQualityImageUrls([
    "https://p1.music.126.net/VnZiScyynLG7atLIZ2YPkw==/18686200114669622.jpg",
    "https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg?param=300y300",
    "https://p1.music.126.net/real==/123.jpg?param=300y300",
  ]);
  assert.deepEqual(urls, ["https://p1.music.126.net/real==/123.jpg"]);
});

test("collectArtistImageUrls: 肖像优先，横幅兜底，兼容嵌套数组", () => {
  const detail = {
    avatar: "http://p2.music.126.net/avatar==/1.jpg?param=300y300",
    cover: "http://p2.music.126.net/cover==/2.jpg",
  };
  const songArtists = [
    { name: "A", img1v1Url: "http://p1.music.126.net/a==/3.jpg" },
    { name: "B", picUrl: "http://p1.music.126.net/b==/4.jpg" },
  ];
  const urls = collectArtistImageUrls(detail, [songArtists]);
  assert.deepEqual(urls, [
    "https://p2.music.126.net/avatar==/1.jpg",
    "https://p2.music.126.net/cover==/2.jpg",
    "https://p1.music.126.net/a==/3.jpg",
    "https://p1.music.126.net/b==/4.jpg",
  ]);
  assert.deepEqual(collectArtistImageUrls(null), []);
});

test("collectAlbumCoverUrls: picUrl 优先于 blurPicUrl 且去重", () => {
  assert.deepEqual(
    collectAlbumCoverUrls([
      { picUrl: "https://p1.music.126.net/al==/1.jpg?param=300y300", blurPicUrl: "https://p1.music.126.net/al==/1.jpg?param=300y300" },
      { blurPicUrl: "http://p1.music.126.net/al2==/2.jpg?param=300y300" },
    ]),
    [
      "https://p1.music.126.net/al==/1.jpg",
      "https://p1.music.126.net/al2==/2.jpg",
    ]
  );
  assert.deepEqual(collectAlbumCoverUrls(null), []);
});

test("detectImageFormat: 按魔数识别真实格式（扩展名可能是假的）", () => {
  assert.deepEqual(detectImageFormat(pngBuffer(10, 10)), { mime: "image/png", ext: ".png" });
  assert.deepEqual(detectImageFormat(jpegBuffer(10, 10)), { mime: "image/jpeg", ext: ".jpg" });
  const webp = Buffer.alloc(32);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  assert.deepEqual(detectImageFormat(webp), { mime: "image/webp", ext: ".webp" });
  assert.deepEqual(detectImageFormat(Buffer.from("GIF89a")), { mime: "image/gif", ext: ".gif" });
  assert.equal(detectImageFormat(Buffer.from("not an image")), null);
  assert.equal(detectImageFormat(Buffer.alloc(0)), null);
});

test("readImageSize: 解析 PNG / JPEG 像素尺寸", () => {
  assert.deepEqual(readImageSize(pngBuffer(1080, 1080)), { width: 1080, height: 1080 });
  assert.deepEqual(readImageSize(jpegBuffer(800, 600)), { width: 800, height: 600 });
  assert.equal(readImageSize(Buffer.from("xxxx")), null);
});

test("saveImage: 下载原图并按真实格式落盘（无残留 .part）", async (t) => {
  const dir = await makeTempDir(t);
  const requested = [];
  await withMockFetch(
    async (url) => {
      requested.push(String(url));
      return imageResponse(pngBuffer(1080, 1080), "image/png");
    },
    async () => {
      const result = await saveImage(
        path.join(dir, "cover"),
        ["https://p1.music.126.net/al==/1.jpg?param=300y300"],
        {}
      );
      assert.equal(result.status, "created");
      assert.equal(result.filePath, path.join(dir, "cover.png"));
      assert.equal(result.width, 1080);
      assert.equal(result.height, 1080);
      assert.equal(result.mime, "image/png");
      assert.deepEqual(requested, ["https://p1.music.126.net/al==/1.jpg"]);
      assert.equal(fs.existsSync(path.join(dir, "cover.png")), true);
      assert.equal(fs.existsSync(path.join(dir, "cover.png.part")), false);
    }
  );
});

test("saveImage: 目标已存在时跳过，不再发起请求", async (t) => {
  const dir = await makeTempDir(t);
  await fsp.writeFile(path.join(dir, "cover.jpg"), jpegBuffer(500, 500));
  await withMockFetch(
    async () => {
      throw new Error("不应发起图片请求");
    },
    async () => {
      const result = await saveImage(path.join(dir, "cover"), ["https://x/1.jpg"], {});
      assert.equal(result.status, "skipped");
      assert.equal(result.filePath, path.join(dir, "cover.jpg"));
    }
  );
});

test("saveImage: 首个候选失败时回退到下一个候选", async (t) => {
  const dir = await makeTempDir(t);
  const requested = [];
  await withMockFetch(
    async (url) => {
      requested.push(String(url));
      if (requested.length === 1) throw new Error("network down");
      return imageResponse(jpegBuffer(1024, 1024), "image/jpeg");
    },
    async () => {
      const result = await saveImage(
        path.join(dir, "cover"),
        ["https://x/broken.jpg", "https://x/good.jpg"],
        {}
      );
      assert.equal(result.status, "created");
      assert.equal(result.filePath, path.join(dir, "cover.jpg"));
      assert.equal(result.width, 1024);
      assert.deepEqual(requested, ["https://x/broken.jpg", "https://x/good.jpg"]);
    }
  );
});

test("saveImage: 返回内容不是图片时判定失败而非落盘", async (t) => {
  const dir = await makeTempDir(t);
  await withMockFetch(
    async () => imageResponse(Buffer.from("<html>error</html>"), "text/html"),
    async () => {
      const result = await saveImage(path.join(dir, "cover"), ["https://x/1.jpg"], {});
      assert.equal(result.status, "failed");
      assert.match(result.error, /不是可识别的图片/);
      assert.deepEqual(await fsp.readdir(dir), []);
    }
  );
});

test("createImageDownloader: 同一文件夹并发只下载一次封面", async (t) => {
  const dir = await makeTempDir(t);
  let imageRequests = 0;
  await withMockFetch(
    async () => {
      imageRequests += 1;
      return imageResponse(pngBuffer(1080, 1080));
    },
    async () => {
      const downloader = createImageDownloader({});
      const albums = [{ picUrl: "http://p1.music.126.net/al==/1.jpg?param=300y300" }];
      const [first, second] = await Promise.all([
        downloader.downloadAlbumCover(dir, albums),
        downloader.downloadAlbumCover(dir, albums),
      ]);
      assert.equal(first, second, "同一目标应共享同一个结果对象");
      assert.equal(first.status, "created");
      assert.equal(imageRequests, 1, "并发调用只应发起一次图片请求");
      assert.equal(fs.existsSync(path.join(dir, "cover.png")), true);
    }
  );
});

test("createImageDownloader: 歌手图片取歌手详情高清头像，并保存到歌手文件夹根目录", async (t) => {
  const dir = await makeTempDir(t);
  const requested = [];
  await withMockFetch(
    async (url) => {
      const target = String(url);
      requested.push(target);
      if (target.includes("/api/artist/head/info/get")) {
        return jsonResponse({
          code: 200,
          data: {
            artist: {
              id: 6452,
              name: "周杰伦",
              avatar: "http://p2.music.126.net/avatar==/1.jpg?param=300y300",
              cover: "http://p2.music.126.net/cover==/2.jpg",
            },
          },
        });
      }
      return imageResponse(pngBuffer(1124, 1124));
    },
    async () => {
      const downloader = createImageDownloader({});
      const result = await downloader.downloadArtistImage(dir, { artistId: 6452 });
      assert.equal(result.status, "created");
      assert.equal(result.filePath, path.join(dir, "artist.png"));
      assert.equal(result.width, 1124);
      assert.equal(requested[0], "https://music.163.com/api/artist/head/info/get?id=6452");
      assert.equal(requested[1], "https://p2.music.126.net/avatar==/1.jpg");
    }
  );
});

test("createImageDownloader: 歌手详情失败时回退到歌曲自带的歌手图片", async (t) => {
  const dir = await makeTempDir(t);
  await withMockFetch(
    async (url) => {
      const target = String(url);
      if (target.includes("/api/authority") || target.includes("/api/artist")) {
        throw new Error("network down");
      }
      return imageResponse(jpegBuffer(640, 640), "image/jpeg");
    },
    async () => {
      const downloader = createImageDownloader({});
      const result = await downloader.downloadArtistImage(dir, {
        artistId: 6452,
        artists: [{ id: 6452, name: "周杰伦", img1v1Url: "http://p1.music.126.net/ar==/3.jpg" }],
      });
      assert.equal(result.status, "created");
      assert.equal(result.filePath, path.join(dir, "artist.jpg"));
    }
  );
});

test("createImageDownloader: 只有默认占位图时不保存歌手图片", async (t) => {
  const dir = await makeTempDir(t);
  let imageRequests = 0;
  await withMockFetch(
    async (url) => {
      const target = String(url);
      if (target.includes("/api/artist/head/info/get")) {
        return jsonResponse({
          code: 200,
          data: {
            artist: {
              id: 999,
              name: "冷门歌手",
              avatar: "https://p1.music.126.net/VnZiScyynLG7atLIZ2YPkw==/18686200114669622.jpg",
              cover: "https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg",
            },
          },
        });
      }
      imageRequests += 1;
      throw new Error("不应下载占位图");
    },
    async () => {
      const downloader = createImageDownloader({});
      const result = await downloader.downloadArtistImage(dir, {
        artistId: 999,
        artists: [{ img1v1Url: "http://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg" }],
      });
      assert.equal(result.status, "unavailable");
      assert.equal(imageRequests, 0, "占位图不应发起下载");
      assert.deepEqual(await fsp.readdir(dir), []);
    }
  );
});

test("createImageDownloader: 歌手图片已存在时跳过且不发请求", async (t) => {
  const dir = await makeTempDir(t);
  await fsp.writeFile(path.join(dir, "artist.jpg"), jpegBuffer(1124, 1124));
  let requests = 0;
  await withMockFetch(
    async () => {
      requests += 1;
      throw new Error("不应发起请求");
    },
    async () => {
      const downloader = createImageDownloader({});
      const result = await downloader.downloadArtistImage(dir, { artistId: 6452 });
      assert.equal(result.status, "skipped");
      assert.equal(result.filePath, path.join(dir, "artist.jpg"));
      assert.equal(requests, 0, "已存在图片时不应请求歌手接口或图片");
    }
  );
});

test("createImageDownloader: 全部候选失败时返回 failed 且不抛错、不落盘", async (t) => {
  const dir = await makeTempDir(t);
  await withMockFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      const downloader = createImageDownloader({});
      const result = await downloader.downloadAlbumCover(dir, [
        { picUrl: "https://x/broken1.jpg" },
        { picUrl: "https://x/broken2.jpg" },
      ]);
      assert.equal(result.status, "failed");
      assert.match(result.error, /network down/);
      assert.deepEqual(await fsp.readdir(dir), []);
    }
  );
});

test("createImageDownloader: 没有歌手 id 与候选地址时不下载", async (t) => {
  const dir = await makeTempDir(t);
  await withMockFetch(
    async () => {
      throw new Error("不应发起请求");
    },
    async () => {
      const downloader = createImageDownloader({});
      const result = await downloader.downloadArtistImage(dir, {});
      assert.equal(result.status, "unavailable");
      assert.deepEqual(await fsp.readdir(dir), []);
    }
  );
});
