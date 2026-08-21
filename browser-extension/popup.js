const $ = selector => document.querySelector(selector);
let activeTabId = null;

async function init() {
  const config = await chrome.storage.local.get({enabled: true, port: 8788});
  $("#enabled").checked = config.enabled; $("#port").value = config.port;
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  activeTabId = tab?.id;
  if (activeTabId == null) return;
  try {
    const catalog = await chrome.tabs.sendMessage(activeTabId, {type: "get-catalog"});
    $("#title").textContent = catalog.title || tab.title || "Сторінка";
    if (!catalog.supported) { $("#status").textContent = "На цій сторінці адаптер не знайшов серіал."; return; }
    $("#voices").innerHTML = `<b>Озвучення (${catalog.translators.length})</b>` + catalog.translators.map(item => `<label class="voice"><input type="checkbox" value="${item.id}" ${item.active ? "checked" : ""}><span>${item.name}</span></label>`).join("");
  } catch (_) { $("#status").textContent = "Онови сторінку після перевстановлення розширення."; }
}

// Підсумок сканування.
//
// Досі тут стояло «перевірено N серій», і N рахував КРОКИ, а не здобуті
// лінки. Через це різниця між «61 епізод» і «59 посилань у панелі» була
// невидима: сканер бадьоро рапортував про 61, і де поділись два, не знав
// ніхто. Тепер пропущені перелічені поіменно — їх можна доклацати вручну.
function summary(result) {
  const done = result?.completed || 0;
  const missed = result?.missed || [];
  const seconds = Math.round((result?.elapsedMs || 0) / 1000);
  // Повтори показуємо окремо: це не помилка, а ознака того, що сайт
  // спотикався й сканер його дочекався. Без цього числа виглядало б, ніби
  // прохід просто чомусь був повільний.
  const retries = result?.retries || 0;
  const head = `Готово: ${done} посилань за ${seconds} с${retries ? `, повторів: ${retries}` : ""}.`;
  // Сліпий режим — це не «все добре»: сканер працював за годинником, і чи
  // приїхали лінки, він не знає. Мовчати про це означало б показувати
  // бадьоре число там, де насправді нічого не перевірено.
  if (result?.blind) {
    return `${head} Сигнал захоплення не дійшов — працював за таймером. Онови сторінку й перевір, чи міст підключений.`;
  }
  if (!missed.length) return result?.cancelled ? head + " Зупинено." : head;
  const list = missed.slice(0, 8).map(item => `${item.season}×${item.episode}`).join(", ");
  return `${head} Без посилання: ${missed.length} (${list}${missed.length > 8 ? "…" : ""}).`;
}

$("#save").addEventListener("click", async () => { await chrome.storage.local.set({enabled: $("#enabled").checked, port: Number($("#port").value)}); $("#status").textContent = "Налаштування збережено."; });
$("#scan").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll('#voices input:checked')].map(input => input.value);
  if (!ids.length) { $("#status").textContent = "Вибери хоча б одне озвучення."; return; }
  await chrome.storage.local.set({enabled: true, port: Number($("#port").value)});
  $("#status").textContent = "Сканування запущено. Не закривай вкладку з відео.";
  chrome.tabs.sendMessage(activeTabId, {type: "start-scan", translatorIds: ids}).then(result => { $("#status").textContent = result?.error || summary(result); }).catch(error => { $("#status").textContent = error.message; });
});
$("#cancel").addEventListener("click", async () => { if (activeTabId != null) await chrome.tabs.sendMessage(activeTabId, {type: "cancel-scan"}); $("#status").textContent = "Зупинка після поточної серії…"; });
init();
