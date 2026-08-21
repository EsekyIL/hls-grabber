// Прямий обхід через API самого сайту.
//
// Стара схема клацала епізод, чекала, поки ініціалізується плеєр, і
// підслуховувала його мережеві запити. Вона працює, але дорого: на кожен
// епізод — повний запуск плеєра, купа запитів, залежність від видимості
// вкладки й одна-єдина якість, та, яку плеєр вибрав сам.
//
// Виявилось, що плеєр бере адреси зі звичайного ендпоінта, доступного й нам:
//
//   POST {dle_root}ajax/get_cdn_series/?t={час}
//        id, translator_id, season, episode, favs, action=get_stream
//     -> {"success":true,"url":"[360p]https://… or https://…,[480p]…"}
//
// Один запит на епізод замість запуску плеєра, і в ньому ВСІ якості одразу.
// Тому вибір якості більше не треба виставляти в плеєрі й сподіватись, що він
// його запам'ятає: панель просто бере потрібний рядок із набору.
//
// Клікалка лишається сусіднім файлом як запасний шлях — якщо сайт колись
// прикриє цей ендпоінт, вона ще стане в пригоді.

// Параметри сторінки.
//
// Читаються з розмітки, а не з window: content script живе в ізольованому
// світі, і змінних сторінки (cdnItemId, dle_root) там просто немає — вони
// оголошені в її власному контексті.
function cdnPageParams() {
  const html = document.documentElement.innerHTML;
  const init = html.match(/initCDNSeries(?:Events)?\(\s*(\d+)\s*,\s*(\d+)/);
  const root = (html.match(/dle_root\s*=\s*['"]([^'"]*)['"]/) || [null, "/"])[1];
  return {
    itemId: init ? init[1] : "",
    translatorId: init ? init[2] : "",
    favs: document.querySelector("#ctrl_favs")?.value || "",
    root: root.endsWith("/") ? root : root + "/"
  };
}

function cdnAvailable() {
  return Boolean(cdnPageParams().itemId);
}

async function cdnApi(params) {
  const {root} = cdnPageParams();
  const response = await fetch(`${location.origin}${root}ajax/get_cdn_series/?t=${Date.now()}`, {
    method: "POST",
    // Куки обов'язкові: без сесії сайт віддає порожнечу або преміум-заглушку.
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      // Той самий заголовок, що ставить jQuery у самого сайту. Без нього
      // частина збірок DLE відповідає сторінкою замість JSON.
      "X-Requested-With": "XMLHttpRequest"
    },
    body: new URLSearchParams(params).toString()
  });
  if (!response.ok) throw new Error(`сайт відповів ${response.status}`);
  const data = await response.json();
  if (data && data.success === false) throw new Error(data.message || "сайт відмовив");
  return data;
}

// Розбирає рядок виду «[360p]url1 or url2,[1080p Ultra]url3».
//
// Ділимо за комою ПЕРЕД дужкою, а не за будь-якою: у підписах якості кома
// не трапляється, а от у самих адресах — цілком.
function cdnParseStreams(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  // Частина збірок віддає рядок закодованим, із службовим префіксом. Розбір
  // такого дав би тишу замість помилки, тож кажемо про це вголос.
  if (!raw.trimStart().startsWith("[")) {
    throw new Error("сайт віддав адреси в незнайомому вигляді");
  }
  const out = [];
  for (const chunk of raw.split(/,(?=\[)/)) {
    const match = chunk.match(/^\s*\[([^\]]+)\]([\s\S]*)$/);
    if (!match) continue;
    const urls = match[2].split(" or ").map(url => url.trim()).filter(url => /^https?:\/\//.test(url));
    if (!urls.length) continue;
    // Плейлисти в пріоритеті: поруч лежить прямий mp4, але завантажувач
    // налаштований саме на HLS, і mp4 лишаємо лише коли іншого немає.
    const playlists = urls.filter(url => url.includes(".m3u8"));
    out.push({quality: match[1].trim(), urls: playlists.length ? playlists : urls});
  }
  return out;
}

// Витягує перелік серій із розмітки, яку повертає get_episodes.
function cdnParseEpisodes(markup) {
  if (!markup) return [];
  const doc = new DOMParser().parseFromString(String(markup), "text/html");
  return [...doc.querySelectorAll(".b-simple_episode__item")].map(node => ({
    season: node.dataset.season_id || "",
    episode: node.dataset.episode_id || "",
    title: (node.textContent || "").replace(/\s+/g, " ").trim()
  })).filter(item => item.season && item.episode);
}
