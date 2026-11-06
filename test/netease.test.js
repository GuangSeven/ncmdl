const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  buildSongOutputPath,
  clearStyleTagCache,
  fetchImage,
  getAlbumSongs,
  getArtistDetail,
  getSongDetails,
  getSongGenreTags,
  mergeLyric,
  parseAlbumId,
  parseSongId,
  parseTarget,
  resolveAlbumArtistName,
  splitTargetList
} = require("../src/netease");

function withMockFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = original;
    });
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(payload),
    headers: { get: () => "application/json" }
  };
}

test("parseSongId: 纯数字与歌曲链接", () => {
  assert.equal(parseSongId("123456"), 123456);
  assert.equal(parseSongId("https://music.163.com/song?id=123456"), 123456);
  assert.equal(parseSongId("https://music.163.com/#/song?id=123456"), 123456);
  assert.equal(parseSongId("https://music.163.com/song/123456"), 123456);
  assert.equal(parseSongId("not-a-song"), null);
});

test("parseAlbumId: 专辑链接与 album: 前缀", () => {
  assert.equal(parseAlbumId("https://music.163.com/#/album?id=999"), 999);
  assert.equal(parseAlbumId("https://music.163.com/album?id=999"), 999);
  assert.equal(parseAlbumId("https://music.163.com/album/999"), 999);
  assert.equal(parseAlbumId("album:999"), 999);
  assert.equal(parseAlbumId("album=999"), 999);
  assert.equal(parseAlbumId("999"), null, "裸数字不判定为专辑");
  assert.equal(parseAlbumId("https://music.163.com/song?id=123"), null);
});

test("parseTarget: 专辑优先于歌曲，裸数字按歌曲处理", () => {
  assert.deepEqual(parseTarget("https://music.163.com/#/album?id=999"), { type: "album", id: 999 });
  assert.deepEqual(parseTarget("album:999"), { type: "album", id: 999 });
  assert.deepEqual(parseTarget("123"), { type: "song", id: 123 });
  assert.deepEqual(parseTarget("https://music.163.com/song?id=123"), { type: "song", id: 123 });
  assert.equal(parseTarget(""), null);
  assert.equal(parseTarget("hello"), null);
});

test("splitTargetList: 按空格/逗号/顿号切分并展平", () => {
  assert.deepEqual(splitTargetList(["123 456", "789"]), ["123", "456", "789"]);
  assert.deepEqual(splitTargetList("123,456，789、000"), ["123", "456", "789", "000"]);
  assert.deepEqual(splitTargetList(["  "]), []);
  assert.deepEqual(splitTargetList([]), []);
});

test("getSongDetails: 批量取回并按输入顺序排列，忽略缺失歌曲", async () => {
  await withMockFetch(
    async () => jsonResponse({ songs: [{ id: 2, name: "b" }, { id: 1, name: "a" }] }),
    async () => {
      const songs = await getSongDetails([1, 2, 3], { cookie: "" });
      assert.deepEqual(songs.map((song) => song.id), [1, 2]);
    }
  );
});

test("getSongDetails: 空输入不发请求", async () => {
  await withMockFetch(
    async () => {
      throw new Error("不应发起请求");
    },
    async () => {
      assert.deepEqual(await getSongDetails([], { cookie: "" }), []);
      assert.deepEqual(await getSongDetails(["abc"], { cookie: "" }), []);
    }
  );
});

test("getAlbumSongs: 从专辑详情中提取曲目列表", async () => {
  await withMockFetch(
    async () => jsonResponse({ album: { id: 9, name: "专辑", songs: [{ id: 11 }, { id: 12 }] } }),
    async () => {
      const { album, songs } = await getAlbumSongs(9, { cookie: "" });
      assert.equal(album.name, "专辑");
      assert.deepEqual(songs.map((song) => song.id), [11, 12]);
    }
  );
});

test("getAlbumSongs: weapi 被风控时回退公开 v1 接口并取顶层 songs", async () => {
  const requested = [];
  await withMockFetch(
    async (url) => {
      const target = String(url);
      requested.push(target);
      if (target.includes("/weapi/")) {
        // 风控表现：HTTP 200 + 空 body
        return { ok: true, status: 200, statusText: "OK", text: async () => "", headers: { get: () => "application/json" } };
      }
      return jsonResponse({
        code: 200,
        album: { id: 9, name: "专辑", artists: [{ id: 1, name: "歌手" }], songs: [] },
        songs: [{ id: 11 }, { id: 12 }],
      });
    },
    async () => {
      const { album, songs } = await getAlbumSongs(9, { cookie: "" });
      assert.equal(album.name, "专辑");
      assert.deepEqual(songs.map((song) => song.id), [11, 12], "公开 v1 的曲目在顶层 songs");
      assert.ok(requested.some((target) => target.includes("/api/v1/album/9")));
    }
  );
});

test("getAlbumSongs: 公开回退返回 code:-462 时视为无专辑详情", async () => {
  await withMockFetch(
    async (url) => {
      if (String(url).includes("/weapi/")) {
        return { ok: true, status: 200, statusText: "OK", text: async () => "", headers: { get: () => "application/json" } };
      }
      return jsonResponse({ code: -462, message: "Cheating" });
    },
    async () => {
      const { album, songs } = await getAlbumSongs(9, { cookie: "" });
      assert.equal(album, null);
      assert.deepEqual(songs, []);
    }
  );
});

test("resolveAlbumArtistName: 专辑所属歌手优先于单曲歌手", () => {
  const song = { ar: [{ name: "单曲歌手" }], al: { id: 1, name: "专辑" } };
  assert.equal(
    resolveAlbumArtistName(song, { artists: [{ name: "群星" }, { name: "特邀" }] }),
    "群星 & 特邀"
  );
  assert.equal(resolveAlbumArtistName(song, null), "单曲歌手");
  assert.equal(resolveAlbumArtistName({ name: "x" }, null), "未知歌手");
});

test("getArtistDetail: 优先公开 head 信息接口取歌手头像", async () => {
  const requested = [];
  await withMockFetch(
    async (url) => {
      requested.push(String(url));
      return jsonResponse({
        code: 200,
        data: {
          artist: {
            id: 6452,
            name: "周杰伦",
            avatar: "http://p2.music.126.net/_ECPuM0s0qtWhkpQOSTZUg==/109951169164936940.jpg",
            cover: "http://p2.music.126.net/NWv6PtSBkyWZzqbJVzBr7g==/109951169164936450.jpg",
          },
        },
      });
    },
    async () => {
      const artist = await getArtistDetail(6452, { cookie: "" });
      assert.equal(artist.name, "周杰伦");
      assert.match(artist.avatar, /109951169164936940\.jpg/);
      assert.equal(requested.length, 1, "head 接口成功时不应再请求回退接口");
      assert.match(requested[0], /\/api\/artist\/head\/info\/get\?id=6452/);
    }
  );
});

test("getArtistDetail: head 接口无数据时回退公开歌手详情接口", async () => {
  const requested = [];
  await withMockFetch(
    async (url) => {
      const target = String(url);
      requested.push(target);
      if (target.includes("/api/artist/head/info/get")) {
        return jsonResponse({ code: 404, message: "not found" });
      }
      return jsonResponse({
        artist: {
          id: 6452,
          name: "周杰伦",
          img1v1Url: "https://p2.music.126.net/_ECPuM0s0qtWhkpQOSTZUg==/109951169164936940.jpg",
          picUrl: "https://p2.music.126.net/NWv6PtSBkyWZzqbJVzBr7g==/109951169164936450.jpg",
        },
      });
    },
    async () => {
      const artist = await getArtistDetail(6452, { cookie: "" });
      assert.equal(artist.name, "周杰伦");
      assert.match(artist.img1v1Url, /109951169164936940\.jpg/);
      assert.equal(requested.length, 2);
      assert.match(requested[1], /\/api\/artist\/6452/);
    }
  );
});

test("getArtistDetail: 全部接口失败或非法 id 时返回 null 不抛错", async () => {
  await withMockFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      assert.equal(await getArtistDetail(6452, { cookie: "" }), null);
    }
  );
  await withMockFetch(
    async () => {
      throw new Error("不应发起请求");
    },
    async () => {
      assert.equal(await getArtistDetail(0, { cookie: "" }), null);
      assert.equal(await getArtistDetail("abc", { cookie: "" }), null);
    }
  );
});

test("fetchImage: 请求带超时信号并返回 Buffer", async () => {
  let receivedSignal = null;
  await withMockFetch(
    async (url, options) => {
      receivedSignal = options?.signal;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
      };
    },
    async () => {
      const result = await fetchImage("https://p1.music.126.net/a==/1.jpg", {});
      assert.ok(Buffer.isBuffer(result));
      assert.equal(result.length, 4);
    }
  );
  assert.ok(receivedSignal, "fetchImage 应传入 AbortSignal 超时信号");
  assert.equal(typeof receivedSignal.aborted, "boolean");
});

test("buildSongOutputPath: 按「专辑所属歌手/专辑名」建立文件夹", () => {
  const song = { name: "歌", ar: [{ name: "单曲歌手" }], al: { id: 1, name: "专辑名" } };
  const config = { downloadDir: path.join("/dl"), filenamePattern: "artist-title" };
  const albumInfo = { id: 1, name: "专辑名", artists: [{ name: "专辑歌手A" }, { name: "专辑歌手B" }] };

  const withAlbum = buildSongOutputPath(song, config, "https://x/a.mp3", "", albumInfo);
  assert.equal(
    withAlbum,
    path.join("/dl", "专辑歌手A & 专辑歌手B", "专辑名", "单曲歌手 - 歌.mp3"),
    "歌手文件夹应使用专辑所属歌手"
  );

  const fallback = buildSongOutputPath(song, config, "https://x/a.mp3", "", null);
  assert.equal(
    fallback,
    path.join("/dl", "单曲歌手", "专辑名", "单曲歌手 - 歌.mp3"),
    "无专辑歌手时退回单曲歌手"
  );
});

function genreStyle(title) {
  return { resourceType: "melody_style", uiElement: { mainTitle: { title } } };
}

const STYLE_TREE = {
  code: 200,
  data: [
    {
      tagName: "摇滚",
      enName: "Rock",
      childrenTags: [{ tagName: "流行摇滚", enName: "Pop Rock" }],
    },
    { tagName: "流行", enName: "Pop", childrenTags: [{ tagName: "华语流行", enName: "C-Pop" }] },
    { tagName: "爵士", enName: "Jazz" },
    {
      tagName: "R&B",
      enName: "Rhythm and blues",
      childrenTags: [{ tagName: "当代R&B", enName: "Contemporary R&B" }],
    },
    { tagName: "国风", enName: "Chinese Style" },
    { tagName: "国风嘻哈", enName: "Chinese Style Hiphop" },
    { tagName: "嘻哈说唱", enName: "Hip Hop/Rap" },
    { tagName: "中文说唱", enName: "Chinese Hip Hop" },
    { tagName: "拉丁饶舌", enName: "Latin Hip hop/Rap" },
    { tagName: "嘻哈灵魂乐", enName: "Hip Hop Soul" },
  ],
};

function mockGenreFetch(wikiPayload) {
  return async (url) => {
    const target = String(url);
    if (target.includes("/api/tag/list/get")) return jsonResponse(STYLE_TREE);
    if (target.includes("/api/song/play/about/block/page")) return jsonResponse(wikiPayload);
    throw new Error(`unexpected request: ${target}`);
  };
}

test("getSongGenreTags: 曲风翻译为英文并去重", async () => {
  clearStyleTagCache();
  const wiki = {
    code: 200,
    data: {
      blocks: [
        {
          creatives: [
            {
              creativeType: "songTag",
              resources: [genreStyle("摇滚-流行摇滚"), genreStyle("流行"), genreStyle("流行")],
            },
            {
              creativeType: "songBizTag",
              resources: [genreStyle("治愈")],
            },
          ],
        },
      ],
    },
  };
  await withMockFetch(mockGenreFetch(wiki), async () => {
    assert.deepEqual(await getSongGenreTags(347230, { cookie: "" }), ["Rock", "Pop Rock", "Pop"]);
  });
});

test("getSongGenreTags: 复合曲风拆成彼此独立的标签", async () => {
  clearStyleTagCache();
  const wiki = {
    code: 200,
    data: {
      blocks: [
        {
          creatives: [
            {
              creativeType: "songTag",
              resources: [
                genreStyle("国风-国风嘻哈"),
                genreStyle("R&B-当代R&B"),
                genreStyle("摇滚"),
              ],
            },
          ],
        },
      ],
    },
  };
  await withMockFetch(mockGenreFetch(wiki), async () => {
    assert.deepEqual(await getSongGenreTags(666, { cookie: "" }), [
      "Chinese Style",
      "Chinese Style Hip-Hop",
      "R&B",
      "Contemporary R&B",
      "Rock",
    ]);
  });
});

test("getSongGenreTags: 已是英文的曲风名保留原样（R&B）", async () => {
  clearStyleTagCache();
  const wiki = {
    code: 200,
    data: { blocks: [{ creatives: [{ creativeType: "songTag", resources: [genreStyle("R&B")] }] }] },
  };
  await withMockFetch(mockGenreFetch(wiki), async () => {
    assert.deepEqual(await getSongGenreTags(21974814, { cookie: "" }), ["R&B"]);
  });
});

test("getSongGenreTags: Hip Hop 统一写作 Hip-Hop", async () => {
  clearStyleTagCache();
  const wiki = {
    code: 200,
    data: {
      blocks: [
        {
          creatives: [
            {
              creativeType: "songTag",
              resources: [
                genreStyle("国风嘻哈"),
                genreStyle("嘻哈说唱"),
                genreStyle("中文说唱"),
                genreStyle("拉丁饶舌"),
                genreStyle("嘻哈灵魂乐"),
              ],
            },
          ],
        },
      ],
    },
  };
  await withMockFetch(mockGenreFetch(wiki), async () => {
    assert.deepEqual(await getSongGenreTags(1001, { cookie: "" }), [
      "Chinese Style Hip-Hop",
      "Hip-Hop/Rap",
      "Chinese Hip-Hop",
      "Latin Hip-Hop/Rap",
      "Hip-Hop Soul",
    ]);
  });
});

test("getSongGenreTags: 分类树不可用时保留原曲风名", async () => {
  clearStyleTagCache();
  const wiki = {
    code: 200,
    data: { blocks: [{ creatives: [{ creativeType: "songTag", resources: [genreStyle("爵士")] }] }] },
  };
  await withMockFetch(
    async (url) => {
      if (String(url).includes("/api/tag/list/get")) throw new Error("network");
      return jsonResponse(wiki);
    },
    async () => {
      assert.deepEqual(await getSongGenreTags(347230, { cookie: "" }), ["爵士"]);
    }
  );
});

test("getSongGenreTags: 无 songId 不发请求，缺数据返回空数组", async () => {
  clearStyleTagCache();
  await withMockFetch(mockGenreFetch({ code: 200, data: { blocks: [] } }), async () => {
    assert.deepEqual(await getSongGenreTags(0, { cookie: "" }), []);
    assert.deepEqual(await getSongGenreTags(1, { cookie: "" }), []);
  });
});

test("mergeLyric: 按时间戳把翻译行插到原文行之后", () => {
  const original = "[00:01.00]Hello\n[00:05.50]World";
  const translation = "[00:01.00]你好\n[00:05.50]世界";
  assert.equal(
    mergeLyric(original, translation),
    "[00:01.00]Hello\n[00:01.00]你好\n[00:05.50]World\n[00:05.50]世界"
  );
});

test("mergeLyric: 兼容不同精度与未匹配的翻译", () => {
  const original = "[00:01.000]Hello\n[00:05]World";
  const translation = "[00:01.00]你好\n[00:09.00]多余翻译";
  assert.equal(
    mergeLyric(original, translation),
    "[00:01.000]Hello\n[00:01.000]你好\n[00:05]World"
  );
});

test("mergeLyric: 无翻译返回原文，无原文返回 null", () => {
  assert.equal(mergeLyric("[00:01.00]Hello", ""), "[00:01.00]Hello");
  assert.equal(mergeLyric("[00:01.00]Hello", null), "[00:01.00]Hello");
  assert.equal(mergeLyric(null, "[00:01.00]你好"), null);
  assert.equal(mergeLyric("", ""), null);
});

test("buildSongOutputPath: 缺失专辑/歌手信息时使用兜底目录名", () => {
  const config = { downloadDir: "/dl", filenamePattern: "artist-title" };
  const out = buildSongOutputPath({ name: "solo", ar: [] }, config, "https://x/s.mp3", "", null);
  assert.equal(out, path.join("/dl", "未知歌手", "未知专辑", "unknown - solo.mp3"));
});
