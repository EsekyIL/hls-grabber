const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// ── Рух ──────────────────────────────────────────────────────────────────
//
// Motion вшита поруч (vendor/motion.js). Усі виклики йдуть через animate():
// якщо бібліотека не завантажилась або людина попросила менше руху, панель
// просто перемикає стани без анімації, і жодна функція від цього не
// ламається.

const Motion = window.Motion || null;
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const canAnimate = Boolean(Motion) && !reducedMotion;
const spring = {type: "spring", stiffness: 420, damping: 36};
const softSpring = {type: "spring", stiffness: 260, damping: 30};
const easeOut = [0.2, 0.8, 0.2, 1];

function animate(element, keyframes, options = {}) {
  if (!canAnimate || !element) return null;
  try { return Motion.animate(element, keyframes, options); } catch (_) { return null; }
}

// Плавно веде число від старого значення до нового.
function tween(from, to, onUpdate, options = {}) {
  if (!canAnimate || from === to) { onUpdate(to); return null; }
  try { return Motion.animate(from, to, {duration: 0.7, ease: easeOut, ...options, onUpdate}); }
  catch (_) { onUpdate(to); return null; }
}

function enter(element, delay = 0) {
  return animate(element, {opacity: [0, 1], y: [10, 0]}, {...spring, delay});
}

function stagger(elements, step = 0.03, max = 24) {
  elements.slice(0, max).forEach((element, index) => enter(element, index * step));
}

// Повзунок перемикача або навігації їде під активну кнопку.
//
// Позицію ставимо через Motion і там, де руху не треба (duration: 0): якщо
// раз поставити transform руками, а наступного разу анімувати x, Motion не
// знає, звідки стартувати, і повзунок стрибає з нуля.
function movePill(container, instant = false) {
  if (!container) return;
  const pill = container.querySelector(":scope > .segmented__pill, :scope > .nav__pill");
  const active = container.querySelector(":scope > .active");
  if (!pill || !active || container.offsetParent === null) return;
  const vertical = pill.classList.contains("nav__pill");
  const target = vertical
    ? {y: active.offsetTop}
    : {x: active.offsetLeft, width: `${active.offsetWidth}px`};
  const first = !container.classList.contains("ready");
  if (canAnimate) {
    Motion.animate(pill, target, instant || first ? {duration: 0} : spring);
  } else {
    pill.style.transform = vertical ? `translateY(${target.y}px)` : `translateX(${target.x}px)`;
    if (!vertical) pill.style.width = target.width;
  }
  container.classList.add("ready");
}

function refreshPills(root = document, instant = true) {
  root.querySelectorAll(".segmented, .nav").forEach(container => movePill(container, instant));
}

// ── Стан ─────────────────────────────────────────────────────────────────

let tab = "site";
let mode = "movie";
let source = "direct";
let paused = false;
let config = null;
let savedSettings = "";
let inboxSignature = "";
let inboxItems = [];
let pendingPackage = null;
let diagnosticsLoaded = false;
let currentBridge = null;
let jobs = [];
let runningJob = null;
let lastStats = null;
let shownPercent = 0;
let historyFilter = "all";
let knownOutcomes = null;

// Повідомлення завантажувача англійські — тут їх людський вигляд.
const MESSAGES = {
  "Preparing download": "Готую завантаження",
  "Download complete": "Завантажено",
  "Episode already exists": "Уже є на диску",
  "Series complete": "Серіал завершено",
  "Download is already running": "Уже щось качається"
};
const say = message => MESSAGES[message] || message || "";

function toast(message, type = "") {
  const box = $("#toasts");
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = `<span class="toast__icon"><svg><use href="#i-${type === "error" ? "alert" : "check"}"/></svg></span><span></span>`;
  node.lastChild.textContent = message;
  box.prepend(node);
  while (box.children.length > 3) box.lastChild.remove();
  animate(node, {opacity: [0, 1], y: [-18, 0], scale: [0.95, 1]}, spring);
  setTimeout(async () => {
    const leaving = animate(node, {opacity: 0, y: -10, scale: 0.97}, {duration: 0.2});
    if (leaving) await leaving;
    node.remove();
  }, type === "error" ? 5200 : 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {headers: {"Content-Type": "application/json"}, ...options});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function escapeHTML(value) { const node = document.createElement("span"); node.textContent = value ?? ""; return node.innerHTML; }
const pad2 = value => String(value).padStart(2, "0");
const digits = value => String(value ?? "").match(/\d+/)?.[0] || "";
const episodeCode = job => job.mode === "series" && job.episode ? `S${pad2(job.season)}E${pad2(job.episode)}` : "Фільм";

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return "—";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours} год ${pad2(minutes)} хв`;
  if (minutes) return `${minutes} хв ${pad2(rest)} с`;
  return `${rest} с`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("uk-UA", {hour: "2-digit", minute: "2-digit"});
  const today = new Date().toDateString() === date.toDateString();
  return today ? time : `${date.toLocaleDateString("uk-UA", {day: "2-digit", month: "2-digit"})} ${time}`;
}

// ── Навігація ────────────────────────────────────────────────────────────

function showPage(name) {
  $$(".nav__item").forEach(button => button.classList.toggle("active", button.dataset.page === name));
  movePill($(".nav"));
  const next = $(`#${name}-page`);
  if (!next || next.classList.contains("active")) return;
  $$(".page").forEach(page => page.classList.remove("active"));
  next.classList.add("active");
  refreshPills(next);
  animate(next, {opacity: [0, 1], y: [12, 0]}, {duration: 0.4, ease: easeOut});
  window.scrollTo({top: 0});
  if (name === "diagnostics") loadDiagnostics();
}

function setTab(next) {
  tab = next;
  $$("#tab-switch [data-tab]").forEach(button => button.classList.toggle("active", button.dataset.tab === tab));
  movePill($("#tab-switch"));
  const shown = $(`#tab-${tab}`);
  $$(".tab").forEach(node => node.classList.toggle("active", node === shown));
  refreshPills(shown);
  animate(shown, {opacity: [0, 1], y: [8, 0]}, {duration: 0.3, ease: easeOut});
  updateTitleLabel();
  updateSaveSummary();
}

function setMode(next) {
  mode = next;
  $$("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
  movePill($("#mode-switch"));
  $(".series-only").classList.toggle("hidden", mode !== "series");
  $(".movie-url-field").classList.toggle("hidden", mode === "series");
  setSource(source);
  updateTitleLabel();
  updateSaveSummary();
}

function setSource(next) {
  source = next;
  $$("[data-source]").forEach(button => button.classList.toggle("active", button.dataset.source === source));
  $(".series-links-field").classList.toggle("hidden", source !== "direct");
  $(".list-field").classList.toggle("hidden", source !== "list");
  updateSaveSummary();
}

function updateTitleLabel() {
  const series = tab === "site" ? inboxItems.some(item => digits(item.episode)) : mode === "series";
  $("#title-label").textContent = tab === "site" ? "Назва" : series ? "Назва серіалу" : "Назва фільму";
}

// ── Черга, поточне завантаження й історія ────────────────────────────────

function renderProgress(stats) {
  if (!stats || !stats.status) return;
  lastStats = stats;
  renderNow();
}

function renderNow() {
  const live = lastStats && ["starting", "downloading"].includes(lastStats.status);
  const visible = Boolean(runningJob) || live;
  const card = $("#progress-view");
  const wasHidden = card.classList.contains("hidden");
  card.classList.toggle("hidden", !visible);
  $("#empty-state").classList.toggle("hidden", visible);
  if (visible && wasHidden) animate(card, {opacity: [0, 1], scale: [0.97, 1]}, softSpring);

  const pending = jobs.filter(job => job.state === "pending").length;
  updateMini(visible, pending);

  const state = $("#state");
  state.className = `pill ${visible ? (paused ? "warning" : "active") : ""}`;
  state.textContent = visible ? (paused ? "Пауза" : "Качаю") : "Готово";
  if (!visible) { shownPercent = 0; return; }

  const job = runningJob;
  const stats = lastStats || {};
  const percent = Math.max(0, Math.min(100, Number(stats.status === "downloading" ? stats.percent : job?.percent) || 0));
  $("#progress-code").textContent = job ? episodeCode(job) : (stats.title || "—");
  $("#progress-title").textContent = job?.title || stats.title || "Завантаження";
  $("#progress-message").textContent = [job?.voice, say(stats.message || job?.message)].filter(Boolean).join(" · ") || "Підготовка…";
  $("#progress-state").textContent = paused ? "На паузі" : stats.status === "starting" ? "Готуюсь" : "Качаю";
  card.classList.toggle("paused", paused);

  const from = shownPercent;
  shownPercent = percent;
  tween(from, percent, value => {
    $("#progress-number").textContent = value < 10 && value > 0 ? value.toFixed(1) : Math.round(value);
  });
  const bar = $("#progress-bar");
  if (!animate(bar, {width: `${percent}%`}, {duration: 0.6, ease: easeOut})) bar.style.width = `${percent}%`;

  $("#speed").textContent = stats.speedMB ? `${stats.speedMB.toFixed(1)} МБ/с` : "—";
  $("#fragments").textContent = stats.fragmentCount ? `${stats.fragmentIndex}/${stats.fragmentCount}` : "—";
  $("#eta").textContent = formatDuration(stats.etaSeconds);
}

function updateMini(active, pending) {
  const percent = active ? shownPercentTarget() : 0;
  $("#mini-arc").style.strokeDasharray = `${active ? percent : 0} 100`;
  $("#mini-title").textContent = active ? (runningJob?.title || lastStats?.title || "Качаю") : "Черга";
  $("#mini-sub").textContent = active
    ? `${Math.round(percent)}%${pending ? ` · ще ${pending}` : ""}`
    : pending ? `${pending} у черзі` : "порожня";
}

function shownPercentTarget() {
  const stats = lastStats || {};
  return Math.max(0, Math.min(100, Number(stats.status === "downloading" ? stats.percent : runningJob?.percent) || 0));
}

function jobCopy(job) {
  return `<span class="code">${escapeHTML(episodeCode(job))}</span>
    <span class="job__copy"><small>${escapeHTML(job.message ? say(job.message) : "в черзі")}</small></span>
    <span class="job__actions">
      <button class="icon-btn" data-job-action="up" title="Вище" aria-label="Вище"><svg><use href="#i-up"/></svg></button>
      <button class="icon-btn" data-job-action="down" title="Нижче" aria-label="Нижче"><svg><use href="#i-down"/></svg></button>
      <button class="icon-btn" data-job-action="remove" title="Прибрати" aria-label="Прибрати"><svg><use href="#i-x"/></svg></button>
    </span>`;
}

// Список «Далі» з ключами: наявні рядки лишаються тими самими вузлами, і
// при перестановці кожен плавно їде на нове місце (FLIP), а не
// перемальовується стрибком.
//
// Серії одного серіалу й озвучки йдуть під спільним заголовком: інакше
// назва повторювалась би в кожному з тридцяти рядків.
function renderJobs(pending) {
  const list = $("#queue-jobs");
  const before = new Map([...list.children].map(node => [node.dataset.jobId, node.getBoundingClientRect().top]));
  const existing = new Map([...list.children].map(node => [node.dataset.jobId, node]));
  const fresh = new Set();
  const entries = [];
  const seen = new Map();
  let header = null;
  for (const job of pending) {
    const group = `${job.title}\u001f${job.voice || ""}`;
    if (!header || header.group !== group) {
      const occurrence = (seen.get(group) || 0) + 1;
      seen.set(group, occurrence);
      header = {header: true, group, id: `g:${group}:${occurrence}`, title: job.title, voice: job.voice, count: 0};
      entries.push(header);
    }
    header.count++;
    entries.push({group, id: job.id, job});
  }
  const nodes = entries.map(entry => {
    let node = existing.get(entry.id);
    if (!node) {
      node = document.createElement("li");
      node.className = entry.header ? "job-group" : "job";
      node.dataset.jobId = entry.id;
      fresh.add(node);
    }
    const signature = entry.header
      ? [entry.title, entry.voice, entry.count].join("\u001f")
      : [entry.job.season, entry.job.episode, entry.job.message].join("\u001f");
    if (node.dataset.signature !== signature) {
      node.dataset.signature = signature;
      node.innerHTML = entry.header
        ? `<b>${escapeHTML(entry.title)}</b><small>${escapeHTML([entry.voice, `${entry.count} шт.`].filter(Boolean).join(" · "))}</small>`
        : jobCopy(entry.job);
    }
    return node;
  });
  list.replaceChildren(...nodes);
  let delay = 0;
  for (const node of nodes) {
    if (fresh.has(node)) { if (before.size) enter(node, delay += 0.03); else if (delay < 0.5) enter(node, delay += 0.02); continue; }
    const dy = before.get(node.dataset.jobId) - node.getBoundingClientRect().top;
    if (dy) animate(node, {y: [dy, 0]}, spring);
  }
  $("#queue-empty").classList.toggle("hidden", pending.length > 0);
  $("#queue-summary").textContent = pending.length ? `${pending.length} у черзі` : "порожньо";
  $(".dock__foot").classList.toggle("hidden", !pending.length && !runningJob);
}

function renderHistory() {
  const done = jobs
    .filter(job => job.state === "finished" || job.state === "error")
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const errors = done.filter(job => job.state === "error").length;
  const badge = $("#history-badge");
  badge.textContent = errors;
  badge.classList.toggle("hidden", !errors);

  const shown = done.filter(job => historyFilter === "all" || job.state === historyFilter);
  const list = $("#history-list");
  const signature = shown.map(job => job.id + job.state + job.updatedAt).join("|");
  $("#history-empty").classList.toggle("hidden", shown.length > 0);
  if (list.dataset.signature === signature) return;
  const known = new Set([...list.children].map(node => node.dataset.jobId));
  list.dataset.signature = signature;
  list.innerHTML = shown.map(job => {
    const failed = job.state === "error";
    const details = [job.voice, job.mode === "series" ? episodeCode(job) : "", failed ? say(job.message) : ""].filter(Boolean).join(" · ");
    return `<li class="hrow ${failed ? "error" : ""}" data-job-id="${escapeHTML(job.id)}">
      <span class="hrow__icon"><svg><use href="#i-${failed ? "alert" : "check"}"/></svg></span>
      <span class="hrow__copy"><b>${escapeHTML(job.title)}</b><small title="${escapeHTML(details)}">${escapeHTML(details || "Готово")}</small></span>
      <time>${escapeHTML(formatTime(job.updatedAt))}</time>
      ${failed ? `<button class="btn btn--ghost btn--small" data-job-action="retry"><svg><use href="#i-retry"/></svg>Повторити</button>` : "<span></span>"}
    </li>`;
  }).join("");
  const added = [...list.children].filter(node => !known.has(node.dataset.jobId));
  if (added.length !== list.children.length || $("#history-page").classList.contains("active")) stagger(added, 0.025, 16);
}

// Сповіщаємо про підсумок задачі, а не про кожну подію завантажувача:
// повтори й дзеркала дають по кілька проміжних помилок, і тост на кожну
// лише лякав би.
function announceOutcomes() {
  const outcomes = new Map(jobs.filter(job => job.state === "finished" || job.state === "error").map(job => [job.id, job]));
  if (knownOutcomes) {
    for (const [id, job] of outcomes) {
      if (knownOutcomes.has(id)) continue;
      const label = `${job.title}${job.mode === "series" ? ` · ${episodeCode(job)}` : ""}`;
      if (job.state === "error") toast(`Не вдалося: ${label}`, "error");
      else toast(`Готово: ${label}`);
    }
  }
  knownOutcomes = new Set(outcomes.keys());
}

async function syncQueue() {
  try {
    jobs = await api("/api/queue");
  } catch (_) { return; }
  runningJob = jobs.find(job => job.state === "running") || null;
  if (!runningJob && paused) setPaused(false);
  renderJobs(jobs.filter(job => job.state === "pending"));
  renderHistory();
  announceOutcomes();
  renderNow();
}

function setPaused(value) {
  paused = value;
  const button = $("#pause");
  button.querySelector("use").setAttribute("href", paused ? "#i-play" : "#i-pause");
  button.querySelector("span").textContent = paused ? "Продовжити" : "Пауза";
  renderNow();
}

// ── Налаштування ─────────────────────────────────────────────────────────

function readPath(object, path) { return path.split(".").reduce((value, key) => value?.[key], object); }
function writePath(object, path, value) { const keys = path.split("."); const last = keys.pop(); const parent = keys.reduce((node, key) => node[key] ||= {}, object); parent[last] = value; }
const settingsSnapshot = () => JSON.stringify($$("[data-config]").map(input => input.value));

function fillSettings() {
  $$("[data-config]").forEach(input => input.value = readPath(config, input.dataset.config) ?? "");
  savedSettings = settingsSnapshot();
  $("#save-bar").classList.remove("show");
  countProxies();
}

async function loadConfig() {
  config = await api("/api/config");
  fillSettings();
}

$$("[data-config]").forEach(input => input.addEventListener("input", () => {
  $("#save-bar").classList.toggle("show", settingsSnapshot() !== savedSettings);
}));
$("#reset-settings").addEventListener("click", fillSettings);

// ── Проксі ──────────────────────────────────────────────────────────────
//
// Файл читаємо тут, у браузері, і дописуємо до поля: на сервер іде вже
// разом з іншими налаштуваннями, а розбирає й перевіряє його панель при
// збереженні (config.ParseProxies). Дублі вона ж і прибере.
const proxyField = $('[data-config="yt_dlp.proxies"]');
function countProxies() {
  const count = proxyField.value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")).length;
  $("#proxy-count").textContent = count ? `У списку: ${count}` : "Порожньо — напряму";
}
proxyField.addEventListener("input", countProxies);
$("#import-proxies").addEventListener("click", () => $("#proxy-file").click());
$("#proxy-file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const text = (await file.text()).trim();
  if (!text) { toast("Файл порожній", "error"); return; }
  proxyField.value = [proxyField.value.trim(), text].filter(Boolean).join("\n");
  proxyField.dispatchEvent(new Event("input"));
  toast(`Додано з «${file.name}». Натисни «Зберегти», щоб перевірити й застосувати.`);
});
$("#save-settings").addEventListener("click", async () => {
  $$("[data-config]").forEach(input => writePath(config, input.dataset.config, input.type === "number" ? Number(input.value) : input.value.trim()));
  try {
    config = await api("/api/config", {method: "PUT", body: JSON.stringify(config)});
    fillSettings();
    toast("Налаштування збережено");
  } catch (error) { toast(error.message, "error"); }
});

// ── Крок 1–2: розбір сторінки й озвучки ─────────────────────────────────
//
// Панель не ходить на сайт сама — вона кладе команду, а забирає її
// розширення (див. bridgecmd.go). Тому тут лише постановка задачі й
// опитування стану: жодного очікування на відповідь, яке пережило б
// закриту вкладку.

let probeTimer = null;
let probeURL = "";

function stopProbePolling() { clearInterval(probeTimer); probeTimer = null; }

function setStep(id, state) {
  const step = $(`#${id}`);
  if (step.dataset.state === state) return;
  const wasLocked = step.dataset.state === "locked";
  step.dataset.state = state;
  animate(step.querySelector(".step__marker"), {scale: [0.8, 1]}, {type: "spring", stiffness: 500, damping: 18});
  if (wasLocked) {
    refreshPills(step);
    const reveal = step.querySelector(".step__reveal");
    if (reveal) animate(reveal, {opacity: [0, 1], y: [-8, 0]}, softSpring);
  }
}

function updateSteps() {
  const voices = $$("#probe-voices .voice-item").length;
  const episodes = inboxItems.length;
  setStep("step-page", voices ? "done" : "active");
  setStep("step-voices", voices ? (episodes ? "done" : "active") : "locked");
  setStep("step-episodes", episodes ? "active" : "locked");
  const checked = $$("#probe-voices input:checked").length;
  $("#voices-hint").textContent = voices ? `${voices} шт. · вибрано ${checked}` : "з'являться після розбору сторінки";
}

function renderProbe(session) {
  const state = session?.state || "";
  const running = state === "queued" || state === "running";
  const scanning = session?.command?.kind === "scan";

  $("#probe-cancel").classList.toggle("hidden", !running);
  $("#probe-start").disabled = running;
  $("#probe-scan").disabled = running || !$$("#probe-voices input:checked").length;

  // Помилку кладемо окремим рядком, а не в підпис стану: вона називає
  // причину («вкладка: complete, about:neterror…»), і в тісному куточку
  // такий текст обрізався б до трьох слів.
  $("#probe-error").classList.toggle("hidden", !session?.error);
  if (session?.error) {
    $("#probe-error").textContent = session.error;
    $("#probe-state").textContent = "Не вдалося";
    $("#scan-meter").classList.add("hidden");
    stopProbePolling();
    return;
  }
  $("#probe-state").textContent = scanning ? "готово" : ({queued: "чекаю на розширення…", running: "читаю сторінку…", ready: "готово", done: "готово"}[state] || "");

  if (session?.title) {
    const found = $("#probe-found");
    const wasHidden = found.classList.contains("hidden");
    found.classList.remove("hidden");
    $("#probe-title").textContent = session.title;
    if (wasHidden) enter(found);
  }

  const voices = session?.translators || [];
  if (voices.length) {
    // Перемальовуємо лише коли набір змінився: інакше кожне опитування
    // скидало б галочки, які людина щойно поставила.
    const grid = $("#probe-voices");
    const signature = voices.map(voice => voice.id).join(",");
    if (grid.dataset.signature !== signature) {
      grid.dataset.signature = signature;
      grid.innerHTML = voices.map(voice =>
        `<label class="voice-item"><input type="checkbox" value="${escapeHTML(voice.id)}"><span class="check"><svg><use href="#i-check"/></svg></span><span>${escapeHTML(voice.name)}</span></label>`
      ).join("");
      grid.querySelectorAll("input").forEach(input => input.addEventListener("change", () => {
        const item = input.closest(".voice-item");
        item.classList.toggle("active", input.checked);
        animate(item.querySelector(".check"), {scale: [0.7, 1]}, {type: "spring", stiffness: 600, damping: 15});
        $("#probe-scan").disabled = !$$("#probe-voices input:checked").length || Boolean(probeTimer);
        updateSteps();
      }));
      updateSteps();
      stagger([...grid.children], 0.035);
    }
  }

  const meter = $("#scan-meter");
  const found = session?.completed || 0;
  const missed = session?.missed || 0;
  meter.classList.toggle("hidden", !(scanning && (running || found || missed)));
  meter.classList.toggle("idle", !running);
  $("#probe-progress").textContent = running && !found && !missed
    ? "починаю…"
    : `знайдено ${found}${missed ? ` · без посилання ${missed}` : ""}`;

  if (!running) {
    const wasPolling = Boolean(probeTimer);
    stopProbePolling();
    // Знайдене лягає в ту саму скриньку, що й ручне перехоплення, тож
    // підбірку оновлюємо звичайним шляхом.
    syncInbox({notify: false}).then(() => {
      if (!wasPolling || !scanning) return;
      toast(missed ? `Знайдено ${found}, без посилання ${missed}` : `Знайдено серій: ${found}`, missed && !found ? "error" : "");
      $("#step-episodes").scrollIntoView({behavior: canAnimate ? "smooth" : "auto", block: "start"});
    });
  }
}

function startProbePolling() {
  stopProbePolling();
  probeTimer = setInterval(async () => {
    try { renderProbe(await api("/api/bridge/session")); }
    catch (_) { stopProbePolling(); }
  }, 1200);
}

async function startProbe() {
  const url = $("#probe-url").value.trim();
  if (!url) { toast("Встав адресу сторінки серіалу", "error"); $("#probe-url").focus(); return; }
  probeURL = url;
  try {
    $("#probe-voices").dataset.signature = "";
    renderProbe(await api("/api/bridge/probe", {method: "POST", body: JSON.stringify({url})}));
    startProbePolling();
  } catch (error) {
    toast(error.message, "error");
    animate($(".url-bar"), {x: [0, -6, 6, -4, 4, 0]}, {duration: 0.4});
  }
}

$("#probe-start").addEventListener("click", startProbe);
$("#probe-url").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); startProbe(); } });

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
  $("#probe-state").textContent = "зупинено: розширення завершить поточну серію";
  $("#probe-start").disabled = false;
  $("#probe-scan").disabled = !$$("#probe-voices input:checked").length;
  $("#probe-cancel").classList.add("hidden");
  $("#scan-meter").classList.add("idle");
});

// ── Крок 3: серії та якість ──────────────────────────────────────────────
//
// Якості приходять разом з епізодом: обхід через API сайту віддає весь набір
// одразу. Вибір один на всі серії — саме так це працює й у плеєрі, і саме
// цього чекають від «скачати в 1080».

let chosenQuality = "";

// Спільні для ВСІХ знайдених епізодів. Показувати якість, яка є лише в
// половини, означало б тихо підсунути решті іншу.
function availableQualities() {
  const lists = inboxItems.map(item => (item.streams || []).map(stream => stream.quality)).filter(list => list.length);
  if (!lists.length) return [];
  return lists.reduce((common, list) => common.filter(quality => list.includes(quality)));
}

// Усі адреси вибраної якості: перша — основна, решта — дзеркала інших CDN.
// Черга пробує їх по черзі, коли основна відповідає помилкою.
function urlsForItem(item) {
  if (chosenQuality && Array.isArray(item.streams)) {
    const found = item.streams.find(stream => stream.quality === chosenQuality);
    if (found?.urls?.length) return found.urls;
  }
  const same = (item.streams || []).find(stream => stream.urls?.includes(item.url));
  return same ? [item.url, ...same.urls.filter(url => url !== item.url)] : [item.url];
}

function urlForItem(item) {
  return urlsForItem(item)[0];
}

// Підпис якості, яку качатимемо. Черга пам'ятає його, щоб свіже посилання
// замість протухлого було тієї самої якості.
function qualityForItem(item) {
  const streams = item.streams || [];
  if (chosenQuality && streams.some(stream => stream.quality === chosenQuality)) return chosenQuality;
  return streams.find(stream => stream.urls?.includes(item.url))?.quality || "";
}

function renderQualityPick() {
  const qualities = availableQualities();
  const wrap = $("#quality-pick");
  wrap.classList.toggle("hidden", qualities.length < 2);
  if (qualities.length < 2) { chosenQuality = ""; return; }
  const signature = qualities.join(",");
  if (wrap.dataset.signature === signature) return;
  wrap.dataset.signature = signature;
  if (!qualities.includes(chosenQuality)) chosenQuality = qualities[qualities.length - 1];
  wrap.classList.remove("ready");
  wrap.innerHTML = `<span class="segmented__pill" aria-hidden="true"></span>` + qualities.map(quality =>
    `<button type="button" role="radio" data-quality="${escapeHTML(quality)}" class="${quality === chosenQuality ? "active" : ""}">${escapeHTML(quality)}</button>`
  ).join("");
  movePill(wrap, true);
}

$("#quality-pick").addEventListener("click", event => {
  const button = event.target.closest("[data-quality]");
  if (!button) return;
  chosenQuality = button.dataset.quality;
  $$("#quality-pick [data-quality]").forEach(node => node.classList.toggle("active", node === button));
  movePill($("#quality-pick"));
  updateSaveSummary();
});

function inboxItemKey(item) {
  return [item.url, item.voice, item.season, item.episode].join("\u001f");
}

function selectedInboxItems() {
  return $$("#capture-groups input:checked").map(input => inboxItems[Number(input.dataset.index)]).filter(Boolean);
}

function renderCapturePicker(selectNew = false) {
  const groups = $("#capture-groups");
  if (!inboxItems.length) { groups.textContent = ""; updateSaveSummary(); return; }
  const previous = new Set(selectedInboxItems().map(inboxItemKey));
  const firstRender = !groups.children.length;
  const byVoice = new Map();
  inboxItems.forEach((item, inboxIndex) => {
    item.__inboxIndex = inboxIndex;
    const key = item.voice || "Озвучка не визначена";
    if (!byVoice.has(key)) byVoice.set(key, []);
    byVoice.get(key).push(item);
  });
  groups.textContent = "";
  for (const [voice, items] of byVoice) {
    const group = document.createElement("div");
    group.className = "capture-group";
    group.innerHTML = `<div class="capture-group__title"><svg><use href="#i-mic"/></svg><b>${escapeHTML(voice)}</b><span class="pill">${items.length}</span></div>`;
    const bySeason = new Map();
    items.forEach(item => { const key = digits(item.season) || item.season || "?"; if (!bySeason.has(key)) bySeason.set(key, []); bySeason.get(key).push(item); });
    for (const [season, seasonItems] of bySeason) {
      const seasonGroup = document.createElement("div");
      seasonGroup.className = "season-group";
      seasonGroup.innerHTML = `<button type="button" class="season-group__title" title="Вибрати або зняти весь сезон">Сезон ${escapeHTML(season)} · ${seasonItems.length}</button><div class="episode-grid"></div>`;
      const grid = seasonGroup.querySelector(".episode-grid");
      seasonItems.sort((a, b) => Number(digits(a.episode) || 0) - Number(digits(b.episode) || 0)).forEach((item, index) => {
        const chip = document.createElement("label");
        chip.className = "capture-item";
        chip.title = `${item.title || "HLS"}\n${item.url}`;
        const checked = selectNew || previous.has(inboxItemKey(item));
        const label = item.episode ? `E${digits(item.episode) || item.episode}` : `#${index + 1}`;
        chip.innerHTML = `<input type="checkbox" data-index="${item.__inboxIndex}" ${checked ? "checked" : ""}><span class="capture-item__episode">${escapeHTML(label)}</span>`;
        grid.appendChild(chip);
      });
      seasonGroup.querySelector(".season-group__title").addEventListener("click", () => {
        const inputs = [...grid.querySelectorAll("input")];
        const all = inputs.every(input => input.checked);
        inputs.forEach(input => input.checked = !all);
        updateSaveSummary();
      });
      group.appendChild(seasonGroup);
    }
    groups.appendChild(group);
  }
  groups.querySelectorAll("input").forEach(input => input.addEventListener("change", updateSaveSummary));
  if (firstRender) stagger([...groups.children], 0.05, 8);
  updateSaveSummary();
}

function updateSaveSummary() {
  const summary = $("#selection-summary");
  $("#download-form").classList.toggle("is-sticky", tab === "manual" || inboxItems.length > 0);
  if (tab === "site") {
    const selected = selectedInboxItems().length;
    summary.innerHTML = inboxItems.length
      ? `Вибрано <b>${selected}</b> з ${inboxItems.length}${chosenQuality ? ` · ${escapeHTML(chosenQuality)}` : ""}`
      : "Спершу знайди серії";
    $("#start-button").disabled = !selected;
    return;
  }
  $("#start-button").disabled = false;
  if (mode === "movie") { summary.textContent = "Один фільм"; return; }
  if (source === "list") { summary.textContent = "Серії з файлу"; return; }
  const count = $("#urls").value.split(/\r?\n/).filter(line => line.trim()).length;
  summary.innerHTML = count ? `<b>${count}</b> посилань` : "Посилань ще немає";
}

$("#urls").addEventListener("input", updateSaveSummary);

function cleanPageTitle(title) {
  return title
    .replace(/\s*[|—–-]\s*(дивитися|смотреть|онлайн|online).*$/i, "")
    .replace(/\s*[|—–]\s*[^|—–]{1,40}$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function syncInbox({notify = true} = {}) {
  let items;
  try {
    const response = await api("/api/inbox");
    items = Array.isArray(response) ? response : [];
  } catch (_) { return; }
  inboxItems = items;
  const signature = items.map(inboxItemKey).join("\n");
  if (!signature) {
    if (inboxSignature) { inboxSignature = ""; renderCapturePicker(); }
    $("#capture-status").textContent = "знайдене й перехоплене з плеєра";
    updateSteps();
    updateTitleLabel();
    updateSaveSummary();
    return;
  }
  const voices = new Set(items.map(item => item.voice).filter(Boolean)).size;
  $("#capture-status").textContent = `${items.length} шт.${voices > 1 ? ` · ${voices} озвучки` : ""}`;
  if (signature === inboxSignature) return;
  inboxSignature = signature;
  renderQualityPick();
  renderCapturePicker(true);
  updateSteps();
  updateTitleLabel();
  const pageTitle = items.find(item => item.title)?.title || "";
  if (pageTitle && !$("#title").value.trim()) $("#title").value = cleanPageTitle(pageTitle);
  // Під час обходу тост був би на кожне опитування; підсумок скаже
  // renderProbe, коли обхід скінчиться.
  if (notify && !probeTimer) toast(`Перехоплено з браузера: ${items.length}`);
}

$("#select-all").addEventListener("click", () => { $$("#capture-groups input").forEach(input => input.checked = true); updateSaveSummary(); });
$("#select-none").addEventListener("click", () => { $$("#capture-groups input").forEach(input => input.checked = false); updateSaveSummary(); });
$("#clear-inbox").addEventListener("click", async () => {
  try {
    await api("/api/inbox", {method: "DELETE"});
    await syncInbox({notify: false});
    toast("Знайдене очищено");
  } catch (error) { toast(error.message, "error"); }
});

// ── Підтвердження й постановка в чергу ───────────────────────────────────

function summariseFiles(items, container) {
  const groups = new Map();
  for (const item of items) {
    const season = pad2(item.season || 1);
    const voice = item.voice ? safePathPart(item.voice) : "";
    const key = season + "|" + voice;
    if (!groups.has(key)) groups.set(key, {season, voice, episodes: []});
    groups.get(key).episodes.push(Number(item.episode) || 0);
  }
  // Діапазон серій одразу видає діру: «E01 – E13, 12 шт.» означає, що
  // однієї бракує, і це видно ДО запуску.
  return [...groups.values()].map(group => {
    const episodes = group.episodes.sort((a, b) => a - b);
    const first = pad2(episodes[0]);
    const last = pad2(episodes[episodes.length - 1]);
    const range = episodes.length === 1 ? `S${group.season}E${first}` : `S${group.season}E${first} – E${last}`;
    const where = `Season ${group.season}${group.voice ? "\\" + group.voice : ""}`;
    return `${where}  ${range}.${container}  · ${episodes.length} шт.`;
  });
}

function safePathPart(value) {
  return String(value || "").replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
}

function buildRequest() {
  const title = $("#title").value.trim();
  const outputDir = $("#output").value.trim();
  if (!title) return {error: "Вкажи назву", focus: "#title"};

  if (tab === "site") {
    const items = selectedInboxItems();
    if (!items.length) return {error: "Вибери хоча б одну серію"};
    const voices = [...new Set(items.map(item => item.voice).filter(Boolean))];
    const episodic = items.filter(item => Number(digits(item.episode)) > 0);
    if (episodic.length) {
      const structured = episodic.map(item => ({
        url: urlForItem(item), mirrors: urlsForItem(item).slice(1),
        pageUrl: item.pageUrl || "", translatorId: item.translatorId || "", quality: qualityForItem(item),
        voice: item.voice || "", season: digits(item.season) || "1", episode: Number(digits(item.episode))
      }));
      return {
        voices, preview: structured, kind: "series",
        request: {mode: "series", source: "direct", title, outputDir, season: structured[0].season, startEpisode: "1", url: "", urls: structured.map(item => item.url), items: structured}
      };
    }
    if (items.length === 1) {
      return {voices, kind: "movie", request: {mode: "movie", source: "direct", title, outputDir, url: urlForItem(items[0]), mirrors: urlsForItem(items[0]).slice(1), urls: [], items: []}};
    }
    // Кілька перехоплених адрес без номерів серій: нумеруємо по порядку.
    const urls = items.map(urlForItem);
    return {
      voices, kind: "series", preview: urls.map((_, index) => ({season: "1", episode: index + 1})),
      request: {mode: "series", source: "direct", title, outputDir, season: "1", startEpisode: "1", url: "", urls, items: []}
    };
  }

  if (mode === "movie") {
    const url = $("#url").value.trim();
    if (!url) return {error: "Додай посилання на відео", focus: "#url"};
    return {kind: "movie", request: {mode, source: "direct", title, outputDir, url, mirrors: [], urls: [], items: []}};
  }
  const season = $("#season").value || "1";
  const startEpisode = $("#episode").value || "1";
  if (source === "list") {
    const list = $("#list-name").value.trim();
    if (!list) return {error: "Вкажи файл зі списком", focus: "#list-name"};
    return {kind: "list", request: {mode, source, title, outputDir, season, startEpisode, url: list, urls: [], items: []}};
  }
  const urls = $("#urls").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!urls.length) return {error: "Додай хоча б одне посилання", focus: "#urls"};
  return {
    kind: "series", preview: urls.map((_, index) => ({season, episode: Number(startEpisode) + index})),
    request: {mode, source, title, outputDir, season, startEpisode, url: "", urls, items: []}
  };
}

$("#download-form").addEventListener("submit", event => {
  event.preventDefault();
  const built = buildRequest();
  if (built.error) {
    toast(built.error, "error");
    if (built.focus) $(built.focus).focus();
    return;
  }
  const {request, kind, voices = [], preview = []} = built;
  pendingPackage = request;
  const container = config?.yt_dlp?.container || "mp4";
  const seasons = [...new Set(preview.map(item => item.season))];
  $("#package-title").textContent = request.title;
  $("#package-voice").textContent = voices.join(", ") || "—";
  $("#package-season").textContent = kind === "movie" ? "Фільм" : seasons.length ? seasons.map(Number).join(", ") : "—";
  $("#package-count").textContent = kind === "movie" ? "1 файл" : kind === "list" ? "зі списку" : `${preview.length} серій`;
  $("#package-files").innerHTML = kind === "series"
    ? summariseFiles(preview, container).map(text => `<span class="package-line">${escapeHTML(text)}</span>`).join("")
    : kind === "movie" ? `<span class="package-line">${escapeHTML(`${safePathPart(request.title)}.${container}`)}</span>` : "Як у файлі зі списком";
  $("#package-folder").textContent = request.outputDir || (kind === "movie" ? config?.paths?.movies_dir : config?.paths?.serials_dir) || "Тека з налаштувань";
  const dialog = $("#package-dialog");
  dialog.showModal();
  animate(dialog, {opacity: [0, 1], scale: [0.94, 1], y: [12, 0]}, softSpring);
});

$("#confirm-package").addEventListener("click", async () => {
  if (!pendingPackage) return;
  const button = $("#confirm-package");
  button.disabled = true;
  try {
    const result = await api("/api/download", {method: "POST", body: JSON.stringify(pendingPackage)});
    $("#package-dialog").close();
    toast(`Додано до черги: ${result.queued || 1}`);
    pendingPackage = null;
    await syncQueue();
    animate(window.innerWidth <= 1280 ? $("#mini-player") : $(".dock__head"), {scale: [1, 1.06, 1]}, {duration: 0.45});
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
});

$("#browse-output").addEventListener("click", async () => {
  const button = $("#browse-output");
  button.disabled = true;
  try {
    const result = await api("/api/browse-directory", {method: "POST", body: JSON.stringify({current: $("#output").value.trim() || config?.paths?.serials_dir || ""})});
    if (result.path) { $("#output").value = result.path; toast("Теку вибрано"); }
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
});

// ── Діагностика й міст ───────────────────────────────────────────────────

function diagnosticRow(status, title, message, value = "") {
  return `<div class="diagnostic-row"><i class="dot ${escapeHTML(status)}"></i><div><strong>${escapeHTML(title)}</strong><small title="${escapeHTML(message)}">${escapeHTML(message)}</small></div><span>${escapeHTML(value)}</span></div>`;
}

async function loadDiagnostics(force = false) {
  if (diagnosticsLoaded && !force) return;
  const button = $("#refresh-diagnostics");
  button.disabled = true;
  animate(button.querySelector("svg"), {rotate: [0, 360]}, {duration: 0.8, ease: easeOut});
  try {
    renderDiagnostics(await api("/api/diagnostics"));
    diagnosticsLoaded = true;
  } catch (error) {
    $("#health-orb").className = "health__orb error";
    $("#health-title").textContent = "Перевірка не вдалася";
    $("#health-message").textContent = error.message;
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function renderDiagnostics(data) {
  const statuses = [...data.tools.map(item => item.status), ...data.folders.map(item => item.status), data.disk.status, data.bridge.status];
  const overall = statuses.includes("error") ? "error" : statuses.includes("warning") ? "warning" : "ok";
  $("#health-orb").className = `health__orb ${overall}`;
  $("#health-title").textContent = overall === "ok" ? "Усе готово до завантажень" : overall === "warning" ? "Є рекомендації" : "Потрібна увага";
  $("#health-message").textContent = overall === "ok" ? "Інструменти, з'єднання та сховище працюють." : "Проблемні місця позначені нижче.";
  $("#diagnostic-time").textContent = formatTime(data.checkedAt);
  $("#managed-tools-path").textContent = data.toolsDir;
  renderBridgeStatus(data.bridge);

  $("#diagnostic-tools").innerHTML = data.tools.map(tool => {
    const current = tool.version || "Не встановлено";
    const latest = tool.latest || "Невідомо";
    let action = tool.managed ? (tool.updateAvailable ? "Оновити" : "Перевстановити") : "Встановити керовану копію";
    if (tool.status === "error") action = "Встановити";
    const label = tool.status === "ok" ? "Готово" : tool.status === "warning" ? "Оновлення" : "Проблема";
    const primary = tool.updateAvailable || tool.status === "error" || !tool.managed;
    return `<section class="card tool glow">
      <div class="tool__top"><div class="tool__name"><span class="tool__badge">${tool.id === "yt-dlp" ? "Y" : "F"}</span><div><h2>${escapeHTML(tool.name)}</h2><small>${tool.managed ? "Керується панеллю" : "Зовнішня копія"}</small></div></div><span class="pill ${escapeHTML(tool.status)}">${label}</span></div>
      <div class="tool__versions"><div><span>Встановлено</span><strong title="${escapeHTML(current)}">${escapeHTML(current)}</strong></div><div><span>Актуальна</span><strong title="${escapeHTML(latest)}">${escapeHTML(latest)}</strong></div></div>
      <span class="tool__path" title="${escapeHTML(tool.path || data.toolsDir)}">${escapeHTML(tool.path || data.toolsDir)}</span>
      <div class="tool__foot"><p>${escapeHTML(tool.message)}</p><button class="btn ${primary ? "btn--primary" : "btn--ghost"} btn--small" data-update-tool="${escapeHTML(tool.id)}" ${tool.canInstall ? "" : "disabled"}>${action}</button></div>
    </section>`;
  }).join("");
  stagger([...$("#diagnostic-tools").children], 0.06);

  const bridgeSeen = data.bridge.lastSeen && !data.bridge.lastSeen.startsWith("0001-");
  $("#diagnostic-connections").innerHTML =
    diagnosticRow("ok", "Локальний сервер", "Панель відповідає", "Активний") +
    diagnosticRow(data.online ? "ok" : "warning", "Перевірка оновлень", data.online ? "Сервери оновлень доступні" : "Сервери оновлень не відповідають", data.online ? "Онлайн" : "Офлайн") +
    diagnosticRow(data.bridge.status, "Firefox-міст", data.bridge.message, bridgeSeen ? formatTime(data.bridge.lastSeen) : "Не бачу");
  const folderRows = data.folders.map(folder => diagnosticRow(folder.status, folder.name, folder.message, folder.writable ? "Запис є" : "Перевірити")).join("");
  const diskValue = data.disk.totalBytes ? `${formatBytes(data.disk.freeBytes)} вільно` : "—";
  $("#diagnostic-storage").innerHTML = folderRows + diagnosticRow(data.disk.status, "Диск", data.disk.path || data.disk.message, diskValue);
}

function renderBridgeStatus(bridge) {
  currentBridge = bridge;
  const connected = Boolean(bridge.connected);
  const outdated = Boolean(bridge.updateAvailable);

  $("#bridge-dot").className = `dot ${connected && !outdated ? "ok" : connected ? "warning" : "error"}`;
  $("#bridge-chip-text").textContent = connected ? (outdated ? "стара версія розширення" : `міст v${bridge.version || bridge.bundledVersion}`) : "не підключено";

  const card = $("#bridge-setup-card");
  card.classList.toggle("connected", connected && !outdated);
  $("#bridge-setup-title").textContent = outdated ? "Онови розширення Firefox" : connected ? "Firefox підключений" : "Підключення Firefox";
  $("#bridge-setup-message").textContent = bridge.message;
  $("#bridge-manifest-path").textContent = bridge.manifestPath || "Файли ще не підготовлені";
  const pill = $("#bridge-version-pill");
  pill.className = `pill ${outdated || !connected ? "warning" : "ok"}`;
  pill.textContent = connected ? `v${bridge.version || "?"}${outdated ? ` → v${bridge.bundledVersion}` : ""}` : `доступна v${bridge.bundledVersion}`;
  $("#install-extension").lastChild.textContent = outdated ? "Оновити розширення" : connected ? "Перезавантажити" : "Підключити Firefox";
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

$("#copy-extension-path").addEventListener("click", async () => {
  try {
    const path = currentBridge?.manifestPath || await prepareExtension();
    try { await navigator.clipboard.writeText(path); toast("Шлях до manifest.json скопійовано"); }
    catch (_) { toast(path); }
  } catch (error) { toast(error.message, "error"); }
});

$("#install-extension").addEventListener("click", async () => {
  const button = $("#install-extension");
  button.disabled = true;
  try {
    const result = await api("/api/extension/setup", {method: "POST"});
    currentBridge = {...(currentBridge || {}), prepared: true, manifestPath: result.manifestPath, bundledVersion: result.version};
    try { await navigator.clipboard.writeText(result.manifestPath); } catch (_) {}
    $("#bridge-manifest-path").textContent = result.manifestPath;
    toast("У Firefox натисни Load Temporary Add-on і вибери manifest.json");
    setTimeout(syncBridge, 3000);
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
});

$("#bridge-chip").addEventListener("click", () => { showPage("diagnostics"); loadDiagnostics(true); });

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-update-tool]");
  if (!button) return;
  const tool = button.dataset.updateTool;
  button.disabled = true;
  button.textContent = tool === "ffmpeg" ? "Завантажую FFmpeg…" : "Оновлюю yt-dlp…";
  try {
    await api("/api/diagnostics/update", {method: "POST", body: JSON.stringify({tool})});
    toast(`${tool === "ffmpeg" ? "FFmpeg" : "yt-dlp"} готовий`);
    await loadDiagnostics(true);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = "Спробувати знову";
  }
});

$("#refresh-diagnostics").addEventListener("click", () => loadDiagnostics(true));

// Панель тепер живе без консолі, тож вимикається звідси. Активне
// завантаження обривається, але задача лишається в черзі й продовжиться
// після наступного запуску.
$("#shutdown-panel").addEventListener("click", async () => {
  if (!confirm("Вимкнути панель? Поточне завантаження зупиниться й продовжиться після наступного запуску.")) return;
  try {
    await api("/api/shutdown", {method: "POST"});
    events.close();
    document.body.innerHTML = '<main style="display:grid;place-items:center;height:100vh;color:#a1a1aa;font:15px Geist,system-ui,sans-serif;text-align:center">Панель вимкнено.<br>Запусти hls-grabber-web.cmd, щоб відкрити знову.</main>';
  } catch (error) {
    toast(`Не вдалося вимкнути: ${error.message}`, "error");
  }
});

// ── Дії з чергою ─────────────────────────────────────────────────────────

async function queueAction(id, action) {
  await api("/api/queue/action", {method: "POST", body: JSON.stringify({id, action})});
  await syncQueue();
}

$("#queue-jobs").addEventListener("click", async event => {
  const button = event.target.closest("[data-job-action]");
  if (!button) return;
  const row = button.closest("[data-job-id]");
  if (button.dataset.jobAction === "remove") {
    await animate(row, {opacity: 0, x: 24}, {duration: 0.18});
  }
  try { await queueAction(row.dataset.jobId, button.dataset.jobAction); }
  catch (error) { toast(error.message, "error"); }
});

$("#history-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-job-action]");
  if (!button) return;
  const row = button.closest("[data-job-id]");
  try {
    await animate(row, {opacity: 0, x: -16}, {duration: 0.18});
    await queueAction(row.dataset.jobId, button.dataset.jobAction);
    toast("Повернено в чергу");
  } catch (error) { toast(error.message, "error"); renderHistory(); }
});

$("#history-filter").addEventListener("click", event => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  historyFilter = button.dataset.filter;
  $$("#history-filter [data-filter]").forEach(node => node.classList.toggle("active", node === button));
  movePill($("#history-filter"));
  renderHistory();
});

$("#clear-history").addEventListener("click", async () => {
  try { await api("/api/queue/completed", {method: "DELETE"}); await syncQueue(); toast("Історію очищено"); }
  catch (error) { toast(error.message, "error"); }
});

$("#pause").addEventListener("click", async () => {
  try { await api(paused ? "/api/resume" : "/api/pause", {method: "POST"}); setPaused(!paused); }
  catch (error) { toast(error.message, "error"); }
});

// «Стоп» скасовує саму задачу черги, а не лише процес yt-dlp: інакше черга
// сприйняла б убитий процес за мережевий збій і пішла б по дзеркалах.
$("#cancel").addEventListener("click", async () => {
  try {
    if (runningJob) await queueAction(runningJob.id, "cancel");
    else await api("/api/cancel", {method: "POST"});
    setPaused(false);
    toast("Завантаження зупинено");
  } catch (error) { toast(error.message, "error"); }
});

$("#queue-stop").addEventListener("click", async () => {
  try { await api("/api/queue/stop-all", {method: "POST"}); await syncQueue(); toast("Чергу зупинено"); }
  catch (error) { toast(error.message, "error"); }
});

// ── Черга на вузькому екрані ─────────────────────────────────────────────

function setDock(open) {
  $("#dock").classList.toggle("open", open);
  $("#scrim").classList.toggle("show", open);
}
$("#mini-player").addEventListener("click", () => setDock(true));
$("#dock-close").addEventListener("click", () => setDock(false));
$("#scrim").addEventListener("click", () => setDock(false));
document.addEventListener("keydown", event => { if (event.key === "Escape") setDock(false); });

// ── Запуск ───────────────────────────────────────────────────────────────

$$(".nav__item").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));
$$("#tab-switch [data-tab]").forEach(button => button.addEventListener("click", () => setTab(button.dataset.tab)));
$$("[data-mode]").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
$$("[data-source]").forEach(button => button.addEventListener("click", () => setSource(button.dataset.source)));

const events = new EventSource("/api/events");
events.onmessage = event => renderProgress(JSON.parse(event.data));
events.onerror = () => { $("#server-dot").className = "dot error"; $("#server-text").textContent = "перепідключаюсь…"; };
events.onopen = () => { $("#server-dot").className = "dot ok"; $("#server-text").textContent = "працює локально"; };

setMode("movie");
setTab("site");
refreshPills(document);
// Ширина кнопок залежить від шрифту: поки Geist вантажиться, повзунки
// виміряні під запасний шрифт і стоять криво.
document.fonts?.ready.then(() => refreshPills(document));
window.addEventListener("resize", () => refreshPills(document));

Promise.all([loadConfig(), api("/api/status"), syncInbox({notify: false})])
  .then(([, status]) => { if (status.progress?.status) renderProgress(status.progress); })
  .catch(error => toast(error.message, "error"));
syncQueue();
syncBridge();
updateSteps();
setInterval(() => syncInbox(), 1500);
setInterval(syncQueue, 1500);
setInterval(syncBridge, 10000);

// Підсвітка під курсором: одна делегована обробка на весь документ.
document.addEventListener("pointermove", event => {
  const card = event.target.closest?.(".glow");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
  card.style.setProperty("--my", `${event.clientY - rect.top}px`);
}, {passive: true});

// Озвучки й адреса живуть у сеансі на сервері, тож після перезавантаження
// сторінки людина бачить, де зупинилась, а не порожній перший крок.
api("/api/bridge/session").then(session => {
  if (!session?.command) return;
  probeURL = session.command.url || "";
  if (probeURL && !$("#probe-url").value) $("#probe-url").value = probeURL;
  renderProbe(session);
  if (["queued", "running"].includes(session.state)) startProbePolling();
}).catch(() => {});

// Перша поява: панель «збирається» з кількох шарів, а не вискакує цілою.
stagger([$(".rail"), $("#library-page .page-head"), ...$$("#library-page .step"), $(".save-card"), $(".dock")], 0.05);
