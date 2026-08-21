package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"hls-grabber/internal/config"
)

const (
	ytdlpReleaseAPI  = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
	ytdlpBinaryURL   = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
	ytdlpHashesURL   = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS"
	ffmpegVersionURL = "https://www.gyan.dev/ffmpeg/builds/release-version"
	ffmpegArchiveURL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
	ffmpegHashURL    = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256"
)

type diagnosticsSnapshot struct {
	CheckedAt time.Time          `json:"checkedAt"`
	Online    bool               `json:"online"`
	Tools     []toolDiagnostic   `json:"tools"`
	Folders   []folderDiagnostic `json:"folders"`
	Disk      diskDiagnostic     `json:"disk"`
	Bridge    bridgeDiagnostic   `json:"bridge"`
	ToolsDir  string             `json:"toolsDir"`
}

type toolDiagnostic struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Status          string `json:"status"`
	Version         string `json:"version,omitempty"`
	Latest          string `json:"latest,omitempty"`
	Path            string `json:"path"`
	Managed         bool   `json:"managed"`
	UpdateAvailable bool   `json:"updateAvailable"`
	CanInstall      bool   `json:"canInstall"`
	Message         string `json:"message"`
}

type folderDiagnostic struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Status   string `json:"status"`
	Writable bool   `json:"writable"`
	Message  string `json:"message"`
}

type diskDiagnostic struct {
	Status     string `json:"status"`
	Path       string `json:"path"`
	FreeBytes  uint64 `json:"freeBytes"`
	TotalBytes uint64 `json:"totalBytes"`
	Message    string `json:"message"`
}

type bridgeDiagnostic struct {
	Connected       bool      `json:"connected"`
	Status          string    `json:"status"`
	LastSeen        time.Time `json:"lastSeen,omitempty"`
	Version         string    `json:"version,omitempty"`
	BundledVersion  string    `json:"bundledVersion"`
	UpdateAvailable bool      `json:"updateAvailable"`
	Prepared        bool      `json:"prepared"`
	ManifestPath    string    `json:"manifestPath"`
	Message         string    `json:"message"`
}

func (s *server) diagnostics(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	cfg := *s.cfg
	s.mu.Unlock()

	toolsDir, err := managedToolsDir()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	ytdlpLatest, ytdlpLatestErr := latestYTDLPVersion()
	ffmpegLatest, ffmpegLatestErr := fetchText(ffmpegVersionURL)
	online := ytdlpLatestErr == nil || ffmpegLatestErr == nil

	ytdlp := diagnoseTool("yt-dlp", "yt-dlp", cfg.Paths.YTDLPPath, "--version", toolsDir)
	ytdlp.Latest = strings.TrimSpace(ytdlpLatest)
	ytdlp.CanInstall = !s.dl.IsActive()
	if ytdlp.Status == "ok" && ytdlp.Latest != "" {
		ytdlp.UpdateAvailable = normalizeVersion(ytdlp.Version) != normalizeVersion(ytdlp.Latest)
		if ytdlp.UpdateAvailable {
			ytdlp.Status, ytdlp.Message = "warning", "Доступна нова стабільна версія"
		}
	}
	if ytdlpLatestErr != nil && ytdlp.Status == "ok" {
		ytdlp.Message = "Працює; перевірка оновлення недоступна"
	}

	ffmpegPath := resolveToolExecutable(cfg.Paths.FFmpegPath, "ffmpeg.exe")
	ffmpeg := diagnoseTool("ffmpeg", "FFmpeg", ffmpegPath, "-version", toolsDir)
	ffmpeg.Version = parseFFmpegVersion(ffmpeg.Version)
	ffmpeg.Latest = strings.TrimSpace(ffmpegLatest)
	ffmpeg.CanInstall = !s.dl.IsActive()
	if ffmpeg.Status == "ok" && ffmpeg.Latest != "" {
		if ffmpeg.Managed {
			ffmpeg.UpdateAvailable = !strings.Contains(normalizeVersion(ffmpeg.Version), normalizeVersion(ffmpeg.Latest))
			if ffmpeg.UpdateAvailable {
				ffmpeg.Status, ffmpeg.Message = "warning", "Доступна нова керована стабільна збірка"
			}
		} else {
			ffmpeg.Message = "Зовнішня збірка; можна встановити керовану стабільну копію"
		}
	}
	if ffmpegLatestErr != nil && ffmpeg.Status == "ok" {
		ffmpeg.Message = "Працює; перевірка оновлення недоступна"
	}

	folders := []folderDiagnostic{
		diagnoseFolder("Фільми", cfg.Paths.MoviesDir),
		diagnoseFolder("Серіали", cfg.Paths.SerialsDir),
	}
	diskPath := cfg.Paths.SerialsDir
	if strings.TrimSpace(diskPath) == "" {
		diskPath = cfg.Paths.MoviesDir
	}

	bridgeState := s.currentBridgeStatus()
	bridge := bridgeDiagnostic{Connected: bridgeState.Connected, Status: bridgeState.Status, LastSeen: bridgeState.LastSeen, Version: bridgeState.Version, BundledVersion: bridgeState.BundledVersion, UpdateAvailable: bridgeState.UpdateAvailable, Prepared: bridgeState.Prepared, ManifestPath: bridgeState.ManifestPath, Message: bridgeState.Message}

	writeJSON(w, http.StatusOK, diagnosticsSnapshot{
		CheckedAt: time.Now(), Online: online, Tools: []toolDiagnostic{ytdlp, ffmpeg},
		Folders: folders, Disk: diagnoseDisk(diskPath), Bridge: bridge, ToolsDir: toolsDir,
	})
}

func (s *server) updateDiagnosticTool(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Tool string `json:"tool"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if s.dl.IsActive() {
		writeError(w, http.StatusConflict, errors.New("зупини активне завантаження перед оновленням інструментів"))
		return
	}

	s.updateMu.Lock()
	if s.updateRunning {
		s.updateMu.Unlock()
		writeError(w, http.StatusConflict, errors.New("інше оновлення вже виконується"))
		return
	}
	s.updateRunning = true
	s.updateMu.Unlock()
	defer func() {
		s.updateMu.Lock()
		s.updateRunning = false
		s.updateMu.Unlock()
	}()

	var err error
	switch request.Tool {
	case "yt-dlp":
		err = s.installYTDLP()
	case "ffmpeg":
		err = s.installFFmpeg()
	default:
		err = errors.New("невідомий інструмент")
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tool": request.Tool})
}

func (s *server) bridgeHeartbeat(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Version string `json:"version"`
	}
	_ = json.NewDecoder(r.Body).Decode(&request)
	s.mu.Lock()
	s.lastBridgeSeen = time.Now()
	if strings.TrimSpace(request.Version) != "" {
		s.bridgeVersion = strings.TrimSpace(request.Version)
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) installYTDLP() error {
	toolsDir, err := managedToolsDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(toolsDir, "yt-dlp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	target := filepath.Join(dir, "yt-dlp.exe")
	expected, err := fetchExpectedHash(ytdlpHashesURL, "yt-dlp.exe")
	if err != nil {
		return fmt.Errorf("не вдалося отримати контрольну суму yt-dlp: %w", err)
	}
	if err := downloadVerified(ytdlpBinaryURL, target+".new", expected); err != nil {
		return err
	}
	if _, err := commandOutput(target+".new", "--version"); err != nil {
		_ = os.Remove(target + ".new")
		return fmt.Errorf("нова копія yt-dlp не запускається: %w", err)
	}
	if err := replaceFile(target+".new", target); err != nil {
		return err
	}
	return s.useManagedTool("yt-dlp", target)
}

func (s *server) installFFmpeg() error {
	toolsDir, err := managedToolsDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(toolsDir, 0o755); err != nil {
		return err
	}
	expected, err := fetchExpectedHash(ffmpegHashURL, "")
	if err != nil {
		return fmt.Errorf("не вдалося отримати контрольну суму FFmpeg: %w", err)
	}
	archivePath := filepath.Join(toolsDir, "ffmpeg-release-essentials.zip.new")
	if err := downloadVerified(ffmpegArchiveURL, archivePath, expected); err != nil {
		return err
	}
	defer os.Remove(archivePath)

	staging := filepath.Join(toolsDir, ".ffmpeg-new")
	_ = os.RemoveAll(staging)
	if err := extractFFmpegBinaries(archivePath, filepath.Join(staging, "bin")); err != nil {
		return err
	}
	newExe := filepath.Join(staging, "bin", "ffmpeg.exe")
	if _, err := commandOutput(newExe, "-version"); err != nil {
		return fmt.Errorf("нова копія FFmpeg не запускається: %w", err)
	}

	target := filepath.Join(toolsDir, "ffmpeg")
	backup := target + ".old"
	_ = os.RemoveAll(backup)
	if _, statErr := os.Stat(target); statErr == nil {
		if err := os.Rename(target, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(staging, target); err != nil {
		_ = os.Rename(backup, target)
		return err
	}
	_ = os.RemoveAll(backup)
	return s.useManagedTool("ffmpeg", filepath.Join(target, "bin"))
}

func (s *server) useManagedTool(tool, path string) error {
	s.mu.Lock()
	next := *s.cfg
	if tool == "yt-dlp" {
		next.Paths.YTDLPPath = path
	} else {
		next.Paths.FFmpegPath = path
	}
	if err := config.Save(next); err != nil {
		s.mu.Unlock()
		return err
	}
	*s.cfg = next
	s.mu.Unlock()
	return nil
}

func managedToolsDir() (string, error) {
	base := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if base == "" {
		var err error
		base, err = os.UserConfigDir()
		if err != nil {
			return "", err
		}
	}
	return filepath.Join(base, "hls-grabber", "tools"), nil
}

func diagnoseTool(id, name, path, versionArg, toolsDir string) toolDiagnostic {
	path = resolveToolExecutable(path, id+".exe")
	result := toolDiagnostic{ID: id, Name: name, Path: path, Status: "error", Message: "Інструмент не знайдено"}
	if path == "" {
		return result
	}
	version, err := commandOutput(path, versionArg)
	if err != nil {
		result.Message = err.Error()
		return result
	}
	result.Status, result.Version, result.Message = "ok", firstLine(version), "Працює нормально"
	managedRoot, _ := filepath.Abs(toolsDir)
	toolPath, _ := filepath.Abs(path)
	result.Managed = strings.HasPrefix(strings.ToLower(toolPath), strings.ToLower(managedRoot+string(os.PathSeparator)))
	return result
}

func resolveToolExecutable(path, executable string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		return filepath.Join(path, executable)
	}
	return path
}

func commandOutput(path string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	if runtime.GOOS == "windows" {
		configureHiddenCommand(cmd)
	}
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return "", errors.New("перевірка перевищила 12 секунд")
	}
	if err != nil {
		return "", fmt.Errorf("%s: %w", strings.TrimSpace(string(output)), err)
	}
	return strings.TrimSpace(string(output)), nil
}

func configureHiddenCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = hiddenWindowAttributes()
}

func latestYTDLPVersion() (string, error) {
	data, err := fetchBytes(ytdlpReleaseAPI)
	if err != nil {
		return "", err
	}
	var release struct {
		Tag string `json:"tag_name"`
	}
	if err := json.Unmarshal(data, &release); err != nil {
		return "", err
	}
	if strings.TrimSpace(release.Tag) == "" {
		return "", errors.New("порожня версія yt-dlp")
	}
	return release.Tag, nil
}

func fetchText(url string) (string, error) {
	data, err := fetchBytes(url)
	return strings.TrimSpace(string(data)), err
}

func fetchBytes(url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "HLS-Grabber-Diagnostics/1.0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}

func fetchExpectedHash(url, filename string) (string, error) {
	text, err := fetchText(url)
	if err != nil {
		return "", err
	}
	return parseExpectedHash(text, filename)
}

func parseExpectedHash(text, filename string) (string, error) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if filename == "" || strings.EqualFold(strings.TrimPrefix(fields[len(fields)-1], "*"), filename) {
			if len(fields[0]) == 64 {
				return strings.ToLower(fields[0]), nil
			}
		}
	}
	return "", errors.New("контрольну суму не знайдено")
}

func downloadVerified(url, target, expected string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "HLS-Grabber-Updater/1.0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("завантаження повернуло HTTP %d", resp.StatusCode)
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(file, hash), resp.Body)
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(target)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(target)
		return closeErr
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		_ = os.Remove(target)
		return errors.New("контрольна сума завантаження не збігається")
	}
	return nil
}

func replaceFile(source, target string) error {
	backup := target + ".old"
	_ = os.Remove(backup)
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(source, target); err != nil {
		_ = os.Rename(backup, target)
		return err
	}
	_ = os.Remove(backup)
	return nil
}

func extractFFmpegBinaries(archivePath, targetBin string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	if err := os.MkdirAll(targetBin, 0o755); err != nil {
		return err
	}
	wanted := map[string]bool{"ffmpeg.exe": false, "ffprobe.exe": false, "ffplay.exe": false}
	for _, entry := range reader.File {
		name := strings.ToLower(filepath.Base(filepath.FromSlash(entry.Name)))
		if _, ok := wanted[name]; !ok || entry.FileInfo().IsDir() {
			continue
		}
		source, err := entry.Open()
		if err != nil {
			return err
		}
		destination, err := os.OpenFile(filepath.Join(targetBin, name), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(destination, source)
		closeDestinationErr := destination.Close()
		closeSourceErr := source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeDestinationErr != nil {
			return closeDestinationErr
		}
		if closeSourceErr != nil {
			return closeSourceErr
		}
		wanted[name] = true
	}
	if !wanted["ffmpeg.exe"] || !wanted["ffprobe.exe"] {
		return errors.New("архів FFmpeg не містить потрібних програм")
	}
	return nil
}

func diagnoseFolder(name, path string) folderDiagnostic {
	result := folderDiagnostic{Name: name, Path: strings.TrimSpace(path), Status: "error", Message: "Папку не налаштовано"}
	if result.Path == "" {
		return result
	}
	info, err := os.Stat(result.Path)
	if err != nil || !info.IsDir() {
		result.Message = "Папку не знайдено"
		return result
	}
	probe, err := os.CreateTemp(result.Path, ".hls-grabber-write-test-")
	if err != nil {
		result.Message = "Немає доступу для запису"
		return result
	}
	probePath := probe.Name()
	_ = probe.Close()
	_ = os.Remove(probePath)
	result.Status, result.Writable, result.Message = "ok", true, "Доступна для запису"
	return result
}

func diagnoseDisk(path string) diskDiagnostic {
	result := diskDiagnostic{Path: strings.TrimSpace(path), Status: "error", Message: "Диск не визначено"}
	if result.Path == "" {
		return result
	}
	pointer, err := windows.UTF16PtrFromString(result.Path)
	if err != nil {
		result.Message = err.Error()
		return result
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(pointer, &free, &total, &totalFree); err != nil {
		result.Message = err.Error()
		return result
	}
	result.FreeBytes, result.TotalBytes = free, total
	result.Status, result.Message = "ok", "Місця достатньо"
	if total > 0 && float64(free)/float64(total) < .1 {
		result.Status, result.Message = "warning", "Залишилося менше 10% диска"
	}
	return result
}

func parseFFmpegVersion(output string) string {
	match := regexp.MustCompile(`(?i)^ffmpeg version\s+([^\s]+)`).FindStringSubmatch(firstLine(output))
	if len(match) > 1 {
		return match[1]
	}
	return firstLine(output)
}

func firstLine(value string) string {
	if index := strings.IndexAny(value, "\r\n"); index >= 0 {
		value = value[:index]
	}
	return strings.TrimSpace(value)
}

func normalizeVersion(value string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "v"))
}
