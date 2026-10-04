package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"hls-grabber/internal/config"
	"hls-grabber/internal/downloader"
)

//go:embed webui/*
var webAssets embed.FS

type hub struct {
	mu      sync.Mutex
	clients map[chan downloader.DownloadStats]struct{}
	latest  downloader.DownloadStats
}

func newHub() *hub { return &hub{clients: make(map[chan downloader.DownloadStats]struct{})} }

func (h *hub) publish(stats downloader.DownloadStats) {
	h.mu.Lock()
	h.latest = stats
	for client := range h.clients {
		select {
		case client <- stats:
		default:
		}
	}
	h.mu.Unlock()
}

func (h *hub) snapshot() downloader.DownloadStats {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.latest
}

type server struct {
	cfg            *config.Config
	dl             *downloader.Downloader
	hub            *hub
	queue          *queueManager
	mu             sync.Mutex
	inbox          []inboxItem
	lastBridgeSeen time.Time
	bridgeVersion  string
	// Черга команд у розширення та стан поточного сеансу. Докладно —
	// у bridgecmd.go.
	bridgeQueue   []*bridgeCommand
	bridgeSession bridgeSession
	// Запити свіжих посилань для черги. Докладно — у resolve.go.
	resolveQueue   []*resolveCommand
	resolveWaiters map[string]chan resolveResult
	updateMu       sync.Mutex
	updateRunning  bool
}

// Помилки моста. Окремими змінними, бо їх віддають одразу два обробники, і
// однакові тексти в різних місцях розходяться на першій же правці.
var (
	errBadURL        = errors.New("потрібна адреса сторінки серіалу")
	errNoVoices      = errors.New("вибери хоча б одну озвучку")
	errBridgeOffline = errors.New("Firefox-міст не підключений: відкрий Діагностику")
)

type inboxItem struct {
	URL     string `json:"url"`
	Title   string `json:"title"`
	PageURL string `json:"pageUrl"`
	Voice   string `json:"voice"`
	// TranslatorID — номер озвучки на сайті. Потрібен, щоб черга могла
	// попросити свіжу адресу, коли стара протухне.
	TranslatorID string `json:"translatorId,omitempty"`
	Season       string `json:"season"`
	Episode      string `json:"episode"`
	// Streams — усі якості епізоду з готовими адресами.
	//
	// З'явилось разом з обходом через API сайту: він віддає весь набір
	// одразу, тоді як перехоплення трафіку дає рівно одну адресу — ту, яку
	// плеєр вибрав сам. Порожнє поле означає, що епізод спіймано старим
	// способом, і вибирати нема з чого.
	Streams    []streamOption `json:"streams,omitempty"`
	CapturedAt time.Time      `json:"capturedAt"`
}

// streamOption — одна якість.
type streamOption struct {
	Quality string   `json:"quality"`
	URLs    []string `json:"urls"`
}

type inboxRequest struct {
	URL          string         `json:"url"`
	URLs         []string       `json:"urls"`
	Streams      []streamOption `json:"streams"`
	Title        string         `json:"title"`
	PageURL      string         `json:"pageUrl"`
	Voice        string         `json:"voice"`
	TranslatorID string         `json:"translatorId"`
	Season       string         `json:"season"`
	Episode      string         `json:"episode"`
}

type downloadRequest struct {
	Mode         string         `json:"mode"`
	Source       string         `json:"source"`
	URL          string         `json:"url"`
	URLs         []string       `json:"urls"`
	Mirrors      []string       `json:"mirrors"`
	Items        []downloadItem `json:"items"`
	Title        string         `json:"title"`
	Season       string         `json:"season"`
	StartEpisode string         `json:"startEpisode"`
	OutputDir    string         `json:"outputDir"`
}

type downloadItem struct {
	URL     string   `json:"url"`
	Mirrors []string `json:"mirrors"`
	Voice   string   `json:"voice"`
	Season  string   `json:"season"`
	Episode int      `json:"episode"`
	// Звідки серія і якої якості — щоб черга могла взяти свіжу адресу, коли
	// ця протухне.
	PageURL      string `json:"pageUrl"`
	TranslatorID string `json:"translatorId"`
	Quality      string `json:"quality"`
}

func main() {
	openBrowser := flag.Bool("open", false, "open the web interface")
	port := flag.Int("port", 8787, "local server port")
	flag.Parse()

	// Збірка без консолі (-H=windowsgui) нікуди не показує ні log.Printf, ні
	// log.Fatal. Тому повідомлення самої панелі йдуть і в download.log: файл
	// першим, бо MultiWriter зупиняється на першому ж writer'і з помилкою, а
	// stderr без консолі саме такий.
	log.SetOutput(io.MultiWriter(panelLog{}, os.Stderr))

	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	dl := downloader.New(cfg)
	h := newHub()
	queue, err := newQueueManager(cfg, dl, h.publish)
	if err != nil {
		log.Fatal(err)
	}
	dl.SetProgressSink(queue.progress)
	app := &server{cfg: cfg, dl: dl, hub: h, queue: queue}
	queue.refresh = app.refreshURLs
	queue.start()

	mux := http.NewServeMux()
	app.routes(mux)

	// Go не знає woff2 сам, а на Windows таблиця типів береться з реєстру й
	// буває порожньою. Без явного типу шрифт приходить як octet-stream.
	_ = mime.AddExtensionType(".woff2", "font/woff2")
	assets, err := fs.Sub(webAssets, "webui")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(assets)))

	address := fmt.Sprintf("127.0.0.1:%d", *port)
	url := "http://" + address
	listener, err := net.Listen("tcp", address)
	if err != nil {
		// Без консолі повторний запуск мовчки помирав би на зайнятому порту.
		// Якщо там уже наша панель, просто відкриваємо її.
		if panelRunning(url) {
			_ = openURL(url)
			return
		}
		log.Fatal(err)
	}
	log.Printf("HLS Grabber is ready at %s", url)
	if *openBrowser {
		go func() {
			time.Sleep(250 * time.Millisecond)
			_ = openURL(url)
		}()
	}
	log.Fatal(http.Serve(listener, securityHeaders(mux)))
}

func (s *server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/config", s.getConfig)
	mux.HandleFunc("PUT /api/config", s.saveConfig)
	mux.HandleFunc("GET /api/status", s.getStatus)
	mux.HandleFunc("POST /api/shutdown", s.shutdown)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("POST /api/download", s.startDownload)
	mux.HandleFunc("POST /api/pause", func(w http.ResponseWriter, _ *http.Request) { writeResult(w, s.dl.Pause()) })
	mux.HandleFunc("POST /api/resume", func(w http.ResponseWriter, _ *http.Request) { writeResult(w, s.dl.Resume()) })
	mux.HandleFunc("POST /api/cancel", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"cancelled": s.queue.cancelRunning()})
	})
	mux.HandleFunc("GET /api/inbox", s.getInbox)
	mux.HandleFunc("POST /api/inbox", s.addInbox)
	mux.HandleFunc("DELETE /api/inbox", s.clearInbox)
	mux.HandleFunc("GET /api/queue", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, s.queue.snapshot()) })
	mux.HandleFunc("DELETE /api/queue/completed", func(w http.ResponseWriter, _ *http.Request) { writeResult(w, s.queue.clearFinished()) })
	mux.HandleFunc("POST /api/queue/action", s.queueAction)
	mux.HandleFunc("POST /api/queue/stop-all", func(w http.ResponseWriter, _ *http.Request) { writeResult(w, s.queue.stopAll()) })
	mux.HandleFunc("POST /api/browse-directory", s.browseDirectory)
	mux.HandleFunc("GET /api/diagnostics", s.diagnostics)
	mux.HandleFunc("POST /api/diagnostics/update", s.updateDiagnosticTool)
	mux.HandleFunc("POST /api/bridge/heartbeat", s.bridgeHeartbeat)
	mux.HandleFunc("GET /api/bridge/status", s.bridgeStatus)
	// Канал у зворотний бік: панель наказує, розширення забирає.
	mux.HandleFunc("POST /api/bridge/probe", s.startBridgeProbe)
	mux.HandleFunc("POST /api/bridge/scan", s.startBridgeScan)
	mux.HandleFunc("GET /api/bridge/commands", s.takeBridgeCommands)
	mux.HandleFunc("POST /api/bridge/result", s.reportBridgeResult)
	mux.HandleFunc("GET /api/bridge/session", s.getBridgeSession)
	mux.HandleFunc("GET /api/bridge/resolves", s.takeResolveCommands)
	mux.HandleFunc("POST /api/bridge/resolved", s.reportResolved)
	mux.HandleFunc("POST /api/extension/prepare", s.prepareExtension)
	mux.HandleFunc("POST /api/extension/setup", s.openExtensionSetup)
}

func (s *server) queueAction(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ID     string `json:"id"`
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeResult(w, s.queue.action(request.ID, request.Action))
}

// browseDirectory відкриває рідний діалог вибору теки.
//
// Навіщо взагалі сервер: <input type="file"> у браузері віддає ВМІСТ, а не
// шлях, і теку ним не вибрати зовсім. Але сервер тут локальний і на тій
// самій машині, тож він може показати справжній діалог і повернути шлях.
//
// Тут стояв Shell.Application.BrowseForFolder — те саме вузьке дерево тек із
// дев'яностих, без рядка адреси, без пошуку й без обраного. Сучасний
// провідницький діалог дає FolderBrowserDialog, але лише на .NET Core 3.0+:
// у Windows PowerShell 5.1 (.NET Framework) він малює все те саме старе
// дерево. Тому спершу шукаємо pwsh.
func (s *server) browseDirectory(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Current string `json:"current"`
	}
	_ = json.NewDecoder(r.Body).Decode(&request)
	if runtime.GOOS != "windows" {
		writeError(w, http.StatusNotImplemented, errors.New("folder picker is available on Windows only"))
		return
	}

	cmd := exec.Command(powerShell(), "-NoProfile", "-STA", "-Command", folderPickerScript)
	cmd.Env = append(os.Environ(), "HLS_GRABBER_PICKER_PATH="+strings.TrimSpace(request.Current))
	output, err := cmd.Output()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": strings.TrimSpace(string(output))})
}

// powerShell повертає найкращий доступний інтерпретатор.
//
// pwsh (7+) — це .NET Core, а отже сучасний діалог. Якщо його немає,
// лишається вбудований 5.1: діалог буде старим, але вибрати теку можна, і це
// краще за відмову.
func powerShell() string {
	if path, err := exec.LookPath("pwsh"); err == nil {
		return path
	}
	return "powershell.exe"
}

// Шлях, з якого відкривати діалог, передаємо змінною середовища, а не
// підстановкою в текст скрипта: у ньому бувають лапки й одинарні дужки, і
// склеювання рядків тут — пряма дорога до виконання чужого коду.
const folderPickerScript = `
Add-Type -AssemblyName System.Windows.Forms
# Власник поверх усіх вікон: без нього діалог виринає ЗА браузером, і
# виглядає це так, ніби панель зависла.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Виберіть папку для завантажень'
# Лише в .NET Core: у 5.1 такої властивості немає, і звертання до неї
# зупинило б скрипт замість того, щоб просто показати діалог без заголовка.
if ($dialog.PSObject.Properties.Name -contains 'UseDescriptionForTitle') {
    $dialog.UseDescriptionForTitle = $true
}
if ($env:HLS_GRABBER_PICKER_PATH) { $dialog.SelectedPath = $env:HLS_GRABBER_PICKER_PATH }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }
$dialog.Dispose()
$owner.Dispose()
`

// playlistRe має збігатися з PLAYLIST_RE у service-worker.js.
//
// Раніше тут стояла перевірка strings.Contains(url, ".m3u8"), і вона мовчки
// відкидала плейлисти без розширення в шляху — /playlist?type=hls та подібні.
// Розширення їх тепер ловить, і без цієї синхронізації воно ловило б їх
// намарно: сервер однаково викидав би такі адреси на вході.
var playlistRe = regexp.MustCompile(`(?i)\.m3u8([?#]|$)|[?&](type|format|ext)=m3u8|/master([?#]|$)`)

func isPlaylistURL(value string) bool {
	return playlistRe.MatchString(value)
}

func (s *server) getInbox(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, http.StatusOK, append([]inboxItem{}, s.inbox...))
}

func (s *server) addInbox(w http.ResponseWriter, r *http.Request) {
	var request inboxRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	// Знахідка з API сайту приходить набором якостей і без окремої адреси.
	// Кладемо її одним записом: епізод один, і розкладати його на п'ять
	// рядків означало б п'ять завантажень того самого.
	if len(request.Streams) > 0 {
		s.addStreamItem(w, request)
		return
	}

	values := append(request.URLs, request.URL)
	added, skipped := 0, 0
	s.mu.Lock()
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || !isPlaylistURL(value) {
			continue
		}
		duplicate := false
		for _, item := range s.inbox {
			sameEpisode := request.Voice != "" && request.Season != "" && request.Episode != "" &&
				item.Voice == strings.TrimSpace(request.Voice) &&
				item.Season == strings.TrimSpace(request.Season) &&
				item.Episode == strings.TrimSpace(request.Episode)
			if item.URL == value || sameEpisode {
				duplicate = true
				break
			}
		}
		if !duplicate {
			s.inbox = append(s.inbox, inboxItem{URL: value, Title: strings.TrimSpace(request.Title), PageURL: strings.TrimSpace(request.PageURL), Voice: strings.TrimSpace(request.Voice), Season: strings.TrimSpace(request.Season), Episode: strings.TrimSpace(request.Episode), CapturedAt: time.Now()})
			added++
			continue
		}
		// Рахуємо відкинуте, а не мовчимо. Саме тут зникали лінки, коли
		// сканер приписував їх сусідньому епізоду: сорок дев'ять записів
		// замість п'ятдесяти одного, і жодного сліду, де саме поділась
		// різниця. Тепер її видно в відповіді.
		skipped++
	}
	s.lastBridgeSeen = time.Now()
	count := len(s.inbox)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]int{"added": added, "skipped": skipped, "count": count})
}

// addStreamItem зберігає епізод разом з усіма його якостями.
func (s *server) addStreamItem(w http.ResponseWriter, request inboxRequest) {
	best := bestStream(request.Streams)
	if best == "" {
		writeJSON(w, http.StatusOK, map[string]int{"added": 0, "skipped": 1, "count": s.inboxLen()})
		return
	}

	s.mu.Lock()
	for _, item := range s.inbox {
		// Той самий епізод тієї ж озвучки. Порівнюємо саме трійку, а не
		// адресу: у наборі якостей адрес п'ять, і збіг за однією нічого не
		// означав би.
		if item.Voice == request.Voice && item.Season == request.Season && item.Episode == request.Episode &&
			request.Voice != "" && request.Season != "" && request.Episode != "" {
			count := len(s.inbox)
			s.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]int{"added": 0, "skipped": 1, "count": count})
			return
		}
	}
	s.inbox = append(s.inbox, inboxItem{
		URL: best, Streams: request.Streams,
		Title: strings.TrimSpace(request.Title), PageURL: strings.TrimSpace(request.PageURL),
		Voice: strings.TrimSpace(request.Voice), TranslatorID: strings.TrimSpace(request.TranslatorID),
		Season:  strings.TrimSpace(request.Season),
		Episode: strings.TrimSpace(request.Episode), CapturedAt: time.Now(),
	})
	s.lastBridgeSeen = time.Now()
	count := len(s.inbox)
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]int{"added": 1, "skipped": 0, "count": count})
}

func (s *server) inboxLen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.inbox)
}

// bestStream вибирає адресу за замовчуванням — найвищу якість із набору.
//
// Це лише початкове значення: справжній вибір робить людина в панелі, а
// покласти щось у поле URL треба вже зараз, бо на нього дивиться черга
// завантажень.
func bestStream(streams []streamOption) string {
	best, bestScore := "", -1
	for _, option := range streams {
		if len(option.URLs) == 0 {
			continue
		}
		if score := qualityScore(option.Quality); score > bestScore {
			best, bestScore = option.URLs[0], score
		}
	}
	return best
}

// qualityScore перетворює підпис якості на число для порівняння.
//
// «1080p Ultra» має бути вище за «1080p»: висота однакова, тож самих лише
// цифр замало, і слово треба врахувати окремо.
func qualityScore(label string) int {
	digits := 0
	for _, r := range label {
		if r >= '0' && r <= '9' {
			digits = digits*10 + int(r-'0')
		} else if digits > 0 {
			break
		}
	}
	score := digits * 10
	if strings.Contains(strings.ToLower(label), "ultra") {
		score++
	}
	return score
}

func (s *server) clearInbox(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	s.inbox = nil
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) getConfig(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.cfg)
}

func (s *server) saveConfig(w http.ResponseWriter, r *http.Request) {
	var next config.Config
	if err := json.NewDecoder(r.Body).Decode(&next); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	next.Normalize()
	if err := config.Save(next); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.mu.Lock()
	*s.cfg = next
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, next)
}

func (s *server) getStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"active": s.dl.IsActive(), "progress": s.hub.snapshot()})
}

func (s *server) startDownload(w http.ResponseWriter, r *http.Request) {
	var request downloadRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if strings.TrimSpace(request.Title) == "" {
		writeError(w, http.StatusBadRequest, errors.New("title is required"))
		return
	}

	jobs, err := s.queue.enqueue(request)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"queued": len(jobs), "jobs": jobs})
}

func (s *server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errors.New("streaming unavailable"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	client := make(chan downloader.DownloadStats, 8)
	s.hub.mu.Lock()
	s.hub.clients[client] = struct{}{}
	s.hub.mu.Unlock()
	defer func() {
		s.hub.mu.Lock()
		delete(s.hub.clients, client)
		s.hub.mu.Unlock()
	}()

	for {
		select {
		case <-r.Context().Done():
			return
		case stats := <-client:
			data, _ := json.Marshal(stats)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func writeResult(w http.ResponseWriter, err error) {
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func openURL(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

// panelLog дописує повідомлення log у download.log.
type panelLog struct{}

func (panelLog) Write(p []byte) (int, error) {
	if err := config.AppendLog(config.DefaultLogFile(), "INFO", "PANEL "+strings.TrimSpace(string(p))); err != nil {
		return 0, err
	}
	return len(p), nil
}

// panelRunning перевіряє, що на адресі відповідає саме HLS Grabber.
func panelRunning(url string) bool {
	client := http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(url + "/api/status")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

// shutdown вимикає панель із самої панелі: без консолі закрити її більше
// нічим.
//
// Процес yt-dlp вбиваємо, інакше він лишився б сиротою й докачував би
// нікуди. Чергу тримаємо заблокованою до самого виходу, щоб воркер не
// встиг записати вбите завантаження як помилку: у файлі задача лишається
// «running», а при наступному запуску черга поверне її в «pending».
func (s *server) shutdown(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	go func() {
		time.Sleep(200 * time.Millisecond)
		s.queue.mu.Lock()
		s.dl.CancelActive()
		s.dl.CleanupActiveTemp()
		log.Printf("Панель вимкнено з інтерфейсу")
		os.Exit(0)
	}()
}
