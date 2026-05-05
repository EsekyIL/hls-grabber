package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	_ "embed"

	"hls-grabber-gui/internal/config"
	"hls-grabber-gui/internal/downloader"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed wails.json
var wailsConfigData []byte

// App struct
type App struct {
	ctx        context.Context
	cfg        *config.Config
	downloader *downloader.Downloader
}

type AppInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Author  string `json:"author"`
}

// NewApp creates a new App application struct
func NewApp(cfg *config.Config, dl *downloader.Downloader) *App {
	return &App{cfg: cfg, downloader: dl}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) beforeClose(ctx context.Context) bool {
	if !a.downloader.IsActive() {
		return false
	}

	selection, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "Download is running",
		Message:       "A download is still running. Close the app anyway? Temporary files will be removed.",
		DefaultButton: "No",
		CancelButton:  "No",
	})
	if err != nil || !strings.EqualFold(selection, "Yes") {
		return true
	}

	a.downloader.CancelActive()
	a.downloader.CleanupActiveTemp()
	return false
}

func (a *App) shutdown(ctx context.Context) {
	a.downloader.CancelActive()
	a.downloader.CleanupActiveTemp()
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}

func (a *App) DownloadMovie(url, title, outputDir string) error {
	return a.downloader.DownloadMovie(a.ctx, url, title, outputDir)
}

func (a *App) DownloadSeries(listName, title, season, startEpisode, outputDir string) error {
	return a.downloader.DownloadSeries(a.ctx, listName, title, season, startEpisode, outputDir)
}

func (a *App) DownloadSeriesLinks(urls []string, title, season, startEpisode, outputDir string) error {
	return a.downloader.DownloadSeriesLinks(a.ctx, urls, title, season, startEpisode, outputDir)
}

func (a *App) PauseDownload() error {
	return a.downloader.Pause()
}

func (a *App) ResumeDownload() error {
	return a.downloader.Resume()
}

func (a *App) CancelDownload() bool {
	return a.downloader.CancelActive()
}

func (a *App) GetConfig() config.Config {
	return *a.cfg
}

func (a *App) GetLanguages() []config.Language {
	return config.Languages()
}

func (a *App) GetAppInfo() AppInfo {
	var raw struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Info    struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
		Author struct {
			Name string `json:"name"`
		} `json:"author"`
	}

	info := AppInfo{
		Name:    "HLS Grabber",
		Version: "dev",
		Author:  "Unknown",
	}
	if err := json.Unmarshal(wailsConfigData, &raw); err != nil {
		return info
	}
	if raw.Name != "" {
		info.Name = raw.Name
	}
	if raw.Info.ProductVersion != "" {
		info.Version = raw.Info.ProductVersion
	} else if raw.Version != "" {
		info.Version = raw.Version
	}
	if raw.Author.Name != "" {
		info.Author = raw.Author.Name
	}

	return info
}

func (a *App) SaveConfig(cfg config.Config) error {
	cfg.Normalize()
	if err := config.Save(cfg); err != nil {
		_ = config.AppendLog(a.cfg.Paths.LogFile, "ERROR", "Config save failed: "+err.Error())
		return err
	}
	*a.cfg = cfg
	_ = config.AppendLog(cfg.Paths.LogFile, "INFO", "Config saved")
	return nil
}

func (a *App) GetConfigPath() (string, error) {
	return config.Path()
}

func (a *App) ReadLog() (string, error) {
	logPath := strings.TrimSpace(a.cfg.Paths.LogFile)
	if logPath == "" {
		logPath = config.DefaultLogFile()
		a.cfg.Paths.LogFile = logPath
	}
	if err := config.EnsureLogFile(logPath); err != nil {
		return "", err
	}

	file, err := os.Open(logPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return "", err
	}

	const maxLogBytes int64 = 512 * 1024
	offset := int64(0)
	if info.Size() > maxLogBytes {
		offset = info.Size() - maxLogBytes
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return "", err
		}
	}

	data, err := io.ReadAll(file)
	if err != nil {
		return "", err
	}
	if offset > 0 {
		return "[Showing last 512 KB]\n" + string(data), nil
	}
	return string(data), nil
}

func (a *App) ClearLog() error {
	logPath := strings.TrimSpace(a.cfg.Paths.LogFile)
	if logPath == "" {
		logPath = config.DefaultLogFile()
		a.cfg.Paths.LogFile = logPath
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(logPath, nil, 0644)
}

func (a *App) LogEvent(level, message string) error {
	logPath := strings.TrimSpace(a.cfg.Paths.LogFile)
	if logPath == "" {
		logPath = config.DefaultLogFile()
		a.cfg.Paths.LogFile = logPath
	}

	return config.AppendLog(logPath, level, message)
}

func (a *App) OpenLogFile() error {
	logPath := strings.TrimSpace(a.cfg.Paths.LogFile)
	if logPath == "" {
		logPath = config.DefaultLogFile()
		a.cfg.Paths.LogFile = logPath
	}
	if err := config.EnsureLogFile(logPath); err != nil {
		return err
	}

	return exec.Command("explorer.exe", "/select,"+logPath).Start()
}

func (a *App) BrowseDirectory(defaultDirectory string) (string, error) {
	if info, err := os.Stat(defaultDirectory); err != nil || !info.IsDir() {
		defaultDirectory = ""
	}

	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                "Select download folder",
		DefaultDirectory:     defaultDirectory,
		CanCreateDirectories: true,
	})
}

func (a *App) BrowseFile(currentPath string) (string, error) {
	currentPath = strings.TrimSpace(currentPath)
	defaultDirectory := ""
	if currentPath != "" {
		if info, err := os.Stat(currentPath); err == nil && info.IsDir() {
			defaultDirectory = currentPath
		} else {
			defaultDirectory = filepath.Dir(currentPath)
			if info, err := os.Stat(defaultDirectory); err != nil || !info.IsDir() {
				defaultDirectory = ""
			}
		}
	}

	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "Select file",
		DefaultDirectory: defaultDirectory,
		Filters: []runtime.FileFilter{
			{
				DisplayName: "Executable or log files",
				Pattern:     "*.exe;*.log",
			},
			{
				DisplayName: "All files",
				Pattern:     "*.*",
			},
		},
	})
}
