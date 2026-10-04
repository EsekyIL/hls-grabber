// Адаптер uakino (uakino.best і дзеркала).
//
// Сайт на тому ж DLE, що й HDRezka, але плеєр інший: ні get_cdn_series, ні
// списку серій у розмітці. Сторінка має порожній блок
//
//   <div class="playlists-ajax" data-xfname="playlist" data-news_id="14642">
//
// який скрипт сайту заповнює окремим запитом. У відповіді — два списки:
//
//   озвучки:  <li data-id="0_0">FanVoxUA (1-25)</li>
//   серії:    <li data-file="//ashdi.vip/vod/67595" data-id="0_0"
//                 data-voice="FanVoxUA">Серія 1</li>
//
// data-id серії вказує на її озвучку. data-file — сторінка зовнішнього
// плеєра (ashdi), і вже в ній лежить адреса .m3u8. Тому на кожну серію два
// кроки: знайти рядок у списку, потім спитати сторінку плеєра.
//
// Кожен сезон — окрема сторінка сайту (.seasons → .season-active), тож
// номер сезону береться звідти.
//
// Розбір написаний на рядках, а не через DOM: так його можна перевірити
// тестом у node на справжній відповіді сайту.

function uakinoAvailable() {
  return Boolean(document.querySelector(".playlists-ajax[data-news_id]"));
}

// Атрибути одного тега: {"data-file": "...", "data-id": "..."}.
function uakinoAttrs(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[match[1].toLowerCase()] = uakinoDecode(match[3]);
  return attrs;
}

function uakinoDecode(text) {
  return String(text)
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Розбирає HTML плейлиста в {voices, episodes}.
//
// Список озвучок буває відсутній — у серіалу з однією озвучкою сайт його
// не малює. Тоді озвучки збираємо з самих серій: data-id + data-voice.
function uakinoParsePlaylist(html) {
  const voices = [];
  const episodes = [];
  for (const match of String(html || "").matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const attrs = uakinoAttrs(match[1]);
    const text = uakinoDecode(match[2]);
    if (!attrs["data-id"]) continue;
    if (attrs["data-file"]) {
      episodes.push({
        voiceId: attrs["data-id"],
        voice: attrs["data-voice"] || "",
        file: uakinoAbsolute(attrs["data-file"]),
        title: text,
        episode: (text.match(/\d+/) || [""])[0]
      });
    } else if (text && !voices.some(voice => voice.id === attrs["data-id"])) {
      voices.push({id: attrs["data-id"], name: text});
    }
  }
  for (const item of episodes) {
    if (!voices.some(voice => voice.id === item.voiceId)) voices.push({id: item.voiceId, name: item.voice || item.voiceId});
  }
  return {voices, episodes};
}

function uakinoAbsolute(url) {
  url = String(url || "").trim();
  return url.startsWith("//") ? "https:" + url : url;
}

// Дістає адреси потоку зі сторінки плеєра ashdi.
//
// Плеєр — Playerjs, і адресу він отримує в конфігу: file:"…". Сам рядок
// буває трьох видів, тож розбираємо всі:
//   - одна адреса .m3u8 (найчастіше: адаптивний плейлист з усіма якостями);
//   - «[480p]url,[720p]url» — набір якостей, як у HDRezka;
//   - JSON-плейлист [{"file": "...", "title": ...}] — тоді беремо перший файл.
// Якщо конфіг не знайшовся зовсім, шукаємо будь-яку адресу .m3u8 у тексті.
function uakinoPlayerStreams(html) {
  const text = String(html || "");
  const config = text.match(/\bfile\s*:\s*(["'])([\s\S]*?)\1/);
  let value = config ? config[2].replace(/\\\//g, "/").trim() : "";

  if (value.startsWith("[{") || value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      const first = (function find(node) {
        if (Array.isArray(node)) { for (const item of node) { const hit = find(item); if (hit) return hit; } return ""; }
        if (node && typeof node === "object") return node.file ? String(node.file) : find(node.folder || node.playlist);
        return "";
      })(parsed);
      value = first;
    } catch (_) { value = ""; }
  }

  if (value.startsWith("[")) {
    const out = [];
    for (const chunk of value.split(/,(?=\[)/)) {
      const match = chunk.match(/^\s*\[([^\]]*)\]([\s\S]*)$/);
      if (!match) continue;
      const urls = match[2].split(/\s+or\s+|;/).map(url => uakinoAbsolute(url.trim())).filter(url => /^https?:\/\//.test(url));
      if (urls.length) out.push({quality: match[1].trim() || "auto", urls});
    }
    if (out.length) return out;
  } else if (/^(https?:)?\/\//.test(value)) {
    return [{quality: "auto", urls: [uakinoAbsolute(value)]}];
  }

  const loose = text.match(/(?:https?:)?\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/);
  return loose ? [{quality: "auto", urls: [uakinoAbsolute(loose[0])]}] : [];
}

// Назва серіалу без «1 сезон»: сезон уже окремою текою.
function uakinoTitle() {
  const name = document.querySelector("h1 [itemprop=name], .solototle, h1")?.textContent || document.title;
  return name.replace(/\s+/g, " ").replace(/\s*\d+\s*сезон\s*$/i, "").trim();
}

function uakinoSeason() {
  const active = document.querySelector(".seasons .season-active")?.textContent || "";
  return active.match(/\d+/)?.[0] || uakinoTitleRaw().match(/(\d+)\s*сезон/i)?.[1] || "1";
}

function uakinoTitleRaw() {
  return document.querySelector("h1")?.textContent || document.title;
}

// Плейлист сторінки.
//
// Спершу — з уже намальованої сторінки: скрипт сайту міг устигнути. Якщо ні,
// прокручуємо до блоку (частина збірок вантажить його лише на показі) і
// чекаємо. І вже наостанок питаємо ендпоінт самі.
async function uakinoPlaylist() {
  const fromDom = () => {
    const box = document.querySelector(".playlists-ajax");
    return box && box.querySelector("li[data-file]") ? uakinoParsePlaylist(box.innerHTML) : null;
  };
  let playlist = fromDom();
  if (playlist?.episodes.length) return playlist;

  document.querySelector(".playlists-ajax")?.scrollIntoView({block: "center"});
  for (let waited = 0; waited < 8000; waited += 400) {
    await new Promise(resolve => setTimeout(resolve, 400));
    playlist = fromDom();
    if (playlist?.episodes.length) return playlist;
  }

  const box = document.querySelector(".playlists-ajax");
  const root = (document.documentElement.innerHTML.match(/dle_root\s*=\s*['"]([^'"]*)['"]/) || [null, "/"])[1] || "/";
  const params = new URLSearchParams({news_id: box?.dataset.news_id || "", xfield: box?.dataset.xfname || "playlist", time: String(Date.now())});
  const response = await fetch(`${location.origin}${root.endsWith("/") ? root : root + "/"}engine/ajax/playlists.php?${params}`, {
    credentials: "include",
    headers: {"X-Requested-With": "XMLHttpRequest"}
  });
  if (!response.ok) throw new Error(`список серій: сайт відповів ${response.status}`);
  const data = await response.json();
  if (!data?.success) throw new Error(data?.message || "сайт не віддав список серій");
  playlist = uakinoParsePlaylist(data.response);
  if (!playlist.episodes.length) throw new Error("у списку серій порожньо");
  return playlist;
}

// Адреси потоку однієї серії. Сторінку плеєра бере фон розширення: з
// контексту сайту чужий домен закритий CORS.
async function uakinoStreams(file) {
  const answer = await chrome.runtime.sendMessage({type: "player-page", url: file, referer: location.origin + "/"});
  if (!answer || answer.error) throw new Error(answer?.error || "фон розширення не відповів");
  const streams = uakinoPlayerStreams(answer.html);
  if (!streams.length) throw new Error("у сторінці плеєра не знайшлося адреси відео");
  return streams;
}

if (typeof module !== "undefined") module.exports = {uakinoParsePlaylist, uakinoPlayerStreams};
