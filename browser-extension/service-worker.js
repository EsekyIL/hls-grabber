// Міст між сторінкою і локальною панеллю: ловить плейлисти й віддає їх у
// /api/inbox, а сканеру повідомляє, що для поточного епізоду лінк уже є.

const sent = new Map();
const scanContexts = new Map();

// Плейлист не завжди має .m3u8 у шляху: частина плеєрів віддає його як
// /playlist?type=hls або /master?format=m3u8. Стара перевірка вимагала саме
// розширення й такі адреси не бачила зовсім.
const PLAYLIST_RE = /\.m3u8(?:[?#]|$)|[?&](?:type|format|ext)=m3u8|\/master(?:[?#]|$)/i;

async function settings() {
  return chrome.storage.local.get({enabled: true, port: 8788});
}

async function heartbeat() {
  const {port} = await settings();
  try {
    await fetch(`http://127.0.0.1:${port}/api/bridge/heartbeat`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({version: chrome.runtime.getManifest().version, browser: "Firefox"})
    });
  } catch (_) {}
}

async function sendURL(url, tabId, context) {
  // Сканеру кажемо ПЕРШИМ ділом — до settings(), до всього. Його темп не має
  // залежати ні від сховища, ні від локального сервера.
  //
  // seq відсіює лінки, що приїхали під попередній епізод: такий сигнал не
  // має рухати сканер далі, інакше поточний епізод лишиться без адреси.
  if (tabId >= 0 && context.seq) {
    chrome.tabs.sendMessage(tabId, {type: "link-captured", seq: context.seq, url}).catch(() => {});
  }

  const {enabled, port} = await settings();
  if (!enabled) return;

  // Контекст сюди приходить готовим, знятим синхронно в момент СТАРТУ
  // запиту. Спершу він читався тут, перед самим fetch, тобто вже після
  // кількох await'ів — і сканер устигав перейти на наступний епізод. Лінк
  // їхав із чужою міткою, на сервері збігався з парою «озвучка + сезон +
  // епізод» уже наявного запису й мовчки викидався як дублікат. Один
  // повільний епізод коштував одного лінка: 61 → 59.
  //
  // Порожній контекст — ознака того, що фонову сторінку встигли вивантажити
  // разом із Map. Дістаємо з session-сховища, воно це переживає.
  if (tabId >= 0 && !context.seq) {
    try {
      const saved = await chrome.storage.session.get("ctx:" + tabId);
      context = saved["ctx:" + tabId] || context;
    } catch (_) {}
  }

  const now = Date.now();
  if (now - (sent.get(url) || 0) < 30_000) return;
  sent.set(url, now);

  try {
    await heartbeat();

// Опитуємо чергу команд разом із серцебиттям. Alarms, а не setInterval:
// таймери фонової сторінки вмирають разом із її вивантаженням, а будильник
// її ж і будить.
chrome.alarms?.create("bridge-poll", {periodInMinutes: 0.25});
chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name !== "bridge-poll") return;
  heartbeat();
  pollCommands();
});
pollCommands();
    let tab = {}, metadata = context;
    if (tabId >= 0) {
      try { tab = await chrome.tabs.get(tabId); } catch (_) {}
      if (!metadata.title) try { metadata = await chrome.tabs.sendMessage(tabId, {type: "page-metadata"}); } catch (_) {}
    }
    await fetch(`http://127.0.0.1:${port}/api/inbox`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url, title: metadata.title || tab.title || "", pageUrl: metadata.pageUrl || tab.url || "", voice: metadata.voice || "", season: metadata.season || "", episode: metadata.episode || ""})
    });
    await chrome.action.setBadgeBackgroundColor({color: "#9bd51f"});
    await chrome.action.setBadgeText({text: "HLS"});
    setTimeout(() => chrome.action.setBadgeText({text: ""}), 1800);
  } catch (_) {
    await chrome.action.setBadgeBackgroundColor({color: "#e05762"});
    await chrome.action.setBadgeText({text: "!"});
  }
}

// Знахідка з API сайту.
//
// Іде окремим шляхом від перехоплення трафіку: там ми маємо одну адресу й
// мусимо здогадуватись про якість, а тут приходить готовий набір усіх
// якостей одразу. Дедуплікація за 30 секунд тут теж ні до чого — обхід і так
// питає кожен епізод рівно раз.
async function sendStreams(payload) {
  const {enabled, port} = await settings();
  if (!enabled) return;
  try {
    await fetch(`http://127.0.0.1:${port}/api/inbox`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });
    await chrome.action.setBadgeBackgroundColor({color: "#0cfc6c"});
    await chrome.action.setBadgeText({text: "OK"});
    setTimeout(() => chrome.action.setBadgeText({text: ""}), 1200);
  } catch (_) {
    await chrome.action.setBadgeBackgroundColor({color: "#ec2b2e"});
    await chrome.action.setBadgeText({text: "!"});
  }
}

// ── Стан сканування для попапа ──────────────────────────────────────────
//
// Попап Firefox знищується, щойно втрачає фокус, а прохід триває хвилини.
// Через це підсумок, який повертав start-scan, не бачив ніхто: обіцянка
// «покажу результат» жила рівно доти, доки вікно відкрите.
//
// Тому стан тримає фон. Копія в storage.session — на випадок, коли Firefox
// вивантажить фонову сторінку між подіями: без неї попап після пробудження
// показував би порожню форму посеред активного сканування.
let scanState = {running: false, completed: 0, tabId: null, result: null, startedAt: 0};

function saveScanState() {
  chrome.storage.session.set({scanState}).catch(() => {});
}

async function loadScanState() {
  try {
    const saved = await chrome.storage.session.get("scanState");
    if (saved.scanState) scanState = saved.scanState;
  } catch (_) {}
}

// ── Виконання команд панелі ─────────────────────────────────────────────
//
// Панель кладе завдання в чергу, ми забираємо його на кожному heartbeat.
// Опитування, а не сокет: фонову сторінку в Firefox вивантажують між
// подіями, і постійне з'єднання довелося б відновлювати після кожного
// пробудження.

let commandBusy = false;

async function report(port, payload) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/bridge/result`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });
  } catch (_) {}
}

// Чекає, поки у вкладці з'явиться наш content script.
//
// tabs.create повертається одразу, а скрипт вставляється аж на
// document_idle: без цього очікування перше ж повідомлення полетіло б у
// порожнечу, і команда мовчки нічого не зробила б.
//
// На половині шляху пробуємо впровадити скрипт САМІ. Оголошення в маніфесті
// не спрацьовує там, де сторінка так і не стала звичайною: перенаправлення,
// сторінка помилки мережі, перевірка «ти не робот». Явне впровадження або
// пробиває це, або чесно каже, що не змогло.
async function waitForContentScript(tabId, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let injected = false;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const catalog = await chrome.tabs.sendMessage(tabId, {type: "get-catalog"});
      if (catalog) return catalog;
      lastError = "порожня відповідь від сторінки";
    } catch (error) {
      lastError = error?.message || String(error);
    }

    if (!injected && Date.now() > deadline - timeoutMs / 2) {
      injected = true;
      try {
        await chrome.scripting.executeScript({
          target: {tabId},
          files: ["cdn-api.js", "content-script.js"],
        });
      } catch (error) {
        lastError = `впровадження не вдалось: ${error?.message || error}`;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Помилка має називати причину, а не лише факт. Досі тут було голе
  // «сторінка не відповіла вчасно», і воно однаково звучало і для збою
  // мережі, і для перевірки «ти не робот», і для чужої вкладки.
  let where = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    where = ` Вкладка: ${tab.status || "?"}, ${tab.url || "адреса невідома"}.`;
  } catch (_) {}
  throw new Error(`сторінка не відповіла за ${Math.round(timeoutMs / 1000)} с.${where} ${lastError}`.trim());
}

async function runCommand(command, port) {
  // Вкладка фонова: сенс усього задуму в тому, щоб не сидіти й не дивитись.
  // Працює це завдяки stay-awake.js для клікалки; обхід через API сайту
  // видимості не потребує взагалі.
  const tab = await chrome.tabs.create({url: command.url, active: false});
  try {
    const catalog = await waitForContentScript(tab.id);
    if (!catalog.supported) throw new Error("на цій сторінці адаптер не знайшов серіал");

    if (command.kind === "probe") {
      await report(port, {
        id: command.id, state: "ready",
        title: catalog.title, translators: catalog.translators
      });
      return;
    }

    await report(port, {id: command.id, state: "running", title: catalog.title, translators: catalog.translators});
    const result = await chrome.tabs.sendMessage(tab.id, {type: "start-scan", translatorIds: command.voices});
    if (result?.error) throw new Error(result.error);
    await report(port, {
      id: command.id, state: "done", title: catalog.title, translators: catalog.translators,
      completed: result?.completed || 0, missed: (result?.missed || []).length, retries: result?.retries || 0
    });
  } catch (error) {
    await report(port, {id: command.id, state: "failed", error: error.message});
  } finally {
    // Вкладку прибираємо завжди: інакше після десятка серіалів у Firefox
    // висіла б купа відкритих сторінок, про які ніхто не просив.
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
  }
}

async function pollCommands() {
  if (commandBusy) return;
  const {enabled, port} = await settings();
  if (!enabled) return;

  let commands = [];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/bridge/commands`);
    if (!response.ok) return;
    commands = await response.json();
  } catch (_) { return; }
  if (!commands.length) return;

  commandBusy = true;
  try {
    // По одній за раз: обхід ходить по чужому сайту, і два паралельні
    // прогони — найшвидший спосіб отримати блокування.
    for (const command of commands) await runCommand(command, port);
  } finally {
    commandBusy = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "bridge-heartbeat") heartbeat();
  if (message?.type === "scan-context" && sender.tab?.id >= 0) {
    // Дублюємо в session-сховище. Firefox тримає фонову сторінку як event
    // page і вивантажує її між подіями — разом із цією Map. Без копії
    // сканер після такого вивантаження чекав би на сигнал, якого вже нема
    // кому надіслати, тобто по вісім секунд на кожен епізод.
    const key = "ctx:" + sender.tab.id;
    if (message.context) {
      scanContexts.set(sender.tab.id, message.context);
      chrome.storage.session.set({[key]: message.context}).catch(() => {});
    } else {
      scanContexts.delete(sender.tab.id);
      chrome.storage.session.remove(key).catch(() => {});
    }
  }
  if (message?.type === "cdn-found") sendStreams(message.payload);
  if (message?.type === "scan-progress") {
    scanState = {
      ...scanState,
      running: true,
      completed: message.completed,
      tabId: sender.tab?.id ?? scanState.tabId,
      result: null,
      startedAt: scanState.startedAt || Date.now(),
    };
    saveScanState();
    chrome.action.setBadgeBackgroundColor({color: "#0cebfc"});
    chrome.action.setBadgeText({text: String(message.completed)});
  }
  if (message?.type === "scan-finished") {
    scanState = {...scanState, running: false, result: message.result || null};
    saveScanState();
    chrome.action.setBadgeText({text: ""});
  }
  if (message?.type === "get-scan-state") {
    // Асинхронна відповідь: стан міг лишитись лише в storage.session, якщо
    // фонову сторінку встигли вивантажити.
    loadScanState().then(() => sendResponse(scanState));
    return true;
  }
});

// onBeforeRequest, а не onCompleted.
//
// URL відома вже на старті запиту, тож чекати на завершення не було потреби
// — а саме з цього очікування й росли втрати. Клік по наступному епізоду
// обривав запит попереднього, і onCompleted для нього НЕ спрацьовував
// узагалі: такий лінк не губився в дедуплікації, він просто ніколи не
// надсилався. Плюс подія на старті приходить раніше за завершення, тож і
// сканер раніше йде далі.
//
// Платимо тим, що ловимо й ті плейлисти, які потім віддадуть 404. Мати
// адресу, яку можна перевірити, краще, ніж мовчки не мати нічого.
chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (!PLAYLIST_RE.test(details.url)) return;
    // Контекст знімаємо ТУТ, синхронно: це справжній момент старту запиту,
    // і жодного проміжку, за який сканер устиг би переїхати, тут немає.
    const context = details.tabId >= 0 ? (scanContexts.get(details.tabId) || {}) : {};
    sendURL(details.url, details.tabId, context);
  },
  {urls: ["<all_urls>"]}
);

// Вкладку закрили — контекст більше ні до чого. Без цього Map ріс би на
// кожне сканування аж до перезапуску браузера.
chrome.tabs.onRemoved.addListener(tabId => {
  scanContexts.delete(tabId);
  chrome.storage.session.remove("ctx:" + tabId).catch(() => {});
});

heartbeat();
