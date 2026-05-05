import "./style.css";
import "./app.css";
import logoUrl from "./assets/images/logo.svg";
import downloadIconSvg from "./assets/images/download-ico.svg?raw";
import settingsIconSvg from "./assets/images/settings-ico.svg?raw";
import loggerIconSvg from "./assets/images/logger-ico.svg?raw";
import { BrowseDirectory, BrowseFile, CancelDownload, ClearLog, DownloadMovie, DownloadSeries, DownloadSeriesLinks, GetAppInfo, GetConfig, GetConfigPath, GetLanguages, LogEvent, OpenLogFile, PauseDownload, ReadLog, ResumeDownload, SaveConfig } from "../wailsjs/go/main/App";
import { EventsOn } from "../wailsjs/runtime/runtime";

document.querySelector("#app").innerHTML = `
  <div id="wrapper">
    <div id="nav-block">
      <img id="nav-logo" src="${logoUrl}" alt="Logo" width="32" height="32">
      <button id="download-page-btn" class="is-active" type="button" aria-label="Download">
        <span class="nav-icon" aria-hidden="true">${downloadIconSvg}</span>
      </button>
      <button id="settings-page-btn" type="button" aria-label="Settings">
        <span class="nav-icon" aria-hidden="true">${settingsIconSvg}</span>
      </button>
      <button id="logger-page-btn" type="button" aria-label="Logs">
        <span class="nav-icon" aria-hidden="true">${loggerIconSvg}</span>
      </button>
    </div>
    <div id="content-block">
      <section id="download-page" class="page is-active">
        <div id="switch-block">
          <div class="mode-switch" data-active="movie">
            <button class="mode-switch__btn" type="button" aria-label="Toggle mode">Movie</button>
          </div>
          <div id="app-meta" aria-label="Application info">
            <span id="app-version">v...</span>
            <span id="app-author">by ...</span>
          </div>
        </div>
        <span class="line"></span>
        <div id="work-block">
          <div class="inputs-block">
            <div id="series-source-row" class="series-source is-hidden">
              <span class="series-source__label">Input source</span>
              <div class="series-source__switch" data-source="list">
                <button class="is-active" type="button" data-source-option="list">List file</button>
                <button type="button" data-source-option="direct">Direct links</button>
              </div>
            </div>

            <div id="url-row" class="urls-block">
              <div id="url-label" class="url">URL</div>
              <input id="url-input" type="url" maxlength="2048" placeholder="http://www.example.ua">
            </div>

            <div class="urls-block">
              <div id="title-label" class="url">TITLE</div>
              <input id="title-input" type="text" maxlength="120" placeholder="MAD MAX">
            </div>

            <div id="season-row" class="urls-block is-hidden">
              <div class="url">SEASON</div>
              <input id="season-input" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="1">
            </div>

            <div id="episode-start-row" class="urls-block is-hidden">
              <div class="url">EP START</div>
              <input id="episode-start-input" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="1">
            </div>

            <label id="direct-links-row" class="links-editor is-hidden">
              <span>LINKS</span>
              <textarea id="direct-links-input" spellcheck="false" placeholder="One URL per line"></textarea>
            </label>
          </div>

          <div class="action-block">
            <div class="download-controls">
              <button id="download-btn" type="button">DOWNLOAD</button>
              <button id="pause-download-btn" type="button" disabled>PAUSE</button>
              <button id="stop-download-btn" type="button" disabled>STOP</button>
            </div>
            <div class="path-block">
              <div class="url">SAVE</div>
              <input id="save-path-input" type="text" placeholder="Default folder">
              <button id="browse-path-btn" type="button" aria-label="Browse download folder">...</button>
            </div>
          </div>
        </div>

        <span class="line"></span>
        <div id="stats-block">
          <div class="stat-card">
            <div id="progress-ring" class="stat-ring stat-ring--progress">
              <span id="progress-value">0%</span>
            </div>
            <div class="stat-copy">
              <strong id="progress-title" class="stat-copy__title">Download</strong>
              <span id="progress-meta" class="stat-copy__meta">Waiting</span>
            </div>
          </div>

          <div class="stat-card">
            <div id="segments-ring" class="stat-ring stat-ring--segments" aria-hidden="true"></div>
            <div class="stat-copy">
              <strong class="stat-copy__title">Segments</strong>
              <span id="segments-value" class="stat-copy__value">0 / 0</span>
              <span id="segments-meta" class="stat-copy__meta">HLS fragments</span>
            </div>
          </div>

          <div class="stat-pill">
            <span id="speed-value" class="stat-pill__value">0.00 MB/s</span>
            <span class="stat-pill__label">Speed</span>
          </div>
        </div>
        <span class="line"></span>
        <div id="other-block">
          <p id="download-status">Paste the URL and start the download.</p>
        </div>
      </section>

      <section id="settings-page" class="page">
        <form id="settings-form">
          <div class="settings-header">
            <div>
              <h1>Settings</h1>
              <p id="config-path">Config path</p>
            </div>
            <div class="settings-actions">
              <button id="reload-settings-btn" type="button">RELOAD</button>
              <button id="save-settings-btn" type="submit">SAVE</button>
            </div>
          </div>

          <div class="settings-grid">
            <fieldset class="settings-section settings-section--paths">
              <legend>Paths</legend>
              <label>yt-dlp<span class="setting-path-control"><input data-config-path="paths.yt_dlp_path" type="text" placeholder="C:/tools/yt-dlp.exe"><button type="button" data-browse-file="paths.yt_dlp_path" aria-label="Browse yt-dlp executable">...</button></span></label>
              <label>ffmpeg<span class="setting-path-control"><input data-config-path="paths.ffmpeg_path" type="text" placeholder="C:/tools/ffmpeg/bin"><button type="button" data-browse-config="paths.ffmpeg_path" aria-label="Browse ffmpeg folder">...</button></span></label>
              <label>Movies<span class="setting-path-control"><input data-config-path="paths.movies_dir" type="text" placeholder="C:/Videos/Films"><button type="button" data-browse-config="paths.movies_dir" aria-label="Browse movies folder">...</button></span></label>
              <label>Series<span class="setting-path-control"><input data-config-path="paths.serials_dir" type="text" placeholder="C:/Videos/Serials"><button type="button" data-browse-config="paths.serials_dir" aria-label="Browse series folder">...</button></span></label>
              <label>Links<span class="setting-path-control"><input data-config-path="paths.links_dir" type="text" placeholder="C:/Videos/Links"><button type="button" data-browse-config="paths.links_dir" aria-label="Browse links folder">...</button></span></label>
              <label>Log file<span class="setting-path-control"><input data-config-path="paths.log_file" type="text" placeholder="C:/Videos/download.log"><button type="button" data-browse-file="paths.log_file" aria-label="Browse log file">...</button></span></label>
            </fieldset>

            <fieldset class="settings-section settings-section--options">
              <legend>YTDLP / FFmpeg</legend>
              <label>Max parallel<input data-config-path="download.max_parallel" data-value-type="number" type="text" inputmode="numeric" pattern="[0-9]*"></label>
              <label>Retries<input data-config-path="download.retries" data-value-type="number" type="text" inputmode="numeric" pattern="[0-9]*"></label>
              <label>Retry delay<input data-config-path="download.retry_delay_sec" data-value-type="number" type="text" inputmode="numeric" pattern="[0-9]*"></label>
              <label>Fragments<input data-config-path="yt_dlp.concurrent_fragments" data-value-type="number" type="text" inputmode="numeric" pattern="[0-9]*"></label>
              <label>yt-dlp retries<input data-config-path="yt_dlp.retries" data-value-type="number" type="text" inputmode="numeric" pattern="[0-9]*"></label>
              <label>Fragment retries<input data-config-path="yt_dlp.fragment_retries" data-value-type="number" type="text" inputmode="numeric" pattern="[0-9]*"></label>
              <label>Container<input data-config-path="yt_dlp.container" type="text" maxlength="12" placeholder="mp4"></label>
              <label>Browser cookies
                <div class="setting-select" data-select-path="yt_dlp.cookies_from_browser">
                  <input data-config-path="yt_dlp.cookies_from_browser" type="hidden">
                  <button class="setting-select__trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                    <span>None</span>
                    <i aria-hidden="true"></i>
                  </button>
                  <div class="setting-select__menu" role="listbox">
                    <button class="is-selected" type="button" role="option" data-select-value="">None</button>
                    <button type="button" role="option" data-select-value="chrome">Chrome</button>
                    <button type="button" role="option" data-select-value="edge">Edge</button>
                    <button type="button" role="option" data-select-value="firefox">Firefox</button>
                    <button type="button" role="option" data-select-value="brave">Brave</button>
                    <button type="button" role="option" data-select-value="chromium">Chromium</button>
                    <button type="button" role="option" data-select-value="opera">Opera</button>
                    <button type="button" role="option" data-select-value="vivaldi">Vivaldi</button>
                    <button type="button" role="option" data-select-value="safari">Safari</button>
                  </div>
                </div>
              </label>
              <div class="settings-toggles">
                <label class="settings-toggle">
                  <span>Safe mode</span>
                  <input data-config-path="yt_dlp.safe_mode" data-value-type="boolean" type="checkbox">
                  <i aria-hidden="true"></i>
                </label>
                <label class="settings-toggle">
                  <span>Continue</span>
                  <input data-config-path="yt_dlp.continue" data-value-type="boolean" type="checkbox">
                  <i aria-hidden="true"></i>
                </label>
                <label class="settings-toggle">
                  <span>HLS MPEG-TS</span>
                  <input data-config-path="yt_dlp.hls_use_mpegts" data-value-type="boolean" type="checkbox">
                  <i aria-hidden="true"></i>
                </label>
              </div>
              <label data-i18n="settings.language">Language
                <div class="setting-select" data-select-path="general.language">
                  <input data-config-path="general.language" type="hidden">
                  <button class="setting-select__trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                    <span>Українська</span>
                    <i aria-hidden="true"></i>
                  </button>
                  <div id="language-select-menu" class="setting-select__menu" role="listbox">
                    <button class="is-selected" type="button" role="option" data-select-value="uk">Українська</button>
                    <button type="button" role="option" data-select-value="en">English</button>
                  </div>
                </div>
              </label>
            </fieldset>
          </div>

          <p id="settings-status">Load or save config values.</p>
        </form>
      </section>

      <section id="logger-page" class="page">
        <div id="logger-panel">
          <div class="settings-header logger-header">
            <div>
              <h1>Logs</h1>
              <p id="log-path">Log path</p>
            </div>
            <div class="settings-actions">
              <button id="reload-log-btn" type="button">RELOAD</button>
              <button id="open-log-file-btn" type="button">FILE</button>
              <button id="clear-log-btn" type="button">CLEAR</button>
            </div>
          </div>

          <div id="log-output">Logs are empty.</div>
          <p id="log-status">Open this page to inspect downloader events.</p>
        </div>
      </section>
    </div>
    <div id="app-toast" role="status" aria-live="polite"></div>
    <div id="app-tooltip" role="tooltip"></div>
  </div>
`;

const inputs = document.querySelectorAll("input:not([type='checkbox']):not([type='hidden'])");
const downloadPageButton = document.querySelector("#download-page-btn");
const settingsPageButton = document.querySelector("#settings-page-btn");
const loggerPageButton = document.querySelector("#logger-page-btn");
const downloadPage = document.querySelector("#download-page");
const settingsPage = document.querySelector("#settings-page");
const loggerPage = document.querySelector("#logger-page");
const appVersion = document.querySelector("#app-version");
const appAuthor = document.querySelector("#app-author");
const modeSwitch = document.querySelector(".mode-switch");
const modeButton = document.querySelector(".mode-switch__btn");
const downloadButton = document.querySelector("#download-btn");
const pauseDownloadButton = document.querySelector("#pause-download-btn");
const stopDownloadButton = document.querySelector("#stop-download-btn");
const seriesSourceRow = document.querySelector("#series-source-row");
const seriesSourceSwitch = document.querySelector(".series-source__switch");
const sourceButtons = document.querySelectorAll("[data-source-option]");
const urlRow = document.querySelector("#url-row");
const urlLabel = document.querySelector("#url-label");
const titleLabel = document.querySelector("#title-label");
const urlInput = document.querySelector("#url-input");
const titleInput = document.querySelector("#title-input");
const seasonRow = document.querySelector("#season-row");
const seasonInput = document.querySelector("#season-input");
const episodeStartRow = document.querySelector("#episode-start-row");
const episodeStartInput = document.querySelector("#episode-start-input");
const directLinksRow = document.querySelector("#direct-links-row");
const directLinksInput = document.querySelector("#direct-links-input");
const savePathInput = document.querySelector("#save-path-input");
const browsePathButton = document.querySelector("#browse-path-btn");
const progressRing = document.querySelector("#progress-ring");
const progressValue = document.querySelector("#progress-value");
const progressTitle = document.querySelector("#progress-title");
const progressMeta = document.querySelector("#progress-meta");
const segmentsRing = document.querySelector("#segments-ring");
const segmentsValue = document.querySelector("#segments-value");
const segmentsMeta = document.querySelector("#segments-meta");
const speedValue = document.querySelector("#speed-value");
const downloadStatus = document.querySelector("#download-status");
const settingsForm = document.querySelector("#settings-form");
const reloadSettingsButton = document.querySelector("#reload-settings-btn");
const settingsStatus = document.querySelector("#settings-status");
const configPath = document.querySelector("#config-path");
const reloadLogButton = document.querySelector("#reload-log-btn");
const openLogFileButton = document.querySelector("#open-log-file-btn");
const clearLogButton = document.querySelector("#clear-log-btn");
const logPath = document.querySelector("#log-path");
const logOutput = document.querySelector("#log-output");
const logStatus = document.querySelector("#log-status");
const appToast = document.querySelector("#app-toast");
const appTooltip = document.querySelector("#app-tooltip");
const configInputs = document.querySelectorAll("[data-config-path]");
const configBrowseButtons = document.querySelectorAll("[data-browse-config]");
const configFileBrowseButtons = document.querySelectorAll("[data-browse-file]");
const settingSelects = document.querySelectorAll(".setting-select");
const languageSelectMenu = document.querySelector("#language-select-menu");
let currentConfig = null;
let seriesSource = "list";
let tooltipTimer = null;
let tooltipTarget = null;
let tooltipPointerEvent = null;
let toastTimer = null;
let isDownloading = false;
let isPaused = false;
let isStopping = false;
let languages = [];
let languageLabels = {
  uk: "Українська",
  en: "English",
};
let translations = {};
let currentLanguage = "uk";
let appInfo = null;

const browserCookieLabels = {
  "": "None",
  brave: "Brave",
  chrome: "Chrome",
  chromium: "Chromium",
  edge: "Edge",
  firefox: "Firefox",
  opera: "Opera",
  safari: "Safari",
  vivaldi: "Vivaldi",
};

function t(key, fallback = key) {
  return translations[key] || fallback;
}

function commandLabel(kind) {
  const labels = {
    download: currentLanguage === "uk" ? "СТАРТ" : "START",
    pause: currentLanguage === "uk" ? "ПАУЗА" : "PAUSE",
    resume: currentLanguage === "uk" ? "ДАЛІ" : "RESUME",
    stop: currentLanguage === "uk" ? "СТОП" : "STOP",
  };

  return labels[kind] || kind;
}

function labelForSelect(select, value) {
  if (select.dataset.selectPath === "yt_dlp.cookies_from_browser") {
    return browserCookieLabels[value] || value || "None";
  }
  if (select.dataset.selectPath === "general.language") {
    return languageLabels[value] || value || "Українська";
  }

  return value || "";
}

function setText(selector, key, fallback) {
  const node = document.querySelector(selector);
  if (node) {
    node.textContent = t(key, fallback);
  }
}

function setPlaceholder(selector, key, fallback) {
  const node = document.querySelector(selector);
  if (node) {
    node.placeholder = t(key, fallback);
  }
}

function fitText(node, minSize = 9) {
  if (!node) {
    return;
  }

  const computed = window.getComputedStyle(node);
  const baseSize = Number.parseFloat(node.dataset.baseFontSize || computed.fontSize);
  node.dataset.baseFontSize = String(baseSize);
  node.style.fontSize = `${baseSize}px`;

  let nextSize = baseSize;
  while (nextSize > minSize && node.scrollWidth > node.clientWidth) {
    nextSize -= 0.5;
    node.style.fontSize = `${nextSize}px`;
  }
}

function fitCompactText() {
  [
    modeButton,
    downloadButton,
    pauseDownloadButton,
    stopDownloadButton,
    reloadSettingsButton,
    document.querySelector("#save-settings-btn"),
    reloadLogButton,
    clearLogButton,
    openLogFileButton,
    ...sourceButtons,
    ...document.querySelectorAll(".url"),
    ...document.querySelectorAll(".setting-select__trigger span"),
  ].forEach((node) => fitText(node));
}

const settingDescriptions = {
  "paths.yt_dlp_path": "Файл yt-dlp.exe, який виконує завантаження відео.",
  "paths.ffmpeg_path": "Папка або файл FFmpeg для склеювання і конвертації завантажених фрагментів.",
  "paths.movies_dir": "Папка за замовчуванням для готових фільмів.",
  "paths.serials_dir": "Папка за замовчуванням для готових серіалів.",
  "paths.links_dir": "Папка зі списками посилань для режиму Series / List file.",
  "paths.log_file": "Файл логів. Якщо його немає, програма створить його автоматично.",
  "download.max_parallel": "Максимальна кількість паралельних задач завантаження всередині програми.",
  "download.retries": "Кількість повторних спроб для задач програми після помилки.",
  "download.retry_delay_sec": "Пауза в секундах між повторними спробами програми.",
  "yt_dlp.concurrent_fragments": "Кількість HLS-фрагментів, які yt-dlp качає паралельно.",
  "yt_dlp.retries": "Кількість повторних спроб yt-dlp для загального завантаження.",
  "yt_dlp.fragment_retries": "Кількість повторних спроб yt-dlp для окремого HLS-фрагмента.",
  "yt_dlp.container": "Формат готового файла після склеювання, наприклад mp4 або mkv.",
  "yt_dlp.cookies_from_browser": "Браузер, з якого yt-dlp бере cookies для сайтів з авторизацією.",
  "yt_dlp.safe_mode": "Безпечний режим: вимикає continue і HLS MPEG-TS, але не зменшує паралельні фрагменти.",
  "yt_dlp.continue": "Дозволяє yt-dlp продовжувати частково завантажений файл у межах поточної задачі.",
  "yt_dlp.hls_use_mpegts": "Передає yt-dlp прапор --hls-use-mpegts для HLS-завантажень.",
  "general.language": "Мова інтерфейсу або майбутніх текстових налаштувань.",
};

inputs.forEach((input) => {
  input.addEventListener("focus", function () {
    this.select();
  });

  input.addEventListener("mouseup", function (e) {
    e.preventDefault();
  });
});

configInputs.forEach((input) => {
  input.addEventListener("input", function () {
    if (this.closest(".setting-path-control")) {
      setTooltipTarget(this, this.value);
    }
  });
});

function setTooltipTarget(node, text) {
  if (text) {
    node.dataset.tooltip = text;
  } else {
    delete node.dataset.tooltip;
  }
  node.removeAttribute("title");
}

function positionTooltip(event) {
  const margin = 12;
  appTooltip.style.left = "0px";
  appTooltip.style.top = "0px";

  const rect = appTooltip.getBoundingClientRect();
  let left = event.clientX + margin;
  let top = event.clientY + margin;

  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, event.clientY - rect.height - margin);
  }

  appTooltip.style.left = `${left}px`;
  appTooltip.style.top = `${top}px`;
}

function showTooltip(event) {
  const target = event.target.closest("[data-tooltip]");
  if (!target || !target.dataset.tooltip) {
    return;
  }

  tooltipTarget = target;
  tooltipPointerEvent = event;
  clearTimeout(tooltipTimer);
  tooltipTimer = window.setTimeout(() => {
    if (tooltipTarget !== target) {
      return;
    }

    appTooltip.textContent = target.dataset.tooltip;
    appTooltip.classList.add("is-visible");
    positionTooltip(tooltipPointerEvent);
  }, 2000);
}

function updateTooltipPosition(event) {
  tooltipPointerEvent = event;
  if (appTooltip.classList.contains("is-visible")) {
    positionTooltip(event);
  }
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  tooltipTarget = null;
  tooltipPointerEvent = null;
  appTooltip.classList.remove("is-visible");
}

document.addEventListener("pointerover", showTooltip);
document.addEventListener("pointermove", updateTooltipPosition);
document.addEventListener("pointerout", (event) => {
  if (event.target.closest("[data-tooltip]")) {
    hideTooltip();
  }
});
document.addEventListener("pointerdown", hideTooltip);
document.addEventListener("scroll", hideTooltip, true);

function closeSettingSelects(exceptSelect = null) {
  settingSelects.forEach((select) => {
    if (select === exceptSelect) {
      return;
    }
    select.classList.remove("is-open");
    select.querySelector(".setting-select__trigger")?.setAttribute("aria-expanded", "false");
  });
}

function setSettingSelectValue(select, value) {
  const nextValue = value || "";
  const hiddenInput = select.querySelector("[data-config-path]");
  const triggerText = select.querySelector(".setting-select__trigger span");
  const options = select.querySelectorAll("[data-select-value]");

  if (hiddenInput) {
    hiddenInput.value = nextValue;
  }
  if (triggerText) {
    triggerText.textContent = labelForSelect(select, nextValue);
  }
  options.forEach((option) => {
    const selected = option.dataset.selectValue === nextValue;
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-selected", selected ? "true" : "false");
  });
  window.requestAnimationFrame(fitCompactText);
}

settingSelects.forEach((select) => {
  const trigger = select.querySelector(".setting-select__trigger");
  const options = select.querySelectorAll("[data-select-value]");

  trigger?.addEventListener("click", () => {
    hideTooltip();
    const willOpen = !select.classList.contains("is-open");
    closeSettingSelects(select);
    select.classList.toggle("is-open", willOpen);
    trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });

  options.forEach((option) => {
    option.addEventListener("click", () => {
      setSettingSelectValue(select, option.dataset.selectValue || "");
      if (select.dataset.selectPath === "general.language") {
        setActiveLanguage(option.dataset.selectValue || "uk");
      }
      closeSettingSelects();
    });
  });
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".setting-select")) {
    closeSettingSelects();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSettingSelects();
    hideTooltip();
  }
});

window.addEventListener("error", (event) => {
  const message = event.message || "Unknown frontend error";
  void writeClientLog("ERROR", `Frontend error: ${message}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || String(event.reason || "Unknown promise rejection");
  void writeClientLog("ERROR", `Unhandled frontend rejection: ${reason}`);
});

function applySettingDescriptions() {
  configInputs.forEach((input) => {
    const description = settingDescriptions[input.dataset.configPath];
    if (!description) {
      return;
    }

    const label = input.closest("label");
    if (label) {
      setTooltipTarget(label, description);
    }
    if (!input.closest(".setting-path-control")) {
      setTooltipTarget(input, description);
    }
  });

  configBrowseButtons.forEach((button) => {
    setTooltipTarget(button, "Вибрати папку.");
  });
  configFileBrowseButtons.forEach((button) => {
    setTooltipTarget(button, "Вибрати файл.");
  });
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value || 0));
}

function setRingProgress(node, value) {
  node.style.setProperty("--progress", `${clampPercent(value)}%`);
}

function setStatus(text) {
  downloadStatus.textContent = text;
}

function setDownloadLock(locked, paused = false) {
  isDownloading = locked;
  isPaused = locked && paused;

  downloadPage.classList.toggle("is-downloading", locked);
  modeButton.disabled = locked;
  sourceButtons.forEach((button) => {
    button.disabled = locked;
  });

  downloadButton.disabled = locked;
  pauseDownloadButton.disabled = !locked;
  stopDownloadButton.disabled = !locked;
  pauseDownloadButton.textContent = isPaused ? commandLabel("resume") : commandLabel("pause");
  stopDownloadButton.textContent = commandLabel("stop");
  pauseDownloadButton.classList.toggle("is-paused", isPaused);
}

function setSettingsStatus(text) {
  settingsStatus.textContent = text;
}

function setLogStatus(text) {
  logStatus.textContent = text;
}

function showToast(message, type = "success") {
  clearTimeout(toastTimer);
  appToast.textContent = message;
  appToast.dataset.type = type;
  appToast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    appToast.classList.remove("is-visible");
  }, 2200);
}

async function writeClientLog(level, message) {
  try {
    await LogEvent(level, message);
  } catch (_) {
    // Logging must not break the UI action that reported the problem.
  }
}

function logLineLevel(line) {
  if (/\]\s+ERROR\b|^\s*ERROR\b|ERROR:|ERROR\s/i.test(line)) {
    return "error";
  }
  if (/\]\s+WARN\b|^\s*WARN(?:ING)?\b|WARNING:|WARN\s/i.test(line)) {
    return "warn";
  }
  if (/\]\s+INFO\b|^\s*INFO\b/i.test(line)) {
    return "info";
  }

  return "info";
}

function parseLogLine(line) {
  const levelMatch = line.match(/^(\[[^\]]+\])\s+(INFO|WARN|ERROR)\s*(.*)$/i);
  if (levelMatch) {
    return {
      time: levelMatch[1],
      level: levelMatch[2].toUpperCase(),
      message: levelMatch[3] || "",
    };
  }

  const timeMatch = line.match(/^(\[[^\]]+\])\s*(.*)$/);
  const level = logLineLevel(line).toUpperCase();
  if (timeMatch) {
    return {
      time: timeMatch[1],
      level,
      message: timeMatch[2] || "",
    };
  }

  return {
    time: "",
    level,
    message: line,
  };
}

function renderLog(text) {
  const content = text.trim();
  logOutput.textContent = "";

  if (!content) {
    logOutput.textContent = t("logs.empty", "Logs are empty.");
    return;
  }

  const fragment = document.createDocumentFragment();
  text.replace(/\r\n/g, "\n").split("\n").forEach((line) => {
    const parsed = parseLogLine(line);
    const row = document.createElement("div");
    const level = parsed.level.toLowerCase();
    row.className = `log-line log-line--${level}`;

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = parsed.time;

    const tag = document.createElement("span");
    tag.className = `log-level log-level--${level}`;
    tag.textContent = parsed.level;

    const message = document.createElement("span");
    message.className = "log-message";
    message.textContent = parsed.message || " ";

    row.append(time, tag, message);
    fragment.appendChild(row);
  });

  logOutput.appendChild(fragment);
}

function setPage(pageName) {
  const settingsActive = pageName === "settings";
  const loggerActive = pageName === "logger";
  const downloadActive = pageName === "download";

  hideTooltip();
  closeSettingSelects();
  downloadPage.classList.toggle("is-active", downloadActive);
  settingsPage.classList.toggle("is-active", settingsActive);
  loggerPage.classList.toggle("is-active", loggerActive);
  downloadPageButton.classList.toggle("is-active", downloadActive);
  settingsPageButton.classList.toggle("is-active", settingsActive);
  loggerPageButton.classList.toggle("is-active", loggerActive);

  if (settingsActive) {
    loadSettings();
  }
  if (loggerActive) {
    loadLogs();
  }
}

function setMode(mode) {
  if (isDownloading) {
    showToast(t("status.in_progress", "In progress"), "error");
    return;
  }

  const seriesActive = mode === "series";

  downloadPage.classList.toggle("is-series", seriesActive);
  modeSwitch.dataset.active = mode;
  modeButton.textContent = seriesActive ? t("mode.series", "Series") : t("mode.movie", "Movie");
  seriesSourceRow.classList.toggle("is-hidden", !seriesActive);
  titleLabel.textContent = seriesActive ? t("field.series", "SERIES") : t("field.title", "TITLE");
  urlInput.type = seriesActive ? "text" : "url";
  urlLabel.textContent = seriesActive ? t("field.list", "LIST") : t("field.url", "URL");
  urlInput.placeholder = seriesActive ? t("placeholder.list", "url_list.ini") : t("placeholder.url", "http://www.example.ua");
  titleInput.placeholder = seriesActive ? t("placeholder.series", "Series Name") : t("placeholder.title", "MAD MAX");
  seasonRow.classList.toggle("is-hidden", !seriesActive);
  episodeStartRow.classList.toggle("is-hidden", !seriesActive);
  setSeriesSource(seriesSource);
  updateSavePathPlaceholder();
  setStatus(seriesActive ? t("status.series_ready", "Series mode ready.") : t("status.movie_ready", "Movie mode ready."));
  window.requestAnimationFrame(fitCompactText);
}

function setSeriesSource(source) {
  if (isDownloading) {
    showToast(t("status.in_progress", "In progress"), "error");
    return;
  }

  seriesSource = source;
  seriesSourceSwitch.dataset.source = source;
  sourceButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.sourceOption === source);
  });

  const directActive = modeSwitch.dataset.active === "series" && source === "direct";
  urlRow.classList.toggle("is-hidden", directActive);
  directLinksRow.classList.toggle("is-hidden", !directActive);
  window.requestAnimationFrame(fitCompactText);
}

function defaultSavePath() {
  if (!currentConfig) {
    return "";
  }
  return modeSwitch.dataset.active === "series"
    ? currentConfig.paths?.serials_dir || ""
    : currentConfig.paths?.movies_dir || "";
}

function updateSavePathPlaceholder() {
  const fallback = defaultSavePath();
  savePathInput.placeholder = fallback || t("placeholder.default_folder", "Default folder");
}

function resetStats() {
  progressValue.textContent = "0%";
  progressTitle.textContent = t("stats.download", "Download");
  progressMeta.textContent = t("stats.waiting", "Waiting");
  segmentsValue.textContent = "0 / 0";
  segmentsMeta.textContent = t("stats.fragments", "HLS fragments");
  speedValue.textContent = "0.00 MB/s";
  setRingProgress(progressRing, 0);
  setRingProgress(segmentsRing, 0);
}

function renderProgress(stats) {
  const percent = clampPercent(stats.percent);
  const fragmentCount = Number(stats.fragmentCount || 0);
  const fragmentIndex = Number(stats.fragmentIndex || 0);
  const speed = Number(stats.speedMB || 0);
  const segmentPercent =
    fragmentCount > 0 ? (fragmentIndex / fragmentCount) * 100 : 0;

  progressValue.textContent = `${Math.round(percent)}%`;
  progressTitle.textContent = stats.title || t("stats.download", "Download");
  progressMeta.textContent =
    stats.status === "finished" ? t("status.complete", "Complete") : t("status.in_progress", "In progress");
  segmentsValue.textContent = `${fragmentIndex} / ${fragmentCount}`;
  segmentsMeta.textContent =
    fragmentCount > 0 ? t("stats.fragments", "HLS fragments") : t("status.manifest_wait", "Waiting for manifest");
  speedValue.textContent = `${speed.toFixed(2)} MB/s`;

  setRingProgress(progressRing, percent);
  setRingProgress(segmentsRing, segmentPercent);
}

function renderState(stats) {
  if (stats.status === "starting") {
    progressMeta.textContent = t("status.preparing", "Preparing");
    setStatus(stats.message || t("status.preparing", "Preparing"));
    return;
  }

  if (stats.status === "finished") {
    progressValue.textContent = "100%";
    progressMeta.textContent = t("status.complete", "Complete");
    speedValue.textContent = "0.00 MB/s";
    setRingProgress(progressRing, 100);
    setStatus(stats.message || t("status.complete", "Complete"));
    return;
  }

  if (stats.status === "error") {
    progressMeta.textContent = t("status.failed", "Failed");
    setStatus(stats.message || t("status.failed", "Failed"));
  }
}

function readPath(target, path) {
  return path.split(".").reduce((value, key) => value?.[key], target);
}

function writePath(target, path, value) {
  const keys = path.split(".");
  const lastKey = keys.pop();
  const parent = keys.reduce((node, key) => {
    node[key] ||= {};
    return node[key];
  }, target);
  parent[lastKey] = value;
}

function renderSettings(config) {
  configInputs.forEach((input) => {
    const value = readPath(config, input.dataset.configPath);
    if (input.dataset.valueType === "boolean") {
      input.checked = Boolean(value);
      return;
    }
    const textValue = value ?? "";
    input.value = textValue;
    const customSelect = input.closest(".setting-select");
    if (customSelect) {
      setSettingSelectValue(customSelect, textValue);
    }
    if (input.closest(".setting-path-control")) {
      setTooltipTarget(input, textValue);
    }
  });
  setActiveLanguage(config.general?.language || "uk");
}

function collectSettings() {
  const nextConfig = JSON.parse(JSON.stringify(currentConfig || {}));

  configInputs.forEach((input) => {
    const path = input.dataset.configPath;
    let value = input.value.trim();
    if (input.dataset.valueType === "number") {
      value = Number.parseInt(input.value || "0", 10);
    }
    if (input.dataset.valueType === "boolean") {
      value = input.checked;
    }

    writePath(nextConfig, path, Number.isNaN(value) ? 0 : value);
  });

  return nextConfig;
}

function setLabelText(path, key, fallback) {
  const input = document.querySelector(`[data-config-path="${path}"]`);
  const label = input?.closest("label");
  if (label?.firstChild) {
    label.firstChild.textContent = t(key, fallback);
  }
}

function setActiveLanguage(code) {
  const nextLanguage = languageLabels[code] ? code : "uk";
  const language = languages.find((item) => item.code === nextLanguage);

  currentLanguage = nextLanguage;
  translations = language?.translations || {};
  applyTranslations();
}

function renderLanguageOptions() {
  if (!languageSelectMenu || languages.length === 0) {
    return;
  }

  languageSelectMenu.textContent = "";
  languages.forEach((language) => {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.dataset.selectValue = language.code;
    option.textContent = language.native_name || language.name || language.code;
    option.addEventListener("click", () => {
      const select = option.closest(".setting-select");
      if (select) {
        setSettingSelectValue(select, language.code);
      }
      setActiveLanguage(language.code);
      closeSettingSelects();
    });
    languageSelectMenu.appendChild(option);
  });
}

function applyTranslations() {
  downloadPageButton.setAttribute("aria-label", t("nav.download", "Download"));
  settingsPageButton.setAttribute("aria-label", t("nav.settings", "Settings"));
  loggerPageButton.setAttribute("aria-label", t("nav.logs", "Logs"));

  modeButton.textContent =
    modeSwitch.dataset.active === "series"
      ? t("mode.series", "Series")
      : t("mode.movie", "Movie");
  document.querySelector(".series-source__label").textContent = t("source.label", "Input source");
  document.querySelector('[data-source-option="list"]').textContent = t("source.list", "List file");
  document.querySelector('[data-source-option="direct"]').textContent = t("source.direct", "Direct links");

  urlLabel.textContent = modeSwitch.dataset.active === "series" ? t("field.list", "LIST") : t("field.url", "URL");
  titleLabel.textContent = modeSwitch.dataset.active === "series" ? t("field.series", "SERIES") : t("field.title", "TITLE");
  seasonRow.querySelector(".url").textContent = t("field.season", "SEASON");
  episodeStartRow.querySelector(".url").textContent = t("field.episode_start", "EP START");
  directLinksRow.querySelector("span").textContent = t("field.links", "LINKS");
  document.querySelector(".path-block .url").textContent = t("field.save", "SAVE");
  downloadButton.textContent = commandLabel("download");
  pauseDownloadButton.textContent = isPaused ? commandLabel("resume") : commandLabel("pause");
  stopDownloadButton.textContent = commandLabel("stop");
  reloadSettingsButton.textContent = t("button.reload", "RELOAD");
  document.querySelector("#save-settings-btn").textContent = t("button.save", "SAVE");
  reloadLogButton.textContent = t("button.reload", "RELOAD");
  clearLogButton.textContent = t("button.clear", "CLEAR");
  openLogFileButton.textContent = t("button.file", "FILE");

  progressTitle.textContent = t("stats.download", "Download");
  if (!isDownloading) {
    progressMeta.textContent = t("stats.waiting", "Waiting");
  }
  document.querySelector("#stats-block .stat-card:nth-child(2) .stat-copy__title").textContent = t("stats.segments", "Segments");
  segmentsMeta.textContent = t("stats.fragments", "HLS fragments");
  document.querySelector(".stat-pill__label").textContent = t("stats.speed", "Speed");
  if (appInfo) {
    appAuthor.textContent = `${t("app.by", "by")} ${appInfo.author || "Unknown"}`;
  }

  document.querySelector("#settings-page h1").textContent = t("settings.title", "Settings");
  document.querySelector(".settings-section--paths legend").textContent = t("settings.paths", "Paths");
  document.querySelector(".settings-section--options legend").textContent = t("settings.ytdlp_ffmpeg", "YTDLP / FFmpeg");
  setLabelText("paths.yt_dlp_path", "settings.ytdlp", "yt-dlp");
  setLabelText("paths.ffmpeg_path", "settings.ffmpeg", "ffmpeg");
  setLabelText("paths.movies_dir", "settings.movies", "Movies");
  setLabelText("paths.serials_dir", "settings.series", "Series");
  setLabelText("paths.links_dir", "settings.links", "Links");
  setLabelText("paths.log_file", "settings.log_file", "Log file");
  setLabelText("download.max_parallel", "settings.max_parallel", "Max parallel");
  setLabelText("download.retries", "settings.retries", "Retries");
  setLabelText("download.retry_delay_sec", "settings.retry_delay", "Retry delay");
  setLabelText("yt_dlp.concurrent_fragments", "settings.fragments", "Fragments");
  setLabelText("yt_dlp.retries", "settings.ytdlp_retries", "yt-dlp retries");
  setLabelText("yt_dlp.fragment_retries", "settings.fragment_retries", "Fragment retries");
  setLabelText("yt_dlp.container", "settings.container", "Container");
  setLabelText("yt_dlp.cookies_from_browser", "settings.browser_cookies", "Browser cookies");
  setLabelText("general.language", "settings.language", "Language");
  document.querySelector('[data-config-path="yt_dlp.safe_mode"]').closest("label").querySelector("span").textContent = t("settings.safe_mode", "Safe mode");
  document.querySelector('[data-config-path="yt_dlp.continue"]').closest("label").querySelector("span").textContent = t("settings.continue", "Continue");
  document.querySelector('[data-config-path="yt_dlp.hls_use_mpegts"]').closest("label").querySelector("span").textContent = t("settings.hls_mpegts", "HLS MPEG-TS");

  document.querySelector("#logger-page h1").textContent = t("logs.title", "Logs");
  setPlaceholder("#url-input", modeSwitch.dataset.active === "series" ? "placeholder.list" : "placeholder.url", modeSwitch.dataset.active === "series" ? "url_list.ini" : "http://www.example.ua");
  setPlaceholder("#title-input", modeSwitch.dataset.active === "series" ? "placeholder.series" : "placeholder.title", modeSwitch.dataset.active === "series" ? "Series Name" : "MAD MAX");
  setPlaceholder("#episode-start-input", "placeholder.episode_start", "1");
  setPlaceholder("#direct-links-input", "placeholder.links", "One URL per line");
  updateSavePathPlaceholder();
  window.requestAnimationFrame(fitCompactText);
}

async function loadLanguages() {
  try {
    languages = await GetLanguages();
    languageLabels = Object.fromEntries(
      languages.map((language) => [language.code, language.native_name || language.name || language.code]),
    );
    renderLanguageOptions();
    setActiveLanguage(currentConfig?.general?.language || currentLanguage);
  } catch (error) {
    const message = error?.message || String(error);
    void writeClientLog("ERROR", `Languages load failed: ${message}`);
  }
}

async function loadAppInfo() {
  try {
    const info = await GetAppInfo();
    appInfo = info;
    appVersion.textContent = `v${appInfo.version || "dev"}`;
    appAuthor.textContent = `${t("app.by", "by")} ${appInfo.author || "Unknown"}`;
    setTooltipTarget(appVersion, appInfo.name ? `${appInfo.name} ${appVersion.textContent}` : appVersion.textContent);
    setTooltipTarget(appAuthor, `Author: ${appInfo.author || "Unknown"}`);
  } catch (error) {
    const message = error?.message || String(error);
    void writeClientLog("ERROR", `App info load failed: ${message}`);
  }
}

async function loadSettings({ notify = false } = {}) {
  try {
    const [path, config] = await Promise.all([GetConfigPath(), GetConfig()]);
    currentConfig = config;
    configPath.textContent = path;
    renderSettings(config);
    updateSavePathPlaceholder();
    setSettingsStatus(t("status.config_loaded", "Config loaded."));
    if (notify) {
      showToast(t("status.config_reloaded", "Config reloaded."));
      void writeClientLog("INFO", "Config reloaded from settings page");
    }
  } catch (error) {
    const message = error?.message || String(error);
    setSettingsStatus(message);
    void writeClientLog("ERROR", `Config reload failed: ${message}`);
    if (notify) {
      showToast(message, "error");
    }
  }
}

async function loadLogs({ notify = false } = {}) {
  try {
    const [config, text] = await Promise.all([GetConfig(), ReadLog()]);
    currentConfig = config;

    const path = config.paths?.log_file || "";
    logPath.textContent = path || t("logs.path", "Log path");
    setTooltipTarget(logPath, path);
    renderLog(text);
    logOutput.scrollTop = logOutput.scrollHeight;
    setLogStatus(text.trim() ? t("status.log_loaded", "Log loaded.") : t("status.no_logs", "No log entries yet."));
    if (notify) {
      showToast(t("status.log_loaded", "Log loaded."));
    }
  } catch (error) {
    const message = error?.message || String(error);
    setLogStatus(message);
    void writeClientLog("ERROR", `Log reload failed: ${message}`);
    if (notify) {
      showToast(message, "error");
    }
  }
}

EventsOn("download:progress", (stats) => {
  if (stats.status === "downloading") {
    renderProgress(stats);
    setStatus(
      stats.message ||
        `Downloading ${stats.title || "video"}${stats.etaSeconds ? `, ETA ${stats.etaSeconds}s` : ""}`,
    );
    return;
  }

  renderState(stats);
});

downloadPageButton.addEventListener("click", () => setPage("download"));
settingsPageButton.addEventListener("click", () => setPage("settings"));
loggerPageButton.addEventListener("click", () => setPage("logger"));
sourceButtons.forEach((button) => {
  button.addEventListener("click", () => setSeriesSource(button.dataset.sourceOption));
});

browsePathButton.addEventListener("click", async () => {
  try {
    const selectedPath = await BrowseDirectory(savePathInput.value.trim() || defaultSavePath());
    if (selectedPath) {
      savePathInput.value = selectedPath;
    }
  } catch (error) {
    const message = error?.message || String(error);
    setStatus(message);
    showToast(message, "error");
    void writeClientLog("ERROR", `Download folder browse failed: ${message}`);
  }
});

configBrowseButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const targetInput = document.querySelector(
      `[data-config-path="${button.dataset.browseConfig}"]`,
    );
    if (!targetInput) {
      return;
    }

    try {
      const selectedPath = await BrowseDirectory(targetInput.value.trim());
      if (selectedPath) {
        targetInput.value = selectedPath;
        setTooltipTarget(targetInput, selectedPath);
      }
    } catch (error) {
      const message = error?.message || String(error);
      setSettingsStatus(message);
      showToast(message, "error");
      void writeClientLog("ERROR", `Config folder browse failed: ${message}`);
    }
  });
});

configFileBrowseButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const targetInput = document.querySelector(
      `[data-config-path="${button.dataset.browseFile}"]`,
    );
    if (!targetInput) {
      return;
    }

    try {
      const selectedPath = await BrowseFile(targetInput.value.trim());
      if (selectedPath) {
        targetInput.value = selectedPath;
        setTooltipTarget(targetInput, selectedPath);
      }
    } catch (error) {
      const message = error?.message || String(error);
      setSettingsStatus(message);
      showToast(message, "error");
      void writeClientLog("ERROR", `Config file browse failed: ${message}`);
    }
  });
});

modeButton.addEventListener("click", () => {
  const nextMode = modeSwitch.dataset.active === "movie" ? "series" : "movie";
  setMode(nextMode);
});

pauseDownloadButton.addEventListener("click", async () => {
  if (!isDownloading) {
    return;
  }

  pauseDownloadButton.disabled = true;
  try {
    if (isPaused) {
      await ResumeDownload();
      setDownloadLock(true, false);
      setStatus(t("status.resumed", "Download resumed."));
      showToast(t("status.resumed", "Download resumed."));
      return;
    }

    await PauseDownload();
    setDownloadLock(true, true);
    progressMeta.textContent = t("status.paused", "Paused");
    setStatus(t("status.paused", "Download paused."));
    showToast(t("status.paused", "Download paused."));
  } catch (error) {
    const message = error?.message || String(error);
    setStatus(message);
    showToast(message, "error");
    void writeClientLog("ERROR", `Pause/resume failed: ${message}`);
    setDownloadLock(true, isPaused);
  }
});

stopDownloadButton.addEventListener("click", async () => {
  if (!isDownloading) {
    return;
  }

  stopDownloadButton.disabled = true;
  pauseDownloadButton.disabled = true;
  isStopping = true;
  setStatus(t("status.stopping", "Stopping download..."));

  try {
    await CancelDownload();
    setStatus(t("status.stopped", "Download stopped."));
    showToast(t("status.stopped", "Download stopped."));
  } catch (error) {
    const message = error?.message || String(error);
    setStatus(message);
    showToast(message, "error");
    void writeClientLog("ERROR", `Stop download failed: ${message}`);
  }
});

reloadSettingsButton.addEventListener("click", () => loadSettings({ notify: true }));
reloadLogButton.addEventListener("click", () => loadLogs({ notify: true }));
openLogFileButton.addEventListener("click", async () => {
  try {
    await OpenLogFile();
    setLogStatus(t("status.log_opened", "Log file opened in Explorer."));
    showToast(t("status.log_opened", "Log file opened."));
    void writeClientLog("INFO", "Log file opened in Explorer");
  } catch (error) {
    const message = error?.message || String(error);
    setLogStatus(message);
    showToast(message, "error");
    void writeClientLog("ERROR", `Open log file failed: ${message}`);
  }
});
clearLogButton.addEventListener("click", async () => {
  try {
    await ClearLog();
    await loadLogs();
    setLogStatus(t("status.log_cleared", "Log cleared."));
    showToast(t("status.log_cleared", "Log cleared."));
  } catch (error) {
    const message = error?.message || String(error);
    setLogStatus(message);
    showToast(message, "error");
    void writeClientLog("ERROR", `Log clear failed: ${message}`);
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSettingsStatus(t("status.config_saved", "Saving config..."));

  try {
    await SaveConfig(collectSettings());
    currentConfig = await GetConfig();
    renderSettings(currentConfig);
    setSettingsStatus(t("status.config_saved", "Config saved."));
    showToast(t("status.config_saved", "Config saved."));
  } catch (error) {
    const message = error?.message || String(error);
    setSettingsStatus(message);
    showToast(message, "error");
    void writeClientLog("ERROR", `Config save failed: ${message}`);
  }
});

downloadButton.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  const title = titleInput.value.trim();
  const startEpisode = episodeStartInput.value.trim() || "1";
  const outputDir = savePathInput.value.trim();
  const directLinks = directLinksInput.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"));

  if (modeSwitch.dataset.active === "movie" && !url) {
    setStatus(t("validation.url", "Paste a video URL first."));
    void writeClientLog("WARN", "Movie download blocked: URL is empty");
    urlInput.focus();
    return;
  }

  if (modeSwitch.dataset.active === "series") {
    if (seriesSource === "list" && !url) {
      setStatus(t("validation.list", "Paste a list file name first."));
      void writeClientLog("WARN", "Series download blocked: list file is empty");
      urlInput.focus();
      return;
    }
    if (seriesSource === "direct" && directLinks.length === 0) {
      setStatus(t("validation.links", "Add at least one URL."));
      void writeClientLog("WARN", "Series download blocked: direct links are empty");
      directLinksInput.focus();
      return;
    }
    if (!seasonInput.value.trim()) {
      setStatus(t("validation.season", "Set season number first."));
      void writeClientLog("WARN", "Series download blocked: season is empty");
      seasonInput.focus();
      return;
    }
    if (!/^[1-9][0-9]*$/.test(startEpisode)) {
      setStatus(t("validation.episode_start", "Start episode must be 1 or higher."));
      void writeClientLog("WARN", "Series download blocked: start episode is invalid");
      episodeStartInput.focus();
      return;
    }
  }

  setDownloadLock(true, false);
  resetStats();
  setStatus(t("status.download_starting", "Starting download..."));

  try {
    if (modeSwitch.dataset.active === "movie") {
      await DownloadMovie(url, title, outputDir);
    } else if (seriesSource === "direct") {
      await DownloadSeriesLinks(directLinks, title, seasonInput.value.trim(), startEpisode, outputDir);
    } else {
      await DownloadSeries(url, title, seasonInput.value.trim(), startEpisode, outputDir);
    }
  } catch (error) {
    const message = error?.message || String(error);
    if (isStopping) {
      setStatus(t("status.stopped", "Download stopped."));
    } else {
      setStatus(message);
      showToast(message, "error");
      void writeClientLog("ERROR", `Download failed: ${message}`);
    }
  } finally {
    isStopping = false;
    setDownloadLock(false, false);
  }
});

async function init() {
resetStats();
setDownloadLock(false, false);
applySettingDescriptions();
window.addEventListener("resize", fitCompactText);
  await loadLanguages();
  await loadAppInfo();
  await loadSettings();
}

void init();

