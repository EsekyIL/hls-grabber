const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let mode = "movie";
let source = "direct";
let paused = false;
let config = null;
let inboxSignature = "";
let inboxItems = [];
let pendingPackage = null;
let diagnosticsLoaded = false;
let currentBridge = null;

function toast(message, type = "") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.className = "toast", 2800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {headers: {"Content-Type": "application/json"}, ...options});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setMode(next) {
  mode = next;
  $$('[data-mode]').forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
  $$(".series-only").forEach(node => node.classList.toggle("hidden", mode !== "series"));
  $(".movie-url-field").classList.toggle("hidden", mode === "series");
  $("#title-label").textContent = mode === "series" ? "Назва серіалу" : "Назва фільму";
  setSource(source);
}

function setSource(next) {
  source = next;
  $$('[data-source]').forEach(button => button.classList.toggle("active", button.dataset.source === source));
  const series = mode === "series";
  $(".series-links-field").classList.toggle("hidden", !series || source !== "direct");
  $(".list-field").classList.toggle("hidden", !series || source !== "list");
}

function setActive(active) {
  $("#start-button").disabled = active;
  if (active) {
    $("#empty-state").classList.add("hidden");
    $("#progress-view").classList.remove("hidden");
    $("#state").textContent = paused ? "Пауза" : "Активне";
  } else {
    $("#state").textContent = "Готово";
  }
}

function renderProgress(stats) {
  if (!stats || !stats.status) return;
  const active = !["finished", "error", "cancelled"].includes(stats.status);
  setActive(active);
  renderQueue(stats, active);
  $("#progress-title").textContent = stats.title || "Завантаження";
  $("#progress-message").textContent = stats.message || (active ? "Завантаження…" : "Готово");
  const percent = Math.max(0, Math.min(100, Number(stats.percent || 0)));
  $("#progress-number").textContent = `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
  $("#progress-bar").style.width = `${percent}%`;
  $("#speed").textContent = stats.speedMB ? `${stats.speedMB.toFixed(1)} MB/s` : "—";
  $("#fragments").textContent = stats.fragmentCount ? `${stats.fragmentIndex}/${stats.fragmentCount}` : "—";
  $("#eta").textContent = stats.etaSeconds ? `${stats.etaSeconds} сек` : "—";
  if (stats.status === "finished") { toast(stats.message || "Завантаження завершено"); saveHistory(stats); }
  if (stats.status === "error") { toast(stats.message || "Помилка завантаження", "error"); saveHistory(stats); }
}

function renderQueue(stats, active) {
  $("#queue-empty").classList.toggle("hidden", active);
  $("#queue-current").classList.toggle("hidden", !active);
  $("#queue-state").textContent = active ? "Активне" : "Готово";
  if (!active) return;
  const percent = Math.max(0, Math.min(100, Number(stats.percent || 0)));
  $("#queue-title").textContent = stats.title || "Завантаження";
  $("#queue-message").textContent = stats.message || "Завантаження…";
  $("#queue-percent").textContent = `${percent.toFixed(0)}%`;
  $("#queue-bar").style.width = `${percent}%`;
}

function historyItems() { try { return JSON.parse(localStorage.getItem("hls-history") || "[]"); } catch (_) { return []; } }
function saveHistory(stats) {
  const items = historyItems();
  const signature = `${stats.status}:${stats.title}:${stats.message}`;
  if (items[0]?.signature === signature) return;
  items.unshift({signature, title: stats.title || "Завантаження", status: stats.status, message: stats.message || "", time: new Date().toISOString()});
  localStorage.setItem("hls-history", JSON.stringify(items.slice(0, 100)));
  renderHistory();
}
function renderHistory() {
  const items = historyItems();
  $("#history-empty").classList.toggle("hidden", items.length > 0);
  $("#history-list").innerHTML = items.map(item => `<div class="history-row"><strong>${escapeHTML(item.title)}</strong><span class="history-status ${item.status === "error" ? "error" : ""}">${item.status === "error" ? "Помилка" : "Завершено"}</span><time>${new Date(item.time).toLocaleString("uk-UA")}</time></div>`).join("");
}

async function syncQueue() {
  try {
    const jobs = await api("/api/queue");
    const activeJobs = jobs.filter(job => job.state === "running" || job.state === "pending");
    const pending = jobs.filter(job => job.state === "pending").length;
    const running = jobs.find(job => job.state === "running");
    $("#queue-empty").classList.toggle("hidden", activeJobs.length > 0);
    $("#queue-summary").textContent = running ? `Завантаження · ще ${pending} у черзі` : pending ? `Очікує: ${pending}` : "Черга готова";
    $("#queue-jobs").innerHTML = activeJobs.map(job => { const code = job.mode === "series" ? `S${String(job.season).padStart(2,"0")}E${String(job.episode).padStart(2,"0")}` : "MOVIE"; const actions = job.state === "pending" ? `<button data-job-action="up" aria-label="Вище">↑</button><button data-job-action="down" aria-label="Нижче">↓</button><button data-job-action="remove" aria-label="Видалити">×</button>` : `<button data-job-action="cancel">Стоп</button>`; const label = job.voice ? `${job.title} · ${job.voice}` : job.title; return `<div class="queue-job" data-job-id="${job.id}"><span class="queue-job__episode">${code}</span><span class="queue-job__title">${escapeHTML(label)}</span><span class="queue-job__state">${job.state === "running" ? `${Math.round(job.percent || 0)}%` : "Очікує"}</span><span class="queue-job__actions">${actions}</span></div>`; }).join("");
    const completed = jobs.filter(job => job.state === "finished" || job.state === "error").sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    $("#history-empty").classList.toggle("hidden", completed.length > 0);
    $("#history-list").innerHTML = completed.map(job => `<div class="history-row" data-job-id="${job.id}"><strong>${escapeHTML(job.title)}${job.voice ? ` · ${escapeHTML(job.voice)}` : ""}${job.episode ? ` · S${String(job.season).padStart(2,"0")}E${String(job.episode).padStart(2,"0")}` : ""}</strong><span class="history-status ${job.state === "error" ? "error" : ""}">${job.state === "error" ? "Помилка" : "Завершено"}</span><time>${new Date(job.updatedAt).toLocaleString("uk-UA")}</time>${job.state === "error" ? '<button class="secondary" data-job-action="retry">Повторити</button>' : ''}</div>`).join("");
  } catch (_) {}
}

function readPath(object, path) { return path.split(".").reduce((value, key) => value?.[key], object); }
function writePath(object, path, value) { const keys = path.split("."); const last = keys.pop(); const parent = keys.reduce((node, key) => node[key] ||= {}, object); parent[last] = value; }

async function loadConfig() {
  config = await api("/api/config");
  $$('[data-config]').forEach(input => input.value = readPath(config, input.dataset.config) ?? "");
}

async function syncInbox({ notify = true } = {}) {
  try {
    const response = await api("/api/inbox");
    const items = Array.isArray(response) ? response : [];
    inboxItems = items;
    const signature = items.map(item => inboxItemKey(item)).join("\n");
    if (!signature) {
      inboxSignature = "";
      renderCapturePicker();
      $("#capture-status").textContent = currentBridge?.connected ? `Firefox Bridge v${currentBridge.version || currentBridge.bundledVersion}` : "Підключи розширення на сторінці Діагностика";
      return;
    }
    const voice = items.find(item => item.voice)?.voice || "";
    $("#capture-status").textContent = `Перехоплено: ${items.length}${voice ? ` · ${voice}` : ""}`;
    if (signature === inboxSignature) return;
    inboxSignature = signature;
    renderQualityPick();
    renderCapturePicker(true);
    const pageTitle = items.find(item => item.title)?.title || "";
    if (pageTitle && !$("#title").value.trim()) {
      $("#title").value = cleanPageTitle(pageTitle);
    }
    const season = items.find(item => item.season)?.season?.match(/\d+/)?.[0];
    const episode = items.find(item => item.episode)?.episode?.match(/\d+/)?.[0];
    if (season) $("#season").value = season;
    if (episode) $("#episode").value = episode;
    if (items.length === 1 && mode === "movie") {
      $("#url").value = items[0].url;
    } else {
      setMode("series");
      setSource("direct");
      $("#urls").value = items.map(item => item.url).join("\n");
    }
    if (notify) toast(`Отримано .m3u8: ${items.length}`);
  } catch (_) {
    $("#capture-status").textContent = "Перехоплювач не підключений";
  }
}

// ── Розбір адреси та автоматичний обхід ─────────────────────────────────
//
// Панель не ходить на сайт сама — вона кладе команду, а забирає її
// розширення (див. bridgecmd.go). Тому тут лише постановка задачі й
// опитування стану: жодного очікування на відповідь, яке пережило б
// закриту вкладку.

let probeTimer = null;
let probeURL = "";

function stopProbePolling() { clearInterval(probeTimer); probeTimer = null; }

function renderProbe(session) {
  const body = $("#probe-body");
  const state = session?.state || "";
  const running = state === "queued" || state === "running";

  $("#probe-cancel").classList.toggle("hidden", !running);
  $("#probe-start").disabled = running;
  $("#probe-scan").disabled = running || !$$("#probe-voices input:checked").length;

  if (session?.error) {
    $("#probe-state").textContent = session.error;
    return;
  }
  $("#probe-state").textContent = {
    queued: "Чекаю на розширення…",
    running: "Працюю…",
    ready: "Готово",
    done: "Готово"
  }[state] || "";

  if (session?.title) $("#probe-title").textContent = session.title;

  const voices = session?.translators || [];
  if (voices.length) {
    body.classList.remove("hidden");
    // Перемальовуємо лише коли набір змінився: інакше кожне опитування
    // скидало б галочки, які людина щойно поставила.
    const signature = voices.map(v => v.id).join(",");
    if ($("#probe-voices").dataset.signature !== signature) {
      $("#probe-voices").dataset.signature = signature;
      $("#probe-voices").innerHTML = voices.map(v =>
        `<label class="voice-item"><input type="checkbox" value="${escapeHTML(v.id)}"><span>${escapeHTML(v.name)}</span></label>`
      ).join("");
      $$("#probe-voices input").forEach(input => input.addEventListener("change", () => {
        input.closest(".voice-item").classList.toggle("active", input.checked);
        $("#probe-scan").disabled = !$$("#probe-voices input:checked").length;
      }));
    }
  }

  const found = session?.completed || 0;
  const missed = session?.missed || 0;
  $("#probe-progress").textContent = found || missed
    ? `Знайдено: ${found}${missed ? ` · без посилання: ${missed}` : ""}`
    : "";

  if (!running) {
    stopProbePolling();
    // Знайдене лягає в ту саму скриньку, що й ручне перехоплення, тож
    // підбірку оновлюємо звичайним шляхом.
    syncInbox({notify: false});
  }
}

function startProbePolling() {
  stopProbePolling();
  probeTimer = setInterval(async () => {
    try { renderProbe(await api("/api/bridge/session")); }
    catch (_) { stopProbePolling(); }
  }, 1500);
}

$("#probe-start").addEventListener("click", async () => {
  const url = $("#probe-url").value.trim();
  if (!url) return toast("Встав адресу сторінки серіалу", "error");
  probeURL = url;
  try {
    $("#probe-voices").dataset.signature = "";
    renderProbe(await api("/api/bridge/probe", {method: "POST", body: JSON.stringify({url})}));
    $("#probe-body").classList.remove("hidden");
    startProbePolling();
  } catch (error) { toast(error.message, "error"); }
});

$("#probe-scan").addEventListener("click", async () => {
  const voices = $$("#probe-voices input:checked").map(input => input.value);
  if (!voices.length) return toast("Вибери хоча б одну озвучку", "error");
  try {
    renderProbe(await api("/api/bridge/scan", {method: "POST", body: JSON.stringify({url: probeURL, voices})}));
    startProbePolling();
  } catch (error) { toast(error.message, "error"); }
});

$("#probe-cancel").addEventListener("click", () => {
  stopProbePolling();
  $("#probe-state").textContent = "Зупинено з панелі; розширення завершить поточний епізод.";
  $("#probe-start").disabled = false;
});

// ── Вибір якості ────────────────────────────────────────────────────────
//
// Якості приходять разом з епізодом: обхід через API сайту віддає весь набір
// одразу. Вибір один на всі серії — саме так це працює й у плеєрі, і саме
// цього чекають від «скачати в 1080».

let chosenQuality = "";

// Спільні для ВСІХ вибраних епізодів. Показувати якість, яка є лише в
// половини, означало б тихо підсунути решті іншу.
function availableQualities() {
  const lists = inboxItems.map(item => (item.streams || []).map(s => s.quality)).filter(list => list.length);
  if (!lists.length) return [];
  return lists.reduce((common, list) => common.filter(q => list.includes(q)));
}

function urlForItem(item) {
  if (chosenQuality && Array.isArray(item.streams)) {
    const found = item.streams.find(s => s.quality === chosenQuality);
    if (found?.urls?.length) return found.urls[0];
  }
  return item.url;
}

function renderQualityPick() {
  const qualities = availableQualities();
  const wrap = $("#quality-pick");
  wrap.classList.toggle("hidden", qualities.length < 2);
  if (qualities.length < 2) { chosenQuality = ""; return; }
  const select = $("#quality-select");
  const signature = qualities.join(",");
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;
  if (!qualities.includes(chosenQuality)) chosenQuality = qualities[qualities.length - 1];
  select.innerHTML = qualities.map(q =>
    `<option value="${escapeHTML(q)}" ${q === chosenQuality ? "selected" : ""}>${escapeHTML(q)}</option>`
  ).join("");
}

$("#quality-select").addEventListener("change", event => {
  chosenQuality = event.target.value;
  // Текстове поле з посиланнями теж має оновитись: воно і є те, що піде в
  // завантаження, коли підбірку не використовують.
  if (inboxItems.length && mode === "series") {
    $("#urls").value = inboxItems.map(urlForItem).join("\n");
  }
  toast(`Якість: ${chosenQuality}`);
});

function selectedInboxURLs() {
  return selectedInboxItems().map(urlForItem);
}

function inboxItemKey(item) {
  return [item.url, item.voice, item.season, item.episode].join("\u001f");
}

function selectedInboxItems() {
  return $$('#capture-groups input:checked').map(input => inboxItems[Number(input.dataset.index)]).filter(Boolean);
}

function renderCapturePicker(selectNew = false) {
  const picker = $("#capture-picker");
  picker.classList.toggle("hidden", inboxItems.length === 0);
  const groups = $("#capture-groups");
  if (!inboxItems.length) { groups.textContent = ""; return; }
  const previous = new Set(selectedInboxItems().map(inboxItemKey));
  const byVoice = new Map();
  inboxItems.forEach((item, inboxIndex) => {
    item.__inboxIndex = inboxIndex;
    const key = item.voice || "Озвучення не визначено";
    if (!byVoice.has(key)) byVoice.set(key, []);
    byVoice.get(key).push(item);
  });
  groups.textContent = "";
  for (const [voice, items] of byVoice) {
    const group = document.createElement("div"); group.className = "capture-group";
    group.innerHTML = `<div class="capture-group__title"><b>${escapeHTML(voice)}</b><span>${items.length}</span></div>`;
    const bySeason = new Map();
    items.forEach(item => { const key = item.season || "?"; if (!bySeason.has(key)) bySeason.set(key, []); bySeason.get(key).push(item); });
    for (const [season, seasonItems] of bySeason) {
      const seasonGroup = document.createElement("div"); seasonGroup.className = "season-group";
      seasonGroup.innerHTML = `<span class="season-group__title">Сезон ${escapeHTML(season)}</span><div class="episode-grid"></div>`;
      const grid = seasonGroup.querySelector(".episode-grid");
      seasonItems.sort((a, b) => Number(a.episode || 0) - Number(b.episode || 0)).forEach((item, index) => {
        const chip = document.createElement("label"); chip.className = "capture-item"; chip.title = `${item.title || "HLS stream"}\n${item.url}`;
        const checked = selectNew || previous.has(inboxItemKey(item));
        chip.innerHTML = `<input type="checkbox" data-index="${item.__inboxIndex}" ${checked ? "checked" : ""}><span class="capture-item__episode">${escapeHTML(item.episode ? `E${item.episode.match(/\d+/)?.[0] || item.episode}` : `#${index + 1}`)}</span>`;
        grid.appendChild(chip);
      });
      group.appendChild(seasonGroup);
    }
    groups.appendChild(group);
  }
  groups.querySelectorAll("input").forEach(input => input.addEventListener("change", updateSelectionSummary));
  updateSelectionSummary();
}

function updateSelectionSummary() { $("#selection-summary").textContent = `Вибрано: ${selectedInboxItems().length} із ${inboxItems.length}`; }
function escapeHTML(value) { const node = document.createElement("span"); node.textContent = value || ""; return node.innerHTML; }

function cleanPageTitle(title) {
  return title
    .replace(/\s*[|—–-]\s*(дивитися|смотреть|онлайн|online).*$/i, "")
    .replace(/\s*[|—–]\s*[^|—–]{1,40}$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safePathPart(value) {
  return String(value || "").replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function diagnosticRow(status, title, message, value = "") {
  return `<div class="diagnostic-row"><i class="diagnostic-dot ${status}"></i><div><strong>${escapeHTML(title)}</strong><small>${escapeHTML(message)}</small></div><span>${escapeHTML(value)}</span></div>`;
}

async function loadDiagnostics(force = false) {
  if (diagnosticsLoaded && !force) return;
  const button = $("#refresh-diagnostics");
  button.disabled = true; button.textContent = "Перевіряю…";
  try {
    const data = await api("/api/diagnostics");
    diagnosticsLoaded = true;
    renderDiagnostics(data);
  } catch (error) {
    $("#health-orb").className = "health-orb error";
    $("#health-title").textContent = "Перевірка не вдалася";
    $("#health-message").textContent = error.message;
    toast(error.message, "error");
  } finally {
    button.disabled = false; button.textContent = "Перевірити знову";
  }
}

function renderDiagnostics(data) {
  const statuses = [...data.tools.map(item => item.status), ...data.folders.map(item => item.status), data.disk.status, data.bridge.status];
  const overall = statuses.includes("error") ? "error" : statuses.includes("warning") ? "warning" : "ok";
  $("#health-orb").className = `health-orb ${overall}`;
  $("#health-title").textContent = overall === "ok" ? "Усе готово до завантажень" : overall === "warning" ? "Є рекомендації" : "Потрібна увага";
  $("#health-message").textContent = overall === "ok" ? "Інструменти, з’єднання та сховище працюють нормально." : "Відкрий картки нижче — проблемні місця вже позначені.";
  $("#diagnostic-time").textContent = new Date(data.checkedAt).toLocaleString("uk-UA");
  $("#managed-tools-path").textContent = data.toolsDir;
  renderBridgeStatus(data.bridge);

  $("#diagnostic-tools").innerHTML = data.tools.map(tool => {
    const current = tool.version || "Не встановлено";
    const latest = tool.latest || "Не вдалося перевірити";
    let action = tool.managed ? (tool.updateAvailable ? "Оновити" : "Перевстановити") : "Встановити керовану копію";
    if (tool.status === "error") action = "Встановити";
    const stateLabel = tool.status === "ok" ? "Готово" : tool.status === "warning" ? "Оновлення" : "Проблема";
    return `<section class="panel diagnostic-card"><div class="diagnostic-card__top"><div class="tool-name"><span class="tool-icon">${tool.id === "yt-dlp" ? "Y" : "F"}</span><div><h2>${escapeHTML(tool.name)}</h2><small>${tool.managed ? "Керується Grabber" : "Зовнішня копія"}</small></div></div><span class="status-pill ${tool.status}">${stateLabel}</span></div><div class="tool-versions"><div><span>Встановлено</span><strong>${escapeHTML(current)}</strong></div><div><span>Актуальна</span><strong>${escapeHTML(latest)}</strong></div></div><span class="tool-path">${escapeHTML(tool.path || data.toolsDir)}</span><div class="tool-actions"><p>${escapeHTML(tool.message)}</p><button class="${tool.updateAvailable || tool.status === "error" || !tool.managed ? "primary" : "secondary"}" data-update-tool="${tool.id}" ${tool.canInstall ? "" : "disabled"}>${action}</button></div></section>`;
  }).join("");

  const bridgeSeen = data.bridge.lastSeen && !data.bridge.lastSeen.startsWith("0001-");
  $("#diagnostic-connections").innerHTML = diagnosticRow("ok", "Локальний сервер", "Панель відповідає", "Активний") + diagnosticRow(data.online ? "ok" : "warning", "Перевірка оновлень", data.online ? "Є доступ до серверів оновлень" : "Немає відповіді від серверів оновлень", data.online ? "Онлайн" : "Офлайн") + diagnosticRow(data.bridge.status, "Firefox-перехоплювач", data.bridge.message, bridgeSeen ? new Date(data.bridge.lastSeen).toLocaleTimeString("uk-UA") : "Не бачу");
  const folderRows = data.folders.map(folder => diagnosticRow(folder.status, folder.name, folder.message, folder.writable ? "Запис доступний" : "Перевірити")).join("");
  const diskValue = data.disk.totalBytes ? `${formatBytes(data.disk.freeBytes)} вільно` : "—";
  $("#diagnostic-storage").innerHTML = folderRows + diagnosticRow(data.disk.status, "Диск", data.disk.path || data.disk.message, diskValue);
}

function renderBridgeStatus(bridge) {
  currentBridge = bridge;
  const connected = Boolean(bridge.connected);
  const outdated = Boolean(bridge.updateAvailable);
  const card = $("#bridge-setup-card");
  card.classList.toggle("connected", connected && !outdated);
  card.classList.toggle("outdated", outdated);
  $("#bridge-setup-title").textContent = outdated ? "Онови розширення Firefox" : connected ? "Firefox підключений" : "Підключення Firefox";
  $("#bridge-setup-message").textContent = bridge.message;
  $("#bridge-manifest-path").textContent = bridge.manifestPath || "Файли ще не підготовлені";
  const pill = $("#bridge-version-pill");
  pill.className = `status-pill ${outdated || !connected ? "warning" : ""}`;
  pill.textContent = connected ? `v${bridge.version || "?"}${outdated ? ` → v${bridge.bundledVersion}` : ""}` : `Доступна v${bridge.bundledVersion}`;
  $("#install-extension").textContent = outdated ? "Оновити розширення" : connected ? "Перезавантажити розширення" : "Підключити Firefox";

  const captureBar = $("#capture-bar");
  captureBar.classList.toggle("disconnected", !connected);
  $("#capture-title").textContent = connected ? "Автоперехоплення активне" : "Firefox не підключений";
  $("#setup-bridge").classList.toggle("hidden", connected);
  if (!inboxItems.length) $("#capture-status").textContent = connected ? `Firefox Bridge v${bridge.version || bridge.bundledVersion}` : "Підключи розширення на сторінці Діагностика";
}

async function syncBridge() {
  try { renderBridgeStatus(await api("/api/bridge/status")); } catch (_) {}
}

async function prepareExtension() {
  const result = await api("/api/extension/prepare", {method: "POST"});
  currentBridge = {...(currentBridge || {}), prepared: true, manifestPath: result.manifestPath, bundledVersion: result.version};
  $("#bridge-manifest-path").textContent = result.manifestPath;
  return result.manifestPath;
}

async function copyExtensionPath() {
  const path = currentBridge?.manifestPath || await prepareExtension();
  try { await navigator.clipboard.writeText(path); toast("Шлях до manifest.json скопійовано"); }
  catch (_) { toast(path); }
}

$("#install-extension").addEventListener("click", async () => {
  const button = $("#install-extension");
  button.disabled = true; button.textContent = "Готую Firefox…";
  try {
    const result = await api("/api/extension/setup", {method: "POST"});
    currentBridge = {...(currentBridge || {}), prepared: true, manifestPath: result.manifestPath, bundledVersion: result.version};
    try { await navigator.clipboard.writeText(result.manifestPath); } catch (_) {}
    $("#bridge-manifest-path").textContent = result.manifestPath;
    toast("У Firefox натисни Load Temporary Add-on і вибери manifest.json");
    setTimeout(syncBridge, 3000);
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = currentBridge?.connected ? "Перезавантажити розширення" : "Підключити Firefox"; }
});

$("#copy-extension-path").addEventListener("click", () => copyExtensionPath().catch(error => toast(error.message, "error")));
$("#setup-bridge").addEventListener("click", () => {
  document.querySelector('[data-page="diagnostics"]').click();
  loadDiagnostics(true);
});

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-update-tool]");
  if (!button) return;
  const tool = button.dataset.updateTool;
  button.disabled = true; button.textContent = tool === "ffmpeg" ? "Завантажую FFmpeg…" : "Оновлюю yt-dlp…";
  try {
    await api("/api/diagnostics/update", {method: "POST", body: JSON.stringify({tool})});
    toast(`${tool === "ffmpeg" ? "FFmpeg" : "yt-dlp"} готовий`);
    diagnosticsLoaded = false;
    await loadDiagnostics(true);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false; button.textContent = "Спробувати знову";
  }
});

$("#refresh-diagnostics").addEventListener("click", () => loadDiagnostics(true));

$$('[data-page]').forEach(button => button.addEventListener("click", () => {
  $$('[data-page]').forEach(item => item.classList.toggle("active", item === button));
  $$(".page").forEach(page => page.classList.remove("active"));
  $(`#${button.dataset.page}-page`).classList.add("active");
  if (button.dataset.page === "diagnostics") loadDiagnostics();
}));
$$('[data-mode]').forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
$$('[data-source]').forEach(button => button.addEventListener("click", () => setSource(button.dataset.source)));

$("#download-form").addEventListener("submit", async event => {
  event.preventDefault();
  const capturedItems = selectedInboxItems();
  const captured = capturedItems.map(urlForItem);
  const urls = captured.length ? captured : $("#urls").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const structuredItems = mode === "series" ? capturedItems.map(item => ({url: urlForItem(item), voice: item.voice || "", season: item.season?.match(/\d+/)?.[0] || $("#season").value, episode: Number(item.episode?.match(/\d+/)?.[0] || 0)})).filter(item => item.episode > 0) : [];
  const request = {mode, source, title: $("#title").value.trim(), outputDir: $("#output").value.trim(), season: $("#season").value, startEpisode: $("#episode").value, url: mode === "movie" ? (captured[0] || $("#url").value.trim()) : $("#list-name").value.trim(), urls, items: structuredItems};
  if (mode === "movie" && !request.url) return toast("Додай посилання на відео", "error");
  if (mode === "series" && source === "direct" && !urls.length) return toast("Додай хоча б одне посилання", "error");
  if (mode === "series" && source === "list" && !request.url) return toast("Вкажи файл зі списком", "error");
  pendingPackage = request;
  const selectedItems = capturedItems;
  const voices = [...new Set(selectedItems.map(item => item.voice).filter(Boolean))];
  const seasons = [...new Set((structuredItems.length ? structuredItems.map(item => item.season) : [request.season]).filter(Boolean))];
  const container = config?.yt_dlp?.container || "mp4";
  const previewItems = structuredItems.length ? structuredItems : urls.map((_, index) => ({voice: "", season: request.season || "1", episode: Number(request.startEpisode || 1) + index}));
  const filePreview = previewItems.map(item => `Season ${String(item.season).padStart(2, "0")}\\${item.voice ? `${safePathPart(item.voice)}\\` : ""}S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}.${container}`);
  $("#package-title").textContent = request.title;
  $("#package-voice").textContent = voices.join(", ") || "Не визначено";
  $("#package-season").textContent = mode === "series" ? seasons.map(value => `Сезон ${value}`).join(", ") : "Фільм";
  $("#package-count").textContent = mode === "series" ? `${urls.length} серій` : "1 файл";
  $("#package-files").textContent = mode === "series" ? filePreview.join("  ·  ") : `${request.title}.${container}`;
  $("#package-folder").textContent = request.outputDir || (mode === "series" ? config?.paths?.serials_dir : config?.paths?.movies_dir) || "Папка з налаштувань";
  $("#package-dialog").showModal();
});

$("#confirm-package").addEventListener("click", async () => {
  if (!pendingPackage) return;
  const button = $("#confirm-package"); button.disabled = true; button.textContent = "Додаю…";
  try { const result = await api("/api/download", {method: "POST", body: JSON.stringify(pendingPackage)}); $("#package-dialog").close(); setActive(true); toast(`Додано до черги: ${result.queued || 1}`); pendingPackage = null; await syncQueue(); }
  catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "Додати до черги"; }
});

$("#browse-output").addEventListener("click", async () => {
  const button = $("#browse-output");
  button.disabled = true; button.textContent = "Відкриваю…";
  try {
    const result = await api("/api/browse-directory", {method: "POST", body: JSON.stringify({current: $("#output").value.trim() || config?.paths?.serials_dir || ""})});
    if (result.path) { $("#output").value = result.path; toast("Папку вибрано"); }
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "Вибрати папку"; }
});

$("#pause").addEventListener("click", async () => {
  try { await api(paused ? "/api/resume" : "/api/pause", {method: "POST"}); paused = !paused; $("#pause").textContent = paused ? "Продовжити" : "Призупинити"; $("#state").textContent = paused ? "Пауза" : "Активне"; }
  catch (error) { toast(error.message, "error"); }
});
$("#cancel").addEventListener("click", async () => { try { await api("/api/cancel", {method: "POST"}); paused = false; setActive(false); toast("Завантаження зупинено"); } catch (error) { toast(error.message, "error"); } });

$("#save-settings").addEventListener("click", async () => {
  $$('[data-config]').forEach(input => writePath(config, input.dataset.config, input.type === "number" ? Number(input.value) : input.value.trim()));
  try { config = await api("/api/config", {method: "PUT", body: JSON.stringify(config)}); toast("Налаштування збережено"); }
  catch (error) { toast(error.message, "error"); }
});

$("#clear-inbox").addEventListener("click", async () => {
  try {
    await api("/api/inbox", {method: "DELETE"});
    inboxSignature = "";
    await syncBridge();
    toast("Перехоплені посилання очищено");
  } catch (error) { toast(error.message, "error"); }
});
$("#clear-history").addEventListener("click", async () => { try { await api("/api/queue/completed", {method:"DELETE"}); localStorage.removeItem("hls-history"); await syncQueue(); toast("Історію очищено"); } catch (error) { toast(error.message,"error"); } });
$("#queue-jobs").addEventListener("click", async event => { const button = event.target.closest("[data-job-action]"); if (!button) return; const row = button.closest("[data-job-id]"); try { await api("/api/queue/action", {method:"POST",body:JSON.stringify({id:row.dataset.jobId,action:button.dataset.jobAction})}); await syncQueue(); } catch(error){ toast(error.message,"error"); } });
$("#history-list").addEventListener("click", async event => { const button=event.target.closest("[data-job-action]"); if(!button)return; const row=button.closest("[data-job-id]"); try{await api("/api/queue/action",{method:"POST",body:JSON.stringify({id:row.dataset.jobId,action:button.dataset.jobAction})});await syncQueue();toast("Завдання повернено до черги");}catch(error){toast(error.message,"error");} });
$("#queue-pause").addEventListener("click", async () => { try { await api(paused ? "/api/resume" : "/api/pause", {method:"POST"}); paused=!paused; $("#queue-pause").textContent=paused?"Продовжити":"Пауза"; } catch(error){ toast(error.message,"error"); } });
$("#queue-stop").addEventListener("click", async () => { try { await api("/api/queue/stop-all", {method:"POST"}); await syncQueue(); toast("Чергу зупинено"); } catch(error){ toast(error.message,"error"); } });
$("#toggle-captures").addEventListener("click", () => {
  const picker = $("#capture-picker");
  picker.classList.toggle("open");
  $("#toggle-captures").textContent = picker.classList.contains("open") ? "Згорнути" : "Вибрати";
});
$("#select-all").addEventListener("click", () => { $$('#capture-groups input').forEach(input => input.checked = true); updateSelectionSummary(); });
$("#select-none").addEventListener("click", () => { $$('#capture-groups input').forEach(input => input.checked = false); updateSelectionSummary(); });

const events = new EventSource("/api/events");
events.onmessage = event => renderProgress(JSON.parse(event.data));
events.onerror = () => $(".connection").innerHTML = "<span style='background:#ff5c67'></span>Перепідключення…";
events.onopen = () => $(".connection").innerHTML = "<span></span>Сервер активний";

Promise.all([loadConfig(), api("/api/status"), syncInbox({notify: false})]).then(([, status]) => { if (status.active || status.progress?.status) renderProgress(status.progress); }).catch(error => toast(error.message, "error"));
setInterval(syncInbox, 1500);
setInterval(syncQueue, 1500);
setInterval(syncBridge, 10000);
setMode("movie");
renderHistory();
syncQueue();
syncBridge();
