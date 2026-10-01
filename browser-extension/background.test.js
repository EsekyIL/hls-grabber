// Перевірка того, що фоновий скрипт реєструє на старті.
//
// Написана після справжньої поломки: блок із будильником помилково опинився
// ВСЕРЕДИНІ функції sendURL. Синтаксис лишався правильним, тож ані збірка,
// ані `node --check` нічого не помітили — а будильник створювався лише після
// перехоплення плейлиста. Без відкритої сторінки сайту панель через 75 секунд
// показувала «Firefox не підключений», а команда навічно зависала в черзі.
//
// Звідси й форма перевірки: не «чи розбирається файл», а «що він насправді
// робить, коли його завантажили».
//
// Запуск: node --test browser-extension/*.test.js
//
// Саме з маскою: `node --test <тека>` у цій версії Node намагається
// завантажити теку як модуль і падає ще до тестів.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadBackground() {
  const calls = [];
  const noop = async () => {};

  global.chrome = {
    alarms: {
      create: (name) => calls.push(`alarms.create:${name}`),
      onAlarm: {addListener: () => calls.push("alarms.onAlarm")},
    },
    runtime: {
      onMessage: {addListener: () => calls.push("runtime.onMessage")},
      getManifest: () => ({version: "test"}),
    },
    webRequest: {
      onBeforeRequest: {addListener: () => calls.push("webRequest.onBeforeRequest")},
    },
    tabs: {
      onRemoved: {addListener: () => calls.push("tabs.onRemoved")},
      get: async () => ({}), sendMessage: async () => ({}),
      create: async () => ({id: 1}), remove: noop,
    },
    storage: {
      local: {get: async () => ({enabled: true, port: 8787})},
      session: {get: async () => ({}), set: noop, remove: noop},
    },
    action: {setBadgeBackgroundColor: noop, setBadgeText: noop},
    scripting: {executeScript: noop},
  };
  global.fetch = async () => {
    calls.push("fetch");
    return {ok: true, json: async () => []};
  };

  const file = path.join(__dirname, "service-worker.js");
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(file, "utf8"));
  // Функції фонового скрипта живуть в області цієї функції — віддаємо ті,
  // які тести викликають напряму.
  // eslint-disable-next-line no-undef
  calls.api = {pollResolves};
  return calls;
}

test("фоновий скрипт реєструє все потрібне на старті", () => {
  const calls = loadBackground();

  // Будильник — єдине, що тримає міст живим, коли жодної сторінки сайту не
  // відкрито: він шле серцебиття й опитує чергу команд панелі.
  assert.ok(
    calls.includes("alarms.create:bridge-poll"),
    "будильник bridge-poll не створено — панель вважатиме міст відключеним, " +
      "а команди зависнуть у черзі",
  );
  assert.ok(calls.includes("alarms.onAlarm"), "немає слухача будильника");

  // Без цього не працює ані попап, ані обхід сторінки.
  assert.ok(calls.includes("runtime.onMessage"), "немає слухача повідомлень");

  // Запасний шлях захоплення: без нього губляться посилання на сайтах,
  // де немає власного API.
  assert.ok(
    calls.includes("webRequest.onBeforeRequest"),
    "немає перехоплення запитів",
  );
});

test("реєстрація не залежить від виклику інших функцій", () => {
  const calls = loadBackground();
  // Усе потрібне має статись саме на завантаженні. Якщо якась реєстрація
  // сховалась усередину функції, сюди вона не потрапить — рівно та поломка,
  // заради якої цей файл і написаний.
  const onLoad = calls.filter((c) => c.startsWith("alarms.") || c.startsWith("runtime.") || c.startsWith("webRequest."));
  assert.strictEqual(onLoad.length, 4, `на старті зареєстровано: ${onLoad.join(", ")}`);
});

test("свіжі посилання беруться в одній вкладці на сторінку", async () => {
  const {api} = loadBackground();
  // Скрипт сам опитує панель на старті. Даємо тим викликам дійти до кінця,
  // інакше вони заберуть підставлені нижче команди замість тесту.
  await new Promise(resolve => setImmediate(resolve));
  const page = "https://site.test/show.html";
  const created = [], removed = [], posted = [];
  let served = false;
  global.fetch = async (url, init) => {
    if (url.endsWith("/api/bridge/resolves") && !served) {
      served = true;
      return {ok: true, json: async () => [
        {id: "r1", url: page, translatorId: "56", season: "1", episode: "1"},
        {id: "r2", url: page, translatorId: "56", season: "1", episode: "2"},
      ]};
    }
    if (url.endsWith("/api/bridge/resolved")) posted.push(JSON.parse(init.body));
    return {ok: true, json: async () => []};
  };
  chrome.permissions = {contains: async () => true};
  chrome.tabs.query = async () => [];
  chrome.tabs.create = async ({url}) => { created.push(url); return {id: 7}; };
  chrome.tabs.remove = async id => { removed.push(id); };
  chrome.tabs.sendMessage = async (_tab, message) => {
    if (message.type === "get-catalog") return {supported: true};
    if (message.type === "resolve-episode") return {streams: [{quality: "720p", urls: [`fresh-${message.episode}`]}]};
    return {};
  };

  await api.pollResolves();

  assert.deepStrictEqual(created, [page], "на дві серії однієї сторінки — одна вкладка");
  assert.deepStrictEqual(removed, [7], "свою вкладку треба закрити");
  assert.deepStrictEqual(posted.map(p => [p.id, p.streams[0]?.urls[0]]), [["r1", "fresh-1"], ["r2", "fresh-2"]]);
});
