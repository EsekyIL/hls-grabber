// Розбір uakino на справжній відповіді сайту (Баскетбол Куроко, 1 сезон).
//
// Запуск: node --test browser-extension/*.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {uakinoParsePlaylist, uakinoPlayerStreams, uakinoMasterVariants, uakinoSeasonLinks, uakinoPageParams} = require("./uakino.js");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "testdata", "uakino-playlist.json"), "utf8"));

test("плейлист uakino: озвучки й серії", () => {
  const {voices, episodes} = uakinoParsePlaylist(fixture.response);
  // «Рейтинг озвучень» — кнопка без data-id, не озвучка.
  assert.deepStrictEqual(voices, [{id: "0_0", name: "FanVoxUA (1-25)"}, {id: "0_1", name: "Кіото (1-11)"}]);
  assert.strictEqual(episodes.length, 36);
  assert.deepStrictEqual(episodes[0], {voiceId: "0_0", voice: "FanVoxUA", file: "https://ashdi.vip/vod/67595", title: "Серія 1", episode: "1"});
  const kioto = episodes.filter(item => item.voiceId === "0_1");
  assert.strictEqual(kioto.length, 11);
  assert.strictEqual(kioto[10].file, "https://ashdi.vip/vod/256334");
  assert.strictEqual(kioto[10].episode, "11");
});

test("плейлист без списку озвучок бере їх із серій", () => {
  const {voices} = uakinoParsePlaylist('<ul><li data-file="//ashdi.vip/vod/1" data-id="0_0" data-voice="Студія">Серія 1</li></ul>');
  assert.deepStrictEqual(voices, [{id: "0_0", name: "Студія"}]);
});

test("сторінка плеєра: одна адреса", () => {
  const html = `<script>var player = new Playerjs({id:"player", file:"https://cdn.ashdi.vip/hls/abc/index.m3u8", poster:"x.jpg"});</script>`;
  assert.deepStrictEqual(uakinoPlayerStreams(html), [{quality: "auto", urls: ["https://cdn.ashdi.vip/hls/abc/index.m3u8"]}]);
});

test("сторінка плеєра: набір якостей", () => {
  const html = `new Playerjs({file:'[480p]//a.test/480.m3u8,[1080p]https://a.test/1080.m3u8'})`;
  assert.deepStrictEqual(uakinoPlayerStreams(html), [
    {quality: "480p", urls: ["https://a.test/480.m3u8"]},
    {quality: "1080p", urls: ["https://a.test/1080.m3u8"]}
  ]);
});

test("сторінка плеєра: JSON-плейлист і екрановані слеші", () => {
  const html = `new Playerjs({file:'[{"title":"Серія 1","file":"https:\\/\\/a.test\\/e1.m3u8"}]'})`;
  assert.deepStrictEqual(uakinoPlayerStreams(html), [{quality: "auto", urls: ["https://a.test/e1.m3u8"]}]);
});

test("сторінка плеєра без конфігу: будь-яка адреса .m3u8", () => {
  assert.deepStrictEqual(uakinoPlayerStreams(`<video src="https://b.test/v/master.m3u8?t=1"></video>`), [{quality: "auto", urls: ["https://b.test/v/master.m3u8?t=1"]}]);
  assert.deepStrictEqual(uakinoPlayerStreams("<p>Відео недоступне</p>"), []);
});

test("справжня сторінка плеєра ashdi", () => {
  const html = fs.readFileSync(path.join(__dirname, "testdata", "ashdi-player.html"), "utf8");
  const streams = uakinoPlayerStreams(html);
  assert.strictEqual(streams.length, 1);
  assert.strictEqual(streams[0].quality, "auto");
  // Саме file, а не poster чи інша адреса зі сторінки.
  assert.match(streams[0].urls[0], /^https:\/\/ashdi\.vip\/video04\/.*_67595\/hls\/.*\/index\.m3u8$/);
});

test("вкладені рівні: озвучка — найглибший, сезон із назви батька", () => {
  const html = `
    <div class="playlists-lists">
      <div class="playlists-items"><ul><li data-id="0">Сезон 1</li><li data-id="1">Сезон 2</li></ul></div>
      <div class="playlists-items"><ul><li data-id="0_0">FanVoxUA</li><li data-id="1_0">FanVoxUA</li><li data-id="1_1">Кіото</li></ul></div>
    </div>
    <div class="playlists-videos"><div class="playlists-items"><ul>
      <li data-file="//ashdi.vip/vod/1" data-id="0_0" data-voice="FanVoxUA">Серія 1</li>
      <li data-file="//ashdi.vip/vod/2" data-id="1_0" data-voice="FanVoxUA">Серія 1</li>
      <li data-file="//ashdi.vip/vod/3" data-id="1_1" data-voice="Кіото">Серія 1</li>
    </ul></div></div>`;
  const {voices} = uakinoParsePlaylist(html);
  assert.deepStrictEqual(voices, [
    {id: "0_0", name: "Сезон 1 · FanVoxUA", season: "1"},
    {id: "1_0", name: "Сезон 2 · FanVoxUA", season: "2"},
    {id: "1_1", name: "Сезон 2 · Кіото", season: "2"}
  ]);
});

test("master-плейлист ashdi: кожна якість окремо, від меншої до більшої", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
    "https://jk19ocmjeoyql3tj.ashdi.vip/content/stream/serials/kuroko/hls/720/index.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480",
    "https://jk19ocmjeoyql3tj.ashdi.vip/content/stream/serials/kuroko/hls/480/index.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=900000",
    "360/index.m3u8"
  ].join("\n");
  const base = "https://ashdi.vip/video04/kuroko/hls/token/index.m3u8";
  assert.deepStrictEqual(uakinoMasterVariants(master, base), [
    {quality: "360p", urls: ["https://ashdi.vip/video04/kuroko/hls/token/360/index.m3u8"]},
    {quality: "480p", urls: ["https://jk19ocmjeoyql3tj.ashdi.vip/content/stream/serials/kuroko/hls/480/index.m3u8"]},
    {quality: "720p", urls: ["https://jk19ocmjeoyql3tj.ashdi.vip/content/stream/serials/kuroko/hls/720/index.m3u8"]}
  ]);
});

test("не master — варіантів немає, лишається auto", () => {
  const media = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment1.ts\n";
  assert.deepStrictEqual(uakinoMasterVariants(media, "https://ashdi.vip/a/index.m3u8"), []);
  assert.deepStrictEqual(uakinoMasterVariants("<html>заглушка</html>", "https://ashdi.vip/a/index.m3u8"), []);
});

test("справжня сторінка: перемикач сезонів і параметри плейлиста", () => {
  const html = fs.readFileSync(path.join(__dirname, "testdata", "uakino-page.html"), "utf8");
  const base = "https://uakino.best/animeukr/anime-series/14642-basketbol-kuroko-1-sezon.html";
  assert.deepStrictEqual(uakinoSeasonLinks(html, base), [
    {season: "1", url: "", active: true},
    {season: "2", url: "https://uakino.best/animeukr/anime-series/14643-basketbol-kuroko-2-sezon.html", active: false},
    {season: "3", url: "https://uakino.best/animeukr/anime-series/21969-basketbol-kuroko-3-sezon.html", active: false}
  ]);
  assert.deepStrictEqual(uakinoPageParams(html), {newsId: "14642", xfield: "playlist", root: "/", edited: "1778202601"});
});

test("сторінка без перемикача сезонів — список порожній", () => {
  assert.deepStrictEqual(uakinoSeasonLinks("<div>Фільм</div>", "https://uakino.best/a.html"), []);
  assert.strictEqual(uakinoPageParams("<div>Фільм</div>").newsId, "");
});
