// Розбір uakino на справжній відповіді сайту (Баскетбол Куроко, 1 сезон).
//
// Запуск: node --test browser-extension/*.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {uakinoParsePlaylist, uakinoPlayerStreams} = require("./uakino.js");

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
