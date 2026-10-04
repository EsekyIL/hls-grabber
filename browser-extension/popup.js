const $ = selector => document.querySelector(selector);
let activeTabId = null;
let pollTimer = null;

// Стан сканування живе у ФОНІ, а не тут.
//
// Попап Firefox знищується, щойно втрачає фокус, а прохід триває хвилини.
// Раніше результат чекали через відповідь на start-scan — і не дочікувались
// ніколи: вікна вже не було. Тепер фон тримає стан, а попап при кожному
// відкритті питає його й підхоплює сканування, що вже йде.
async function scanState() {
  try {
    return await chrome.runtime.sendMessage({type: "get-scan-state"});
  } catch (_) {
    return null;
  }
}

// Доступ до сайтів у Firefox MV3 треба просити окремо: host_permissions при
// встановленні не видаються. Без нього content script не впроваджується, і
// панель не може відкрити сторінку сама.
//
// Просити можна ЛИШЕ у відповідь на клік — це вимога браузера, тож кнопка
// тут і потрібна: з фонового скрипта такий запит просто відхилять.
async function siteAccess() {
  try {
    return await chrome.permissions.contains({origins: ["<all_urls>"]});
  } catch (_) {
    return true;
  }
}

function setStatus(text, tone = "") {
  const node = $("#status");
  node.textContent = text;
  node.className = tone;
}

function showProgress(state) {
  const running = Boolean(state?.running);
  $("#progress").classList.toggle("on", running);
  $("#progressCount").textContent = state?.completed ?? 0;
  $("#scan").disabled = running;
  $("#cancel").disabled = !running;
  return running;
}

// Підсумок сканування.
//
// Досі тут стояло «перевірено N серій», і N рахував КРОКИ, а не здобуті
// лінки. Через це різниця між «61 епізод» і «59 посилань у панелі» була
// невидима: сканер бадьоро рапортував про 61, і де поділись два, не знав
// ніхто. Тепер пропущені перелічені поіменно — їх можна доклацати вручну.
function summary(result) {
  if (!result) return null;
  if (result.error) return {text: result.error, tone: "bad"};

  const done = result.completed || 0;
  const missed = result.missed || [];
  const seconds = Math.round((result.elapsedMs || 0) / 1000);
  // Повтори показуємо окремо: це не помилка, а ознака того, що сайт
  // спотикався й сканер його дочекався. Без цього числа виглядало б, ніби
  // прохід просто чомусь був повільний.
  const retries = result.retries || 0;
  const head = `Готово: ${done} посилань за ${seconds} с${retries ? `, повторів: ${retries}` : ""}.`;

  // Сліпий режим — це не «все добре»: сканер працював за годинником, і чи
  // приїхали лінки, він не знає. Мовчати про це означало б показувати
  // бадьоре число там, де насправді нічого не перевірено.
  if (result.blind) {
    return {tone: "warn", text: `${head} Сигнал захоплення не дійшов — працював за таймером. Онови сторінку й перевір, чи міст підключений.`};
  }
  if (!missed.length) {
    return {tone: "ok", text: result.cancelled ? `${head} Зупинено.` : head};
  }
  const list = missed.slice(0, 6).map(item => `${item.season}×${item.episode}`).join(", ");
  return {tone: "warn", text: `${head} Без посилання: ${missed.length} (${list}${missed.length > 6 ? "…" : ""}).`};
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const state = await scanState();
    if (showProgress(state)) return;
    clearInterval(pollTimer);
    const done = summary(state?.result);
    if (done) setStatus(done.text, done.tone);
  }, 700);
}

async function init() {
  $("#grant").classList.toggle("hidden", await siteAccess());

  const config = await chrome.storage.local.get({enabled: true, port: 8787});
  $("#enabled").checked = config.enabled;
  $("#enabledSwitch").classList.toggle("on", config.enabled);
  $("#port").value = config.port;

  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  activeTabId = tab?.id;

  // Стан читаємо ДО каталогу: сканування могло початись і триває, і тоді
  // важливіше показати його хід, ніж перемальовувати перелік озвучок.
  const state = await scanState();
  if (showProgress(state)) {
    setStatus("Сканування триває. Вікно можна закрити — воно не зупиниться.");
    startPolling();
  } else {
    const done = summary(state?.result);
    if (done) setStatus(done.text, done.tone);
  }

  if (activeTabId == null) return;
  try {
    const catalog = await chrome.tabs.sendMessage(activeTabId, {type: "get-catalog"});
    $("#title").textContent = catalog.title || tab.title || "Сторінка";
    if (!catalog.supported) {
      $("#voicesTitle").hidden = true;
      $("#scan").disabled = true;
      setStatus("На цій сторінці адаптер не знайшов серіал.");
      return;
    }
    $("#voicesTitle").textContent = `Озвучення (${catalog.translators.length})`;
    $("#voices").innerHTML = catalog.translators.map(item =>
      `<label class="voice"><input type="checkbox" value="${item.id}" ${item.active ? "checked" : ""}><span>${item.name}</span></label>`
    ).join("");
  } catch (_) {
    $("#voicesTitle").hidden = true;
    $("#scan").disabled = true;
    setStatus("Онови сторінку після перевстановлення розширення.", "warn");
  }
}

$("#grantBtn").addEventListener("click", async () => {
  try {
    const granted = await chrome.permissions.request({origins: ["<all_urls>"]});
    $("#grant").classList.toggle("hidden", granted);
    setStatus(
      granted
        ? "Доступ надано. Онови сторінку сайту, щоб скрипт впровадився."
        : "Доступ не надано — панель не зможе відкривати сторінки сама.",
      granted ? "ok" : "warn",
    );
  } catch (error) {
    setStatus(error.message, "bad");
  }
});

$("#enabledSwitch").addEventListener("click", event => {
  // Клік по самому <input> усередині обробляє браузер; ловимо лише клік по
  // обгортці, інакше стан перемкнувся б двічі й лишився тим самим.
  if (event.target.tagName === "INPUT") return;
  const box = $("#enabled");
  box.checked = !box.checked;
  $("#enabledSwitch").classList.toggle("on", box.checked);
});

$("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({enabled: $("#enabled").checked, port: Number($("#port").value)});
  setStatus("Збережено.", "ok");
  // Одразу даємо панелі знати, а не через 15 секунд. Якщо на цьому порту
  // панелі нема, фон сам знайде її на звичних і поправить число.
  chrome.runtime.sendMessage({type: "bridge-heartbeat"}).catch(() => {});
});

$("#scan").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll("#voices input:checked")].map(input => input.value);
  if (!ids.length) { setStatus("Вибери хоча б одне озвучення.", "warn"); return; }
  await chrome.storage.local.set({enabled: true, port: Number($("#port").value)});

  // Відповіді НЕ чекаємо: вона прийде за хвилини, а вікна на той час уже не
  // буде. Хід і підсумок забираємо з фону опитуванням.
  chrome.tabs.sendMessage(activeTabId, {type: "start-scan", translatorIds: ids}).catch(() => {});
  setStatus("Сканування запущено. Вікно можна закрити — воно не зупиниться.");
  showProgress({running: true, completed: 0});
  startPolling();
});

$("#cancel").addEventListener("click", async () => {
  if (activeTabId == null) return;
  await chrome.tabs.sendMessage(activeTabId, {type: "cancel-scan"}).catch(() => {});
  setStatus("Зупиняю після поточної серії…", "warn");
});

init();
