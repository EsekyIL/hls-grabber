package downloader

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"hls-grabber-gui/internal/config"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type Downloader struct {
	cfg *config.Config

	logMu sync.Mutex

	stateMu sync.Mutex
	active  bool
	paused  bool
	cancel  context.CancelFunc
	cmd     *exec.Cmd
	tempDir map[string]struct{}
}

type DownloadStats struct {
	Status          string  `json:"status"`
	Title           string  `json:"title"`
	Message         string  `json:"message"`
	DownloadedBytes int64   `json:"downloadedBytes"`
	TotalBytes      int64   `json:"totalBytes"`
	TotalEstimate   int64   `json:"totalEstimate"`
	SpeedBytes      float64 `json:"speedBytes"`
	SpeedMB         float64 `json:"speedMB"`
	ETASeconds      int64   `json:"etaSeconds"`
	FragmentIndex   int64   `json:"fragmentIndex"`
	FragmentCount   int64   `json:"fragmentCount"`
	Percent         float64 `json:"percent"`
}

const progressPrefix = "__PROGRESS__|"

func New(cfg *config.Config) *Downloader {
	return &Downloader{
		cfg:     cfg,
		tempDir: make(map[string]struct{}),
	}
}

func (d *Downloader) beginDownload(ctx context.Context) (context.Context, func(), error) {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()

	if d.active {
		return nil, nil, errors.New("download is already running")
	}

	runCtx, cancel := context.WithCancel(ctx)
	d.active = true
	d.paused = false
	d.cancel = cancel
	d.cmd = nil

	finish := func() {
		d.stateMu.Lock()
		d.active = false
		d.paused = false
		d.cancel = nil
		d.cmd = nil
		d.stateMu.Unlock()
		cancel()
	}

	return runCtx, finish, nil
}

func (d *Downloader) IsActive() bool {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()

	return d.active
}

func (d *Downloader) Pause() error {
	d.stateMu.Lock()
	if !d.active {
		d.stateMu.Unlock()
		return errors.New("no active download")
	}
	if d.paused {
		d.stateMu.Unlock()
		return nil
	}

	d.paused = true
	cmd := d.cmd
	d.stateMu.Unlock()

	if cmd == nil || cmd.Process == nil {
		d.writeLog("INFO Download pause requested")
		return nil
	}

	if err := suspendProcessTree(cmd.Process.Pid); err != nil {
		d.stateMu.Lock()
		d.paused = false
		d.stateMu.Unlock()
		return err
	}

	d.writeLog("INFO Download paused")
	return nil
}

func (d *Downloader) Resume() error {
	d.stateMu.Lock()
	if !d.active {
		d.stateMu.Unlock()
		return errors.New("no active download")
	}
	if !d.paused {
		d.stateMu.Unlock()
		return nil
	}

	d.paused = false
	cmd := d.cmd
	d.stateMu.Unlock()

	if cmd == nil || cmd.Process == nil {
		d.writeLog("INFO Download resume requested")
		return nil
	}

	if err := resumeProcessTree(cmd.Process.Pid); err != nil {
		return err
	}

	d.writeLog("INFO Download resumed")
	return nil
}

func (d *Downloader) CancelActive() bool {
	d.stateMu.Lock()
	if !d.active {
		d.stateMu.Unlock()
		return false
	}

	cancel := d.cancel
	cmd := d.cmd
	wasPaused := d.paused
	d.paused = false
	d.stateMu.Unlock()

	if cmd != nil && cmd.Process != nil {
		if wasPaused {
			_ = resumeProcessTree(cmd.Process.Pid)
		}
		_ = cmd.Process.Kill()
	}
	if cancel != nil {
		cancel()
	}

	d.writeLog("WARN Active download cancelled")
	return true
}

func (d *Downloader) CleanupActiveTemp() {
	for _, dir := range d.activeTempDirs() {
		if err := removeAllWithRetry(dir); err != nil {
			d.writeLog("WARN failed to remove temp dir " + dir + ": " + err.Error())
		}
		d.unregisterTempDir(dir)
	}
}

func (d *Downloader) DownloadMovie(ctx context.Context, url, title, outputDir string) (err error) {
	defer d.logReturnedError("Movie download", &err)

	ctx, finish, err := d.beginDownload(ctx)
	if err != nil {
		return err
	}
	defer finish()

	outputDir = strings.TrimSpace(outputDir)
	if err := d.cfg.ValidateForMovieDownloadTo(outputDir); err != nil {
		d.emitProgress(ctx, DownloadStats{
			Status:  "error",
			Title:   title,
			Message: err.Error(),
		})
		return err
	}

	if outputDir == "" {
		outputDir = d.cfg.Paths.MoviesDir
	}

	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return err
	}

	safeTitle := sanitizeFilename(title)
	progressTitle := safeTitle
	if progressTitle == "" {
		progressTitle = "Movie"
	}

	finalPath := ""
	if safeTitle != "" {
		finalPath = filepath.Join(outputDir, safeTitle+"."+d.cfg.YTDLP.Container)
	}

	return d.downloadToFinal(ctx, url, progressTitle, finalPath, outputDir)
}

func (d *Downloader) DownloadSeries(ctx context.Context, listName, title, season, startEpisode, outputDir string) (err error) {
	defer d.logReturnedError("Series download", &err)

	ctx, finish, err := d.beginDownload(ctx)
	if err != nil {
		return err
	}
	defer finish()

	outputDir = strings.TrimSpace(outputDir)
	if err := d.cfg.ValidateForSeriesDownloadTo(outputDir); err != nil {
		d.emitProgress(ctx, DownloadStats{
			Status:  "error",
			Title:   title,
			Message: err.Error(),
		})
		return err
	}

	listName = strings.TrimSpace(listName)
	seriesName := sanitizeDirName(title)
	season = strings.TrimSpace(season)
	firstEpisode, err := parseStartEpisode(startEpisode)
	if err != nil {
		return err
	}

	if listName == "" {
		return errors.New("list file is required")
	}
	if seriesName == "" {
		return errors.New("series title is required")
	}
	if season == "" {
		return errors.New("season is required")
	}

	listFile := filepath.Join(d.cfg.Paths.LinksDir, listName)

	file, err := os.Open(listFile)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var urls []string
	for scanner.Scan() {
		url := cleanURL(scanner.Text())
		if url != "" {
			urls = append(urls, url)
		}
	}

	if err := scanner.Err(); err != nil {
		return err
	}

	return d.downloadSeriesURLs(ctx, urls, seriesName, season, firstEpisode, outputDir)
}

func (d *Downloader) DownloadSeriesLinks(ctx context.Context, urls []string, title, season, startEpisode, outputDir string) (err error) {
	defer d.logReturnedError("Series direct download", &err)

	ctx, finish, err := d.beginDownload(ctx)
	if err != nil {
		return err
	}
	defer finish()

	outputDir = strings.TrimSpace(outputDir)
	if err := d.cfg.ValidateForSeriesDirectDownloadTo(outputDir); err != nil {
		d.emitProgress(ctx, DownloadStats{
			Status:  "error",
			Title:   title,
			Message: err.Error(),
		})
		return err
	}

	seriesName := sanitizeDirName(title)
	season = strings.TrimSpace(season)
	firstEpisode, err := parseStartEpisode(startEpisode)
	if err != nil {
		return err
	}

	if seriesName == "" {
		return errors.New("series title is required")
	}
	if season == "" {
		return errors.New("season is required")
	}

	cleaned := make([]string, 0, len(urls))
	for _, url := range urls {
		if cleanedURL := cleanURL(url); cleanedURL != "" {
			cleaned = append(cleaned, cleanedURL)
		}
	}

	return d.downloadSeriesURLs(ctx, cleaned, seriesName, season, firstEpisode, outputDir)
}

func (d *Downloader) downloadSeriesURLs(ctx context.Context, urls []string, seriesName, season string, startEpisode int, outputDir string) error {
	if len(urls) == 0 {
		return errors.New("series URL list is empty")
	}

	if outputDir == "" {
		outputDir = d.cfg.Paths.SerialsDir
	}

	baseDir := filepath.Join(outputDir, seriesName, "Season "+season)
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return err
	}

	episode := startEpisode
	for _, url := range urls {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		episodeTitle := fmt.Sprintf("S%sEP%d", season, episode)
		finalPath := filepath.Join(baseDir, episodeTitle+"."+d.cfg.YTDLP.Container)

		if _, err := os.Stat(finalPath); err == nil {
			d.emitProgress(ctx, DownloadStats{
				Status:  "finished",
				Title:   episodeTitle,
				Message: "Episode already exists",
				Percent: 100,
			})

			d.writeLog("SKIP " + episodeTitle + " already exists: " + finalPath)

			episode++
			continue
		}

		if err := d.downloadToFinal(ctx, url, episodeTitle, finalPath, baseDir); err != nil {
			return err
		}

		episode++
	}

	d.emitProgress(ctx, DownloadStats{
		Status:  "finished",
		Title:   seriesName,
		Message: "Series complete",
		Percent: 100,
	})

	return nil
}

func cleanURL(value string) string {
	value = strings.TrimSpace(value)

	if value == "" || strings.HasPrefix(value, "#") || strings.HasPrefix(value, ";") {
		return ""
	}

	return value
}

func parseStartEpisode(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 1, nil
	}

	episode, err := strconv.Atoi(value)
	if err != nil || episode < 1 {
		return 0, errors.New("start episode must be >= 1")
	}

	return episode, nil
}

func (d *Downloader) downloadToFinal(ctx context.Context, url, title, finalPath, outputDir string) error {
	tempDir, err := createTempWorkDir()
	if err != nil {
		return err
	}
	d.registerTempDir(tempDir)

	defer func() {
		if err := removeAllWithRetry(tempDir); err != nil {
			d.writeLog("WARN failed to remove temp dir " + tempDir + ": " + err.Error())
		}
		d.unregisterTempDir(tempDir)
	}()

	outputTemplate := filepath.Join(tempDir, "temp_%(id)s_%(epoch)s.%(ext)s")

	if err := d.runYTDLP(ctx, url, title, outputTemplate); err != nil {
		return err
	}

	downloadedFile, err := findDownloadedFile(tempDir, d.cfg.YTDLP.Container)
	if err != nil {
		return err
	}

	if finalPath == "" {
		finalPath = filepath.Join(outputDir, filepath.Base(downloadedFile))
	}

	if err := os.MkdirAll(filepath.Dir(finalPath), 0755); err != nil {
		return err
	}

	return moveFile(downloadedFile, finalPath)
}

func (d *Downloader) registerTempDir(path string) {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()

	d.tempDir[path] = struct{}{}
}

func (d *Downloader) unregisterTempDir(path string) {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()

	delete(d.tempDir, path)
}

func (d *Downloader) activeTempDirs() []string {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()

	dirs := make([]string, 0, len(d.tempDir))
	for dir := range d.tempDir {
		dirs = append(dirs, dir)
	}

	return dirs
}

func createTempWorkDir() (string, error) {
	parent := filepath.Join(os.TempDir(), "hls-grabber")

	if err := os.MkdirAll(parent, 0755); err != nil {
		return "", err
	}

	return os.MkdirTemp(parent, "job-")
}

func findDownloadedFile(workDir, container string) (string, error) {
	ext := strings.TrimPrefix(strings.TrimSpace(container), ".")

	files, err := filepath.Glob(filepath.Join(workDir, "temp_*."+ext))
	if err != nil {
		return "", err
	}

	if len(files) == 0 {
		files, err = filepath.Glob(filepath.Join(workDir, "temp_*.*"))
		if err != nil {
			return "", err
		}
	}

	if len(files) == 0 {
		return "", errors.New("no downloaded file found")
	}

	sort.Strings(files)

	return files[0], nil
}

func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}

	out, err := os.Create(dst)
	if err != nil {
		_ = in.Close()
		return err
	}

	_, copyErr := io.Copy(out, in)

	closeOutErr := out.Close()
	closeInErr := in.Close()

	if copyErr != nil {
		_ = os.Remove(dst)
		return copyErr
	}

	if closeOutErr != nil {
		_ = os.Remove(dst)
		return closeOutErr
	}

	if closeInErr != nil {
		_ = os.Remove(dst)
		return closeInErr
	}

	_ = removeWithRetry(src)
	return nil
}

func removeWithRetry(path string) error {
	var lastErr error

	for i := 0; i < 20; i++ {
		err := os.Remove(path)
		if err == nil || os.IsNotExist(err) {
			return nil
		}

		lastErr = err
		time.Sleep(250 * time.Millisecond)
	}

	return lastErr
}

func removeAllWithRetry(path string) error {
	var lastErr error

	for i := 0; i < 20; i++ {
		err := os.RemoveAll(path)
		if err == nil {
			return nil
		}

		lastErr = err
		time.Sleep(250 * time.Millisecond)
	}

	return lastErr
}

func (d *Downloader) runYTDLP(ctx context.Context, url, title, outputTemplate string) error {
	fragments := d.cfg.YTDLP.ConcurrentFragments
	if fragments < 1 {
		fragments = 1
	}

	args := []string{
		"--newline",
		"--progress-template", progressPrefix + "%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s",
		"--ffmpeg-location", d.cfg.Paths.FFmpegPath,
	}

	if d.cfg.YTDLP.SafeMode || !d.cfg.YTDLP.Continue {
		args = append(args, "--no-continue")
	} else {
		args = append(args, "--continue")
	}

	if !d.cfg.YTDLP.SafeMode && d.cfg.YTDLP.HLSUseMPEGTS {
		args = append(args, "--hls-use-mpegts")
	}

	if d.cfg.YTDLP.CookiesFromBrowser != "" {
		args = append(args, "--cookies-from-browser", d.cfg.YTDLP.CookiesFromBrowser)
	}

	args = append(
		args,
		"-N", fmt.Sprint(fragments),
		"--concurrent-fragments", fmt.Sprint(fragments),
		"--retries", fmt.Sprint(d.cfg.YTDLP.Retries),
		"--fragment-retries", fmt.Sprint(d.cfg.YTDLP.FragmentRetries),
		"--merge-output-format", d.cfg.YTDLP.Container,
		"-o", outputTemplate,
		url,
	)

	cmd := exec.CommandContext(ctx, d.cfg.Paths.YTDLPPath, args...)
	configureCommand(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	d.emitProgress(ctx, DownloadStats{
		Status:  "starting",
		Title:   title,
		Message: "Preparing download",
	})

	d.writeLog("START " + title + " " + url)

	if err := cmd.Start(); err != nil {
		d.emitProgress(ctx, DownloadStats{
			Status:  "error",
			Title:   title,
			Message: err.Error(),
		})

		d.writeLog("ERROR " + title + " " + err.Error())

		return err
	}
	if err := d.setActiveCommand(cmd); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	defer d.clearActiveCommand(cmd)

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		d.readProgressStream(ctx, stdout, title)
	}()

	go func() {
		defer wg.Done()
		d.copyStream(stderr, os.Stderr, title)
	}()

	err = cmd.Wait()
	wg.Wait()

	if err != nil {
		d.emitProgress(ctx, DownloadStats{
			Status:  "error",
			Title:   title,
			Message: err.Error(),
		})

		d.writeLog("ERROR " + title + " " + err.Error())

		return err
	}

	d.emitProgress(ctx, DownloadStats{
		Status:  "finished",
		Title:   title,
		Message: "Download complete",
		Percent: 100,
	})

	d.writeLog("DONE " + title)

	return nil
}

func (d *Downloader) emitProgress(ctx context.Context, stats DownloadStats) {
	runtime.EventsEmit(ctx, "download:progress", stats)
}

func (d *Downloader) setActiveCommand(cmd *exec.Cmd) error {
	d.stateMu.Lock()
	d.cmd = cmd
	paused := d.paused
	d.stateMu.Unlock()

	if paused && cmd.Process != nil {
		return suspendProcessTree(cmd.Process.Pid)
	}

	return nil
}

func (d *Downloader) clearActiveCommand(cmd *exec.Cmd) {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()

	if d.cmd == cmd {
		d.cmd = nil
	}
}

func (d *Downloader) readProgressStream(ctx context.Context, reader io.Reader, title string) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()

		if stats, ok := parseProgressLine(line, title); ok {
			d.emitProgress(ctx, stats)
			continue
		}

		fmt.Fprintln(os.Stdout, line)
	}
}

func (d *Downloader) copyStream(reader io.Reader, writer io.Writer, title string) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()

		fmt.Fprintln(writer, line)
		d.writeLog("YTDLP " + title + " " + line)
	}
}

func (d *Downloader) writeLog(message string) {
	logPath := strings.TrimSpace(d.cfg.Paths.LogFile)
	if logPath == "" {
		logPath = config.DefaultLogFile()
		d.cfg.Paths.LogFile = logPath
	}

	d.logMu.Lock()
	defer d.logMu.Unlock()

	level, text := classifyLogMessage(message)
	_ = config.AppendLog(logPath, level, text)
}

func (d *Downloader) logReturnedError(scope string, err *error) {
	if err == nil || *err == nil {
		return
	}

	d.writeLog("ERROR " + scope + ": " + (*err).Error())
}

func classifyLogMessage(message string) (string, string) {
	text := strings.TrimSpace(message)
	upper := strings.ToUpper(text)

	for _, level := range []string{"ERROR", "WARN", "INFO"} {
		if upper == level {
			return level, ""
		}
		if strings.HasPrefix(upper, level+" ") {
			return level, strings.TrimSpace(text[len(level):])
		}
	}

	if strings.Contains(upper, "ERROR:") || strings.Contains(upper, "ERROR ") {
		return "ERROR", text
	}
	if strings.Contains(upper, "WARNING:") || strings.Contains(upper, "WARN ") {
		return "WARN", text
	}

	return "INFO", text
}

func parseProgressLine(line, title string) (DownloadStats, bool) {
	if !strings.HasPrefix(line, progressPrefix) {
		return DownloadStats{}, false
	}

	parts := strings.Split(line, "|")
	if len(parts) != 8 {
		return DownloadStats{}, false
	}

	stats := DownloadStats{
		Status:          "downloading",
		Title:           title,
		DownloadedBytes: parseInt64(parts[1]),
		TotalBytes:      parseInt64(parts[2]),
		TotalEstimate:   parseInt64(parts[3]),
		SpeedBytes:      parseFloat64(parts[4]),
		ETASeconds:      parseInt64(parts[5]),
		FragmentIndex:   parseInt64(parts[6]),
		FragmentCount:   parseInt64(parts[7]),
	}

	if stats.SpeedBytes > 0 {
		stats.SpeedMB = stats.SpeedBytes / (1024 * 1024)
	}

	total := stats.TotalBytes
	if total <= 0 {
		total = stats.TotalEstimate
	}

	if total > 0 && stats.DownloadedBytes > 0 {
		stats.Percent = (float64(stats.DownloadedBytes) / float64(total)) * 100
		if stats.Percent > 100 {
			stats.Percent = 100
		}
	}

	return stats, true
}

func parseInt64(value string) int64 {
	value = strings.TrimSpace(value)

	if value == "" || value == "NA" || value == "None" {
		return 0
	}

	if strings.Contains(value, ".") {
		floatValue, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return 0
		}

		return int64(floatValue)
	}

	intValue, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0
	}

	return intValue
}

func parseFloat64(value string) float64 {
	value = strings.TrimSpace(value)

	if value == "" || value == "NA" || value == "None" {
		return 0
	}

	floatValue, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0
	}

	return floatValue
}

func sanitizeFilename(value string) string {
	replacer := strings.NewReplacer(
		":", "_",
		"/", "_",
		"\\", "_",
		"?", "",
		"\"", "",
		"<", "",
		">", "",
		"|", "",
	)

	return strings.TrimSpace(replacer.Replace(value))
}

func sanitizeDirName(value string) string {
	replacer := strings.NewReplacer(
		":", " ",
		"/", "",
		"\\", "",
		"?", "",
		"\"", "",
		"<", "",
		">", "",
		"|", "",
	)

	return strings.TrimSpace(replacer.Replace(value))
}
