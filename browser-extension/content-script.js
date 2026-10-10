let scanCancelled = false;
let scanRunning = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nodeText = node => (node?.getAttribute("title") || node?.textContent || "").replace(/\s+/g, " ").trim();
const active = selector => document.querySelector(`${selector}.active`) || document.querySelector(selector);

// Скільки чекати на плейлист після кліку, перш ніж визнати епізод пропущеним.
//
// Раніше тут стояв фіксований сон на 1700 мс, і він відповідав одразу на два
// питання неправильно. Хто не встиг — того лінк приписували наступному
// епізоду (і там він гинув як дублікат), а хто встиг за 200 мс — той усе
// одно лежав решту півтори секунди. Для 61 епізоду це 104 секунди чистого
// сну незалежно ні від чого.
//
// Тепер чекаємо ПОДІЮ: на швидких епізодах цикл іде далі одразу, і бюджет
// витрачається лише там, де справді нічого не приїхало.
//
// П'ять секунд, а не вісім: плейлист, який не почав вантажитись за цей час
// після кліку, уже не приїде — сайт віддав помилку. А оскільки невдала
// спроба тепер повторюється, коротший бюджет нічого не коштує.
const LINK_TIMEOUT = 5000;

// Пауза між епізодами. Не для очікування — лише щоб не гатити по сайту
// впритул: без неї плеєр інколи не встигає скинути попереднє джерело.
const SETTLE = 150;

// Скільки перших епізодів мають змовчати, перш ніж визнати, що сигнал про
// захоплення до нас не доходить узагалі.
//
// Такий випадок цілком реальний: розширення перевстановили без перезавантаження
// сторінки, фонову сторінку вивантажили, сайт віддає плейлист у формі, якої
// PLAYLIST_RE не ловить. Без цієї перевірки прохід став би ПОВІЛЬНІШИМ за
// старий фіксований сон — по три спроби на епізод, і кожна в бюджет.
//
// Рахуємо лише ДО першого спійманого лінка й лише перші спроби. Щойно хоч
// один лінк дійшов, ми знаємо, що канал робочий, — і тиша після цього означає
// вже не поломку, а помилку сайту, на яку правильна відповідь повтор.
const BLIND_AFTER = 2;

// Пауза, на яку відкочуємось, коли сигналу немає. Те саме число, що стояло
// тут до переробки: гірше за очікування події, але передбачувано.
const BLIND_DELAY = 1700;

// Скільки разів пробувати той самий епізод.
//
// Сайт під швидким проходом періодично віддає помилку замість плеєра. Досі
// це коштувало лінка назавжди: епізод мовчав, сканер записував його в
// пропущені й їхав далі. Але мовчання тут — не «немає відео», а «сервер не
// встиг», і правильна відповідь на нього — повторити, а не здатися.
const MAX_TRIES = 3;

// Паузи перед повтором. Ростуть, бо якщо сайт спіткнувся, то через півсекунди
// він спіткнеться знову — йому треба дати віддихатись.
const RETRY_BACKOFF = [1200, 3500];

// Адаптивний темп між епізодами.
//
// Замість того щоб підбирати одну «безпечну» паузу наосліп, сканер міряє її
// сам: після невдачі сповільнюється, після кількох поспіль успіхів
// пришвидшується назад. На здоровому сайті прохід лишається швидким, а на
// втомленому сам сповзає в режим, який той витримує.
const PACE_MIN = 150;
const PACE_MAX = 4000;
const PACE_UP = 900;
const PACE_DOWN = 120;

let contextSeq = 0;
let pendingLink = null;

chrome.runtime.sendMessage({type: "bridge-heartbeat"}).catch(() => {});
setInterval(() => chrome.runtime.sendMessage({type: "bridge-heartbeat"}).catch(() => {}), 30_000);

// Чекає на лінк для конкретного кроку сканування.
//
// seq відсіює запізнілі лінки попереднього епізоду: плеєр іноді дотягує
// плейлист уже після перемикання, і без цієї перевірки такий сигнал рухав би
// сканер далі, лишаючи поточний епізод без адреси.
function waitForLink(seq) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingLink = null;
      resolve(null);
    }, LINK_TIMEOUT);
    pendingLink = {
      seq,
      settle(url) {
        clearTimeout(timer);
        pendingLink = null;
        resolve(url);
      }
    };
  });
}

// Підключає й знімає підміну видимості.
//
// Тег <script src=…>, а не inline: багато сайтів забороняють вбудовані
// скрипти через CSP, і inline-варіант мовчки не виконався б саме там, де
// потрібен. Файл лежить у web_accessible_resources.
function stayAwake(on) {
  const ID = "hls-grabber-stay-awake";
  if (on) {
    if (document.getElementById(ID)) return;
    const script = document.createElement("script");
    script.id = ID;
    script.src = chrome.runtime.getURL("stay-awake.js");
    (document.head || document.documentElement).appendChild(script);
    return;
  }
  document.getElementById(ID)?.remove();
  // Вимкнення робимо тим самим шляхом — з контексту сторінки: наша функція
  // відкату живе в її window, а не в нашому.
  const off = document.createElement("script");
  off.textContent = "window.__hlsGrabberStayAwake && window.__hlsGrabberStayAwake();";
  (document.head || document.documentElement).appendChild(off);
  off.remove();
}

function pageMetadata() {
  const voiceNode = active(".b-translator__item");
  const seasonNode = active(".b-simple_season__item");
  const episodeNode = active(".b-simple_episode__item");
  const single = voiceNode ? null : singleVoice();
  return {
    title: document.querySelector('meta[property="og:title"]')?.content || document.title,
    pageUrl: location.href,
    voice: nodeText(voiceNode) || single?.name || "",
    translatorId: voiceNode?.dataset.translator_id || single?.id || "",
    season: seasonNode?.dataset.tab_id || seasonNode?.textContent?.match(/\d+/)?.[0] || "",
    episode: episodeNode?.dataset.episode_id || episodeNode?.textContent?.match(/\d+/)?.[0] || ""
  };
}

// Єдина озвучка серіалу.
//
// Коли озвучка одна, HDRezka не малює списку .b-translator__item зовсім.
// Каталог тоді виходив порожнім — панель не мала що вибрати, і сканувати
// було нічого. Номер озвучки сайт однаково передає плеєру в
// initCDNSeriesEvents(id, translator_id, …), а назву пише в таблиці
// інформації, у рядку «В переводе» / «В перекладі».
function singleVoice() {
  if (document.querySelector(".b-translator__item")) return null;
  const {translatorId} = cdnPageParams();
  if (!translatorId) return null;
  let name = "";
  for (const row of document.querySelectorAll(".b-post__info tr")) {
    const cells = row.querySelectorAll("td");
    if (cells.length >= 2 && /в\s+перев|в\s+перекл/i.test(nodeText(cells[0]))) {
      name = nodeText(cells[1]);
      break;
    }
  }
  return {id: translatorId, name: name || "Озвучка", active: true};
}

function catalog() {
  const single = singleVoice();
  const translators = single
    ? [single]
    : [...document.querySelectorAll(".b-translator__item")].map(node => ({id: node.dataset.translator_id || "", name: nodeText(node), active: node.classList.contains("active")})).filter(item => item.id);
  return {
    title: pageMetadata().title,
    supported: translators.length > 0 || Boolean(document.querySelector(".b-simple_episode__item")),
    translators
  };
}

async function clickAndWait(node, delay) {
  node.scrollIntoView({block: "center"});
  node.click();
  await sleep(delay);
}

// ── Обхід через API сайту ───────────────────────────────────────────────
//
// Головний шлях. Один запит на епізод замість запуску плеєра, і в ньому
// одразу всі якості. Помічники — у cdn-api.js.
//
// Пауза між запитами лишається адаптивною з тієї самої причини, що й у
// клікалці: сайт сердиться на темп. Але починає вона з набагато меншого
// значення — тут на епізод іде один запит, а не десяток.
const API_PACE_MIN = 120;
const API_PACE_MAX = 3000;

async function apiScan(translatorIds) {
  const params = cdnPageParams();
  const started = Date.now();
  const missed = [];
  let completed = 0;
  let retries = 0;
  let pace = API_PACE_MIN;

  for (const translatorId of translatorIds) {
    if (scanCancelled) break;

    const node = document.querySelector(`.b-translator__item[data-translator_id="${CSS.escape(translatorId)}"]`);
    const voice = nodeText(node) || singleVoice()?.name || "";

    let list;
    try {
      list = await cdnApi({
        id: params.itemId, translator_id: translatorId,
        favs: params.favs, action: "get_episodes"
      });
    } catch (error) {
      // Озвучка недоступна — це не привід валити весь прохід: решта
      // цілком може віддатись.
      missed.push({voice, season: "", episode: "", reason: error.message});
      continue;
    }

    for (const item of cdnParseEpisodes(list.episodes)) {
      if (scanCancelled) break;

      let streams = null;
      for (let attempt = 1; attempt <= MAX_TRIES && !streams && !scanCancelled; attempt++) {
        if (attempt > 1) {
          retries++;
          await sleep(RETRY_BACKOFF[attempt - 2]);
        }
        try {
          const data = await cdnApi({
            id: params.itemId, translator_id: translatorId,
            season: item.season, episode: item.episode,
            favs: params.favs, action: "get_stream"
          });
          const parsed = cdnParseStreams(data.url);
          if (parsed.length) streams = parsed;
        } catch (error) {
          item.reason = error.message;
        }
      }

      if (streams) {
        completed++;
        pace = Math.max(API_PACE_MIN, pace - PACE_DOWN);
        await chrome.runtime.sendMessage({
          type: "cdn-found",
          payload: {
            title: pageMetadata().title,
            pageUrl: location.href,
            voice,
            translatorId,
            season: item.season,
            episode: item.episode,
            streams
          }
        });
      } else {
        missed.push({voice, season: item.season, episode: item.episode, reason: item.reason || "порожня відповідь"});
        pace = Math.min(API_PACE_MAX, pace + PACE_UP);
      }

      await chrome.runtime.sendMessage({type: "scan-progress", completed});
      await sleep(pace);
    }
  }

  return {completed, missed, retries, via: "api", cancelled: scanCancelled, elapsedMs: Date.now() - started};
}

// ── Обхід uakino ────────────────────────────────────────────────────────
//
// Список серій береться з плейлиста сторінки, а адреса відео — зі сторінки
// плеєра ashdi кожної серії. Помічники — у uakino.js. Темп і повтори ті ж,
// що й для HDRezka: на серію тут теж один запит, тільки до плеєра.

let uakinoCache = null;

// Усі сезони серіалу: поточна сторінка й ті, на які веде перемикач сезонів.
async function uakinoLoad() {
  if (!uakinoCache) uakinoCache = await uakinoAllSeasons();
  return uakinoCache;
}

// Ключ озвучки в каталозі. Коли сезон один, лишаємо голий data-id сайту,
// як було. Коли кілька — додаємо сезон: «0_0» є на кожній сторінці.
function uakinoVoiceKey(entry, voice, multiple) {
  return multiple ? `s${entry.season}:${voice.id}` : voice.id;
}

function uakinoFindVoice(cache, key) {
  const multiple = cache.seasons.length > 1;
  for (const entry of cache.seasons) {
    const voice = entry.playlist.voices.find(item => uakinoVoiceKey(entry, item, multiple) === key);
    if (voice) return {entry, voice};
  }
  return null;
}

async function uakinoCatalog() {
  const cache = await uakinoLoad();
  const multiple = cache.seasons.length > 1;
  const translators = cache.seasons.flatMap(entry => entry.playlist.voices.map(voice => ({
    id: uakinoVoiceKey(entry, voice, multiple),
    // Назва вже має сезон, якщо він прийшов із рівнів плейлиста.
    name: multiple && !voice.season ? `${entry.season} сезон · ${voice.name}` : voice.name,
    active: false
  })));
  if (cache.failed.length) console.warn("HLS Grabber: не всі сезони завантажились:", cache.failed);
  return {
    title: uakinoTitle(),
    supported: translators.length > 0,
    translators,
    notice: cache.failed.length ? `Не завантажились: ${cache.failed.join("; ")}` : ""
  };
}

async function uakinoScan(translatorIds) {
  const started = Date.now();
  const missed = [];
  let completed = 0;
  let retries = 0;
  let pace = API_PACE_MIN;
  const cache = await uakinoLoad();
  const title = uakinoTitle();

  for (const key of translatorIds) {
    if (scanCancelled) break;
    const found = uakinoFindVoice(cache, key);
    if (!found) continue;
    const {entry, voice} = found;
    // Сезон із назви рівня плейлиста («Сезон 2 · Озвучка»), якщо він там є;
    // інакше — сезон сторінки, з якої прийшов плейлист.
    const voiceSeason = voice.season || entry.season;
    for (const item of entry.playlist.episodes.filter(episode => episode.voiceId === voice.id)) {
      if (scanCancelled) break;
      let streams = null;
      let reason = "";
      for (let attempt = 1; attempt <= MAX_TRIES && !streams && !scanCancelled; attempt++) {
        if (attempt > 1) {
          retries++;
          await sleep(RETRY_BACKOFF[attempt - 2]);
        }
        try { streams = await uakinoStreams(item.file); }
        catch (error) { reason = error.message; }
      }

      if (streams) {
        completed++;
        pace = Math.max(API_PACE_MIN, pace - PACE_DOWN);
        // pageUrl і translatorId — сторінки сезону й голий data-id сайту:
        // за ними панель потім просить свіже посилання, відкриваючи саме
        // сторінку цього сезону.
        await chrome.runtime.sendMessage({
          type: "cdn-found",
          payload: {title, pageUrl: entry.url, voice: item.voice, translatorId: voice.id, season: voiceSeason, episode: item.episode, streams}
        });
      } else {
        missed.push({voice: item.voice, season: voiceSeason, episode: item.episode, reason: reason || "порожня відповідь"});
        pace = Math.min(API_PACE_MAX, pace + PACE_UP);
      }

      await chrome.runtime.sendMessage({type: "scan-progress", completed});
      await sleep(pace);
    }
  }

  return {completed, missed, retries, via: "uakino", cancelled: scanCancelled, elapsedMs: Date.now() - started};
}

async function uakinoResolve({translatorId, voice, episode}) {
  // Лише поточна сторінка (панель відкриває сторінку саме того сезону) і
  // свіжий список, а не з кешу: протухнути могла й адреса плеєра.
  uakinoCache = null;
  const playlist = await uakinoPlaylist();
  const item = playlist.episodes.find(entry =>
    (translatorId ? entry.voiceId === translatorId : entry.voice === voice) && entry.episode === String(episode));
  if (!item) throw new Error(`серії ${episode} озвучки «${voice}» на сторінці немає`);
  return uakinoStreams(item.file);
}

async function scan(translatorIds) {
  // Сторінка має вважати себе видимою на весь прохід — інакше у фоновій
  // вкладці плеєр не почне вантажити плейлист, і сканувати доведеться,
  // сидячи на ній і дивлячись. Для apiScan це не потрібне: там плеєр не
  // бере участі взагалі.
  stayAwake(true);
  let completed = 0;
  // Пропущені збираємо поіменно й повертаємо назовні. Досі різниця між
  // «61 епізод» і «59 лінків» була невидима: сканер рапортував про 61
  // пройдений крок, і де саме зникли два, не знав ніхто.
  const missed = [];
  const started = Date.now();
  let blindStreak = 0;
  let blind = false;
  let everCaptured = false;
  let retries = 0;
  let pace = PACE_MIN;
  try {
    for (const translatorId of translatorIds) {
      if (scanCancelled) break;
      const translator = document.querySelector(`.b-translator__item[data-translator_id="${CSS.escape(translatorId)}"]`);
      if (!translator) continue;
      await clickAndWait(translator, 900);
      const voice = nodeText(translator);
      for (const seasonNode of [...document.querySelectorAll(".b-simple_season__item")]) {
        if (scanCancelled) break;
        await clickAndWait(seasonNode, 650);
        const season = seasonNode.dataset.tab_id || seasonNode.textContent.match(/\d+/)?.[0] || "";
        const episodes = [...document.querySelectorAll(`.b-simple_episode__item[data-season_id="${CSS.escape(season)}"]`)];
        for (const episodeNode of episodes) {
          if (scanCancelled) break;
          const episode = episodeNode.dataset.episode_id || episodeNode.textContent.match(/\d+/)?.[0] || "";

          let got = false;
          for (let attempt = 1; attempt <= MAX_TRIES && !got && !scanCancelled && !blind; attempt++) {
            if (attempt > 1) {
              retries++;
              await sleep(RETRY_BACKOFF[attempt - 2]);
            }

            // Контекст оголошуємо ДО кліку й чекаємо, поки фоновий скрипт
            // його прийме: інакше запит плеєра встиг би початися під
            // попереднім. Номер новий на кожну спробу, щоб лінк невдалої
            // спроби, який дотягнувся із запізненням, не зарахувався
            // наступній.
            const seq = ++contextSeq;
            await chrome.runtime.sendMessage({
              type: "scan-context",
              context: {title: pageMetadata().title, pageUrl: location.href, voice, translatorId, season, episode, seq}
            });

            // Слухача ставимо ПЕРЕД кліком: плейлист інколи приїжджає за
            // десятки мілісекунд, і з очікуванням після кліку його можна
            // просто не почути.
            const link = blind ? null : waitForLink(seq);
            episodeNode.scrollIntoView({block: "center"});
            episodeNode.click();

            if (blind) {
              // Сигналу немає — працюємо як раніше, за годинником. Лінк при
              // цьому однаково перехоплюється фоновим скриптом; ми лише не
              // знаємо, чи він був, тому й повторювати нема за чим.
              await sleep(BLIND_DELAY);
              got = true;
            } else {
              got = Boolean(await link);
              if (got) {
                everCaptured = true;
              } else if (!everCaptured && attempt === 1 && ++blindStreak >= BLIND_AFTER) {
                // Жодного лінка не було від початку, і вже другий епізод
                // мовчить із першої спроби. Далі повторювати нема сенсу:
                // мовчить не сайт, а канал зв'язку.
                blind = true;
              }
            }
          }

          if (got) {
            completed++;
            // Сповзаємо назад до швидкого темпу поступово, а не стрибком:
            // один вдалий епізод ще не означає, що сайт віддихався.
            pace = Math.max(PACE_MIN, pace - PACE_DOWN);
          } else if (!blind) {
            missed.push({voice, season, episode});
            pace = Math.min(PACE_MAX, pace + PACE_UP);
          }

          await chrome.runtime.sendMessage({type: "scan-progress", completed});
          await sleep(pace);
        }
      }
    }
    return {completed, missed, blind, retries, pace, via: "player", cancelled: scanCancelled, elapsedMs: Date.now() - started};
  } finally {
    pendingLink = null;
    // Повертаємо сторінці чесну видимість: постійна підміна ламала б їй
    // паузу відео при переході на іншу вкладку, тобто нормальну поведінку.
    stayAwake(false);
    await chrome.runtime.sendMessage({type: "scan-context", context: null});
  }
}

// Свіжі адреси однієї серії — для черги панелі, коли стара протухла.
//
// Один запит без власних повторів: черга сама вирішує, коли пробувати ще.
// Озвучку шукаємо за номером, а якщо задача його не пам'ятає — за назвою.
async function resolveEpisode({translatorId, voice, season, episode}) {
  if (uakinoAvailable()) return uakinoResolve({translatorId, voice, episode});
  if (!cdnAvailable()) throw new Error("ця сторінка не віддає адрес через API сайту");
  if (!translatorId && voice) {
    const node = [...document.querySelectorAll(".b-translator__item")].find(item => nodeText(item) === voice);
    translatorId = node?.dataset.translator_id || "";
  }
  // Серіал з однією озвучкою списку озвучок не має взагалі — тоді номер
  // береться з ініціалізації плеєра.
  const params = cdnPageParams();
  translatorId = translatorId || params.translatorId;
  if (!translatorId) throw new Error(`озвучку «${voice}» на сторінці не знайдено`);
  const data = await cdnApi({
    id: params.itemId, translator_id: translatorId,
    season, episode, favs: params.favs, action: "get_stream"
  });
  const streams = cdnParseStreams(data.url);
  if (!streams.length) throw new Error("сайт не віддав адрес для цієї серії");
  return streams;
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "page-metadata") { respond(pageMetadata()); return; }
  if (message?.type === "resolve-episode") {
    resolveEpisode(message)
      .then(streams => respond({streams}))
      .catch(error => respond({error: error.message}));
    return true;
  }
  if (message?.type === "get-catalog") {
    if (!uakinoAvailable()) { respond(catalog()); return; }
    // Плейлист uakino вантажиться окремим запитом, тож відповідь асинхронна.
    // Помилку віддаємо як «не підтримується» з причиною, а не тишею.
    uakinoCatalog()
      .then(respond)
      .catch(error => respond({title: uakinoTitle(), supported: false, translators: [], error: error.message}));
    return true;
  }
  if (message?.type === "cancel-scan") { scanCancelled = true; respond({ok: true}); return; }
  if (message?.type === "link-captured") {
    if (pendingLink && pendingLink.seq === message.seq) pendingLink.settle(message.url);
    respond({ok: true});
    return;
  }
  if (message?.type === "start-scan") {
    // Через API, коли сторінка його підтримує; інакше старою клікалкою.
    // Перевірка дешева — наявність cdnItemId у розмітці, — і робить перехід
    // непомітним: той самий виклик, той самий формат відповіді.
    const runner = uakinoAvailable() ? uakinoScan : cdnAvailable() ? apiScan : scan;
    if (scanRunning) { respond({error: "Сканування вже виконується"}); return; }
    scanRunning = true; scanCancelled = false;
    Promise.resolve()
      .then(() => runner(message.translatorIds || []))
      .then(result => {
        // Підсумок віддаємо ДВІЧІ: тому, хто попросив, і фоновому скрипту.
        //
        // Перший адресат зазвичай уже мертвий: попап Firefox знищується,
        // щойно втрачає фокус, а прохід триває хвилини. Фон же переживе і
        // це, і власне вивантаження, тож саме там результат чекає, поки
        // попап відкриють знову.
        chrome.runtime.sendMessage({type: "scan-finished", result}).catch(() => {});
        respond(result);
      })
      .catch(error => {
        chrome.runtime.sendMessage({type: "scan-finished", result: {error: error.message}}).catch(() => {});
        respond({error: error.message});
      })
      .finally(() => { scanRunning = false; });
    return true;
  }
});
