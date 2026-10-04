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
// Списків над серіями буває кілька рівнів: скрипт сайту проходить
// .playlists-lists .playlists-items по черзі, і кожен наступний рівень
// фільтрує за префіксом data-id попереднього («0» → «0_0», «0_1»). Серія ж
// посилається на найглибший рівень. Тому озвучка — це лише той пункт, на
// який посилаються серії, а назви його батьків (часто «Сезон 2») йдуть у
// підпис і, якщо там номер сезону, у сам сезон.
//
// Списку озвучок буває й зовсім немає — у серіалу з однією озвучкою сайт
// його не малює. Тоді назву беремо з data-voice самих серій.
function uakinoParsePlaylist(html) {
  const labels = new Map();
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
    } else if (text && !labels.has(attrs["data-id"])) {
      labels.set(attrs["data-id"], text);
    }
  }
  const voices = [];
  for (const item of episodes) {
    if (voices.some(voice => voice.id === item.voiceId)) continue;
    const parts = item.voiceId.split("_");
    const chain = parts.map((_, index) => labels.get(parts.slice(0, index + 1).join("_"))).filter(Boolean);
    const voice = {id: item.voiceId, name: chain.join(" · ") || item.voice || item.voiceId};
    const season = chain.map(label => label.match(/(\d+)\s*сезон|сезон\s*(\d+)/i)).find(Boolean);
    if (season) voice.season = season[1] || season[2];
    voices.push(voice);
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
// Скрипт сайту вантажить його лише тоді, коли блок потрапляє на екран
// (IntersectionObserver). У фоновій вкладці, яку відкриває панель, цього
// може не статись узагалі, тож чекати на нього — марно. Порядок такий:
// уже намальований список, якщо людина гортала сторінку; далі той самий
// запит, що робить сайт; і лише якщо він не вдався — прокрутка до блоку й
// очікування, раптом сайт змінив адресу запиту.
async function uakinoPlaylist() {
  const box = document.querySelector(".playlists-ajax");
  const fromDom = () => box && box.querySelector("li[data-file]") ? uakinoParsePlaylist(box.innerHTML) : null;
  let playlist = fromDom();
  if (playlist?.episodes.length) return playlist;

  let failure = "";
  try {
    playlist = uakinoParsePlaylist(await uakinoFetchPlaylist(box));
    if (playlist.episodes.length) return playlist;
    failure = "у списку серій порожньо";
  } catch (error) {
    failure = error.message;
  }

  box?.scrollIntoView({block: "center"});
  for (let waited = 0; waited < 8000; waited += 400) {
    await new Promise(resolve => setTimeout(resolve, 400));
    playlist = fromDom();
    if (playlist?.episodes.length) return playlist;
  }
  throw new Error(failure || "список серій не завантажився");
}

// Той самий запит, що й у скрипта сайту:
//   GET /engine/ajax/playlists.php?news_id=…&xfield=…&time=dle_edittime
// time — позначка редагування новини, сайт за нею кешує відповідь.
async function uakinoFetchPlaylist(box) {
  const html = document.documentElement.innerHTML;
  const root = (html.match(/dle_root\s*=\s*['"]([^'"]*)['"]/) || [null, "/"])[1] || "/";
  const edited = (html.match(/dle_edittime\s*=\s*['"]?(\d+)/) || [null, ""])[1] || String(Math.floor(Date.now() / 1000));
  const params = new URLSearchParams({news_id: box?.dataset.news_id || "", xfield: box?.dataset.xfname || "playlist", time: edited});
  const response = await fetch(`${location.origin}${root.endsWith("/") ? root : root + "/"}engine/ajax/playlists.php?${params}`, {
    credentials: "include",
    headers: {"X-Requested-With": "XMLHttpRequest"}
  });
  if (!response.ok) throw new Error(`список серій: сайт відповів ${response.status}`);
  const data = await response.json();
  if (!data?.success) throw new Error(data?.message || "сайт не віддав список серій");
  return data.response;
}

// Якості з master-плейлиста.
//
// ashdi віддає в конфігу плеєра одну адресу index.m3u8, а вже в ній —
// перелік варіантів (#EXT-X-STREAM-INF з RESOLUTION і адресою, часто на
// іншому піддомені). Без розбору панель бачила одну «auto» й ховала
// перемикач якості, а yt-dlp мовчки брав найкращу. Тепер кожен варіант іде
// окремою якістю, як у HDRezka, і вибирати можна вручну.
//
// Підпис якості — висота кадру з RESOLUTION («480p»), інакше NAME, інакше
// число з адреси (…/hls/480/…). Порядок — від меншої до більшої: панель
// за замовчуванням бере останню.
function uakinoMasterVariants(text, base) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim());
  if (!lines.some(line => line.startsWith("#EXT-X-STREAM-INF"))) return [];
  const found = new Map();
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF")) continue;
    const info = lines[index];
    let uri = "";
    for (let next = index + 1; next < lines.length; next++) {
      if (!lines[next] || lines[next].startsWith("#")) continue;
      uri = lines[next];
      break;
    }
    if (!uri) continue;
    let url;
    try { url = new URL(uakinoAbsolute(uri), base).href; } catch (_) { continue; }
    const height = Number((info.match(/RESOLUTION=\d+x(\d+)/i) || [])[1] || 0);
    const name = (info.match(/NAME="?([^",]+)/i) || [])[1] || "";
    const fromPath = Number((url.match(/\/(\d{3,4})p?\//) || [])[1] || 0);
    const bandwidth = Number((info.match(/[,:]BANDWIDTH=(\d+)/i) || [])[1] || 0);
    const size = height || fromPath;
    const quality = size ? `${size}p` : name || `${Math.round(bandwidth / 1000)}k`;
    const known = found.get(quality);
    // Однакова якість двічі (різний бітрейт) — лишаємо кращу.
    if (!known || bandwidth > known.bandwidth) found.set(quality, {quality, urls: [url], size: size || bandwidth / 1e6, bandwidth});
  }
  return [...found.values()].sort((a, b) => a.size - b.size).map(({quality, urls}) => ({quality, urls}));
}

// Адреси потоку однієї серії. Сторінку плеєра бере фон розширення: з
// контексту сайту чужий домен закритий CORS.
async function uakinoStreams(file) {
  const answer = await chrome.runtime.sendMessage({type: "player-page", url: file, referer: location.origin + "/"});
  if (!answer || answer.error) throw new Error(answer?.error || "фон розширення не відповів");
  const streams = uakinoPlayerStreams(answer.html);
  if (!streams.length) throw new Error("у сторінці плеєра не знайшлося адреси відео");
  if (streams.length !== 1 || streams[0].urls.length !== 1) return streams;

  // Одна адреса — найімовірніше master-плейлист. Читаємо його так само, як
  // плеєр: через фон і з Referer сторінки плеєра. Не вийшло — лишається
  // «auto», і yt-dlp сам візьме найкращу.
  const master = streams[0].urls[0];
  try {
    const playlist = await chrome.runtime.sendMessage({type: "player-page", url: master, referer: new URL(file).origin + "/"});
    const variants = playlist && !playlist.error ? uakinoMasterVariants(playlist.html, master) : [];
    if (variants.length) return variants;
  } catch (_) {}
  return streams;
}

if (typeof module !== "undefined") module.exports = {uakinoParsePlaylist, uakinoPlayerStreams, uakinoMasterVariants};
