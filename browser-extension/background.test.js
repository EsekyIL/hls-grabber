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
      local: {get: async () => ({enabled: true, port: 8788})},
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
