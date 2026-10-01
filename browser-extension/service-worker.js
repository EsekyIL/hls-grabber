// Міст між сторінкою і локальною панеллю: ловить плейлисти й віддає їх у
// /api/inbox, а сканеру повідомляє, що для поточного епізоду лінк уже є.

const sent = new Map();
const scanContexts = new Map();

// Плейлист не завжди має .m3u8 у шляху: частина плеєрів віддає його як
// /playlist?type=hls або /master?format=m3u8. Стара перевірка вимагала саме
// розширення й такі адреси не бачила зовсім.
const PLAYLIST_RE = /\.m3u8(?:[?#]|$)|[?&](?:type|format|ext)=m3u8|\/master(?:[?#]|$)/i;

async function settings() {
  return chrome.storage.local.get({enabled: true, port: 8787});
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

// Чи має розширення доступ до сайтів.
//
// У Firefox MV3 host_permissions НЕ видаються при встановленні — їх дає
// людина вручну. Без дозволу content script не впроваджується взагалі, і
// сторінка виглядає німою: завантажилась, адреса правильна, а на
// повідомлення не відповідає.
//
// Клік по кнопці розширення дає тимчасовий доступ до АКТИВНОЇ вкладки
// (activeTab) — тому ручне сканування з попапа працює навіть без дозволу, а
// фонова вкладка з панелі мовчить. Найпідступніше саме це: половина
// сценаріїв працює, і причина здається якою завгодно, тільки не дозволами.
async function hasSiteAccess() {
  try {
    return await chrome.permissions.contains({origins: ["<all_urls>"]});
  } catch (_) {
    // Немає самого API — вважаємо, що доступ є: краще спробувати й
    // отримати справжню помилку, ніж відмовити через власну недовіру.
    return true;
  }
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
  let injectError = "";

  while (Date.now() < deadline) {
    try {
      const catalog = await chrome.tabs.sendMessage(tabId, {type: "get-catalog"});
      if (catalog) return catalog;
      lastError = "порожня відповідь від сторінки";
    } catch (error) {
      lastError = error?.message || String(error);
    }

    // Пробуємо впровадити ОДРАЗУ, а не на половині шляху: якщо оголошення в
    // маніфесті не спрацювало, чекати ще двадцять секунд нема сенсу — воно
    // не спрацює й далі.
    if (!injected) {
      injected = true;
      try {
        await chrome.scripting.executeScript({
          target: {tabId},
          files: ["cdn-api.js", "content-script.js"],
        });
        injectError = "";
      } catch (error) {
        // Зберігаємо ОКРЕМО від lastError: та перезаписується на кожній
        // ітерації повідомленням «receiving end does not exist», і справжня
        // причина — відмова у впровадженні — губилась під нею. Саме вона
        // тут і цінна: у ній Firefox пише, чого бракує.
        injectError = error?.message || String(error);
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
  const why = injectError ? ` Впровадження скрипта: ${injectError}.` : "";
  throw new Error(
    `сторінка не відповіла за ${Math.round(timeoutMs / 1000)} с.${where}${why} ${lastError}`.trim(),
  );
}

async function runCommand(command, port) {
  // Перевіряємо ДО відкриття вкладки: інакше людина дивиться сорок секунд
  // на порожнє очікування, щоб отримати «сторінка не відповіла» — при тому
  // що сторінка ні до чого.
  if (!(await hasSiteAccess())) {
    await report(port, {
      id: command.id, state: "failed",
      error: "Розширенню не надано доступ до сайтів. Firefox → Додатки → " +
        "HLS Grabber Bridge → Дозволи → «Доступ до даних для всіх сайтів». " +
        "Або натисни «Дозволити доступ» у попапі розширення.",
    });
    return;
  }

  // Спершу шукаємо вже відкриту вкладку з цією адресою.
  //
  // Не заради економії: у вкладці, яку відкрила людина, content script
  // працює напевно — саме там проходить ручне сканування з попапа. Вкладка ж,
  // створена самим розширенням, у Firefox інколи лишається без скрипта, і
  // ззовні це виглядає як німа сторінка.
  //
  // Чужу вкладку в кінці НЕ закриваємо: людина її відкрила, їй і вирішувати.
  let tab = null;
  let borrowed = false;
  try {
    const [found] = await chrome.tabs.query({url: command.url.split("#")[0]});
    if (found) { tab = found; borrowed = true; }
  } catch (_) {}
  if (!tab) {
    // Вкладка фонова: сенс усього задуму в тому, щоб не сидіти й не
    // дивитись. Працює це завдяки stay-awake.js для клікалки; обхід через
    // API сайту видимості не потребує взагалі.
    tab = await chrome.tabs.create({url: command.url, active: false});
  }
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
    // Закриваємо лише те, що відкрили самі: інакше після десятка серіалів у
    // Firefox висіла б купа сторінок, про які ніхто не просив, — а чужу
    // вкладку зачинити було б просто грубо.
    if (!borrowed) {
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

// ── Свіжі посилання для черги ───────────────────────────────────────────
//
// Підписані адреси сайту протухають, поки серія чекає в черзі. Панель тоді
// просить свіжу, і взяти її можна лише зі сторінки серіалу — з її куками.
//
// Окремий канал і окремий прапорець зайнятості: обхід серіалу триває
// хвилинами, і якби оновлення стояли за ним у тій самій черзі, панель
// давно перестала б чекати.

let resolveBusy = false;

async function reportResolved(port, payload) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/bridge/resolved`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });
  } catch (_) {}
}

// Обробляє запити однієї сторінки в одній вкладці: коли протухла вся
// черга, відкривати сайт заново на кожну серію було б і довго, і грубо.
async function resolveForPage(url, commands, port) {
  const fail = async error => {
    for (const command of commands) await reportResolved(port, {id: command.id, error});
  };
  if (!(await hasSiteAccess())) {
    await fail("розширенню не надано доступ до сайтів");
    return;
  }

  let tab = null;
  let borrowed = false;
  try {
    const [found] = await chrome.tabs.query({url: url.split("#")[0]});
    if (found) { tab = found; borrowed = true; }
  } catch (_) {}
  try {
    if (!tab) tab = await chrome.tabs.create({url, active: false});
    await waitForContentScript(tab.id);
    for (const command of commands) {
      let answer;
      try {
        answer = await chrome.tabs.sendMessage(tab.id, {type: "resolve-episode", ...command});
      } catch (error) {
        answer = {error: error?.message || String(error)};
      }
      await reportResolved(port, {id: command.id, streams: answer?.streams || [], error: answer?.error || ""});
    }
  } catch (error) {
    await fail(error?.message || String(error));
  } finally {
    if (tab && !borrowed) {
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

async function pollResolves() {
  if (resolveBusy) return;
  const {enabled, port} = await settings();
  if (!enabled) return;

  let commands = [];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/bridge/resolves`);
    if (!response.ok) return;
    commands = await response.json();
  } catch (_) { return; }
  if (!commands.length) return;

  resolveBusy = true;
  try {
    const byPage = new Map();
    for (const command of commands) {
      if (!byPage.has(command.url)) byPage.set(command.url, []);
      byPage.get(command.url).push(command);
    }
    for (const [url, group] of byPage) await resolveForPage(url, group, port);
  } finally {
    resolveBusy = false;
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

// Будильник — єдине, що тримає міст живим, коли жодної сторінки сайту не
// відкрито. Він і серцебиття шле, і чергу команд опитує.
//
// Цей блок був помилково вставлений УСЕРЕДИНУ sendURL: заміна пішла на
// перший рядок «heartbeat();» у файлі, а ним виявився await усередині
// відправки посилання. Синтаксично все лишалось правильним, тож ані
// збірка, ані перевірка синтаксису нічого не помітили — а насправді
// будильник створювався лише після перехоплення плейлиста. Без відкритої
// сторінки панель через 75 секунд бачила «Firefox не підключений», а
// команда навічно лишалась у черзі.
//
// Alarms, а не setInterval: таймери фонової сторінки вмирають разом із її
// вивантаженням, а будильник її ж і будить.
chrome.alarms.create("bridge-poll", {periodInMinutes: 0.25});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== "bridge-poll") return;
  heartbeat();
  pollCommands();
  pollResolves();
});

heartbeat();
pollCommands();
pollResolves();
