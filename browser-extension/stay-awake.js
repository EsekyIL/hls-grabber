// Переконує сторінку, що вкладка видима й у фокусі.
//
// Заради цього все й робиться: без цього сканування вимагало сидіти на
// вкладці й дивитись, як воно клацає. Щойно вкладка йшла у фон, плеєр
// переставав вантажити плейлист — бо більшість плеєрів перевіряють
// document.hidden або чекають на requestAnimationFrame, а браузер у
// прихованій вкладці не дає ні першого, ні другого. Сканер клацав епізоди
// далі, кожен мовчав, і прохід перетворювався на низку таймаутів.
//
// Виконується в контексті САМОЇ СТОРІНКИ, а не розширення: content script
// живе в ізольованому світі, і його document — не той, який бачать скрипти
// сайту. Тому файл підключається тегом <script> і лежить у
// web_accessible_resources.
//
// Діє лише під час сканування: content script прибирає тег після проходу.
// Постійна підміна видимості ламала б сайтам паузу відео при переході на
// іншу вкладку — тобто нормальну поведінку, якої від них чекають.
(() => {
  const KEY = "__hlsGrabberStayAwake";
  if (window[KEY]) return;

  const restore = [];

  const define = (target, prop, value) => {
    const original = Object.getOwnPropertyDescriptor(target, prop);
    try {
      Object.defineProperty(target, prop, {configurable: true, get: () => value});
      restore.push(() => {
        if (original) Object.defineProperty(target, prop, original);
        else delete target[prop];
      });
    } catch (_) {
      // Деякі сторінки вже перевизначили ці властивості як незмінні.
      // Це не привід зупиняти решту: плеєр міг дивитись і на щось одне.
    }
  };

  define(Document.prototype, "hidden", false);
  define(Document.prototype, "visibilityState", "visible");
  define(Document.prototype, "webkitHidden", false);
  define(Document.prototype, "webkitVisibilityState", "visible");

  const hadFocus = document.hasFocus;
  document.hasFocus = () => true;
  restore.push(() => { document.hasFocus = hadFocus; });

  // Події гасимо на етапі перехоплення, до слухачів сторінки: самої лише
  // підміни властивостей замало, бо плеєр міг зупинитись саме на події, а
  // потім уже питати visibilityState.
  const swallow = event => { event.stopImmediatePropagation(); };
  const events = ["visibilitychange", "webkitvisibilitychange", "blur", "pagehide"];
  for (const name of events) {
    window.addEventListener(name, swallow, true);
    document.addEventListener(name, swallow, true);
    restore.push(() => {
      window.removeEventListener(name, swallow, true);
      document.removeEventListener(name, swallow, true);
    });
  }

  // requestAnimationFrame у прихованій вкладці не викликається взагалі —
  // жодна підміна видимості цього не змінює, бо кадрів там просто немає.
  // Тому підмінюємо його таймером: 16 мс — той самий крок, що й у 60 Гц.
  const rAF = window.requestAnimationFrame;
  const cAF = window.cancelAnimationFrame;
  window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = id => window.clearTimeout(id);
  restore.push(() => {
    window.requestAnimationFrame = rAF;
    window.cancelAnimationFrame = cAF;
  });

  window[KEY] = () => {
    for (const undo of restore.reverse()) {
      try { undo(); } catch (_) {}
    }
    delete window[KEY];
  };
})();
