package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	extensionassets "hls-grabber/browser-extension"
)

// extensionFileNames — усе, що треба покласти в теку для Firefox.
//
// Береться з вбудованої файлової системи, а не пишеться руками. Раніше це
// був літерал, і він відстав від дійсності: у go:embed з'явились cdn-api.js
// та stay-awake.js, а сюди їх ніхто не дописав. Маніфест вимагав cdn-api.js,
// на диску його не було — і Firefox мовчки відмовлявся впроваджувати ВЕСЬ
// набір content scripts. Ззовні це виглядало як німа сторінка: фон працює,
// попап працює, а на будь-якій сторінці «Receiving end does not exist».
func extensionFileNames() ([]string, error) {
	entries, err := fs.ReadDir(extensionassets.Files, ".")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		names = append(names, entry.Name())
	}
	return names, nil
}

type bridgeStatusData struct {
	Connected       bool      `json:"connected"`
	Status          string    `json:"status"`
	Version         string    `json:"version,omitempty"`
	BundledVersion  string    `json:"bundledVersion"`
	UpdateAvailable bool      `json:"updateAvailable"`
	Prepared        bool      `json:"prepared"`
	ManifestPath    string    `json:"manifestPath"`
	LastSeen        time.Time `json:"lastSeen,omitempty"`
	Message         string    `json:"message"`
}

func (s *server) bridgeStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.currentBridgeStatus())
}

func (s *server) currentBridgeStatus() bridgeStatusData {
	s.mu.Lock()
	lastSeen, version := s.lastBridgeSeen, s.bridgeVersion
	s.mu.Unlock()
	manifestPath, prepared := preparedExtension()
	connected := !lastSeen.IsZero() && time.Since(lastSeen) < 75*time.Second
	result := bridgeStatusData{
		Connected: connected, Status: "warning", Version: version,
		BundledVersion: extensionassets.Version, Prepared: prepared,
		ManifestPath: manifestPath, LastSeen: lastSeen,
		Message: "Розширення не відповідає: встанови його або відкрий Firefox",
	}
	if connected {
		result.Status, result.Message = "ok", "Firefox-перехоплювач підключений"
		result.UpdateAvailable = version != "" && normalizeVersion(version) != normalizeVersion(extensionassets.Version)
		if result.UpdateAvailable {
			result.Status, result.Message = "warning", "У Firefox завантажена стара версія розширення"
		}
	}
	return result
}

func (s *server) prepareExtension(w http.ResponseWriter, _ *http.Request) {
	manifestPath, err := exportExtension()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "manifestPath": manifestPath, "version": extensionassets.Version})
}

func (s *server) openExtensionSetup(w http.ResponseWriter, _ *http.Request) {
	if runtime.GOOS != "windows" {
		writeError(w, http.StatusNotImplemented, errors.New("майстер Firefox зараз доступний лише у Windows"))
		return
	}
	manifestPath, err := exportExtension()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	firefoxPath := findFirefox()
	if firefoxPath == "" {
		writeError(w, http.StatusNotFound, errors.New("Firefox не знайдено; відкрий about:debugging вручну"))
		return
	}
	if err := exec.Command("explorer.exe", "/select,"+manifestPath).Start(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := exec.Command(firefoxPath, "-new-tab", "about:debugging#/runtime/this-firefox").Start(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "manifestPath": manifestPath, "version": extensionassets.Version})
}

func exportExtension() (string, error) {
	dir, err := managedBrowserExtensionDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	names, err := extensionFileNames()
	if err != nil {
		return "", err
	}
	for _, name := range names {
		data, err := extensionassets.Files.ReadFile(name)
		if err != nil {
			return "", err
		}
		target := filepath.Join(dir, name)
		temporary := target + ".new"
		if err := os.WriteFile(temporary, data, 0o644); err != nil {
			return "", err
		}
		if err := replaceFile(temporary, target); err != nil {
			return "", err
		}
	}
	return filepath.Join(dir, "manifest.json"), nil
}

func preparedExtension() (string, bool) {
	dir, err := managedBrowserExtensionDir()
	if err != nil {
		return "", false
	}
	manifestPath := filepath.Join(dir, "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return manifestPath, false
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(data, &manifest) != nil {
		return manifestPath, false
	}
	return manifestPath, normalizeVersion(manifest.Version) == normalizeVersion(extensionassets.Version)
}

func managedBrowserExtensionDir() (string, error) {
	toolsDir, err := managedToolsDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(toolsDir), "browser-extension"), nil
}

func findFirefox() string {
	if path, err := exec.LookPath("firefox.exe"); err == nil {
		return path
	}
	for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
		if strings.TrimSpace(base) == "" {
			continue
		}
		candidates := []string{filepath.Join(base, "Mozilla Firefox", "firefox.exe"), filepath.Join(base, "Programs", "Mozilla Firefox", "firefox.exe")}
		for _, candidate := range candidates {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return ""
}

func extensionSummary(status bridgeStatusData) string {
	if status.Connected {
		return fmt.Sprintf("Firefox %s", status.Version)
	}
	return status.Message
}

// ── Підписане розширення ────────────────────────────────────────────────
//
// Розширення ставиться з підписаного .xpi і далі оновлюється само, за
// update_url з маніфесту. Тимчасове завантаження через about:debugging
// лишається для розробки, але кнопки картки ведуть сюди.

// extensionUpdateURL — update_url із вшитого маніфесту.
func extensionUpdateURL() (string, error) {
	data, err := extensionassets.Files.ReadFile("manifest.json")
	if err != nil {
		return "", err
	}
	var manifest struct {
		Settings struct {
			Gecko struct {
				ID        string `json:"id"`
				UpdateURL string `json:"update_url"`
			} `json:"gecko"`
		} `json:"browser_specific_settings"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", err
	}
	if manifest.Settings.Gecko.UpdateURL == "" {
		return "", errors.New("у маніфесті розширення немає update_url")
	}
	return manifest.Settings.Gecko.UpdateURL, nil
}

// latestExtensionLink читає updates.json і повертає адресу найновішого .xpi.
func latestExtensionLink(client *http.Client, updateURL, id string) (string, string, error) {
	response, err := client.Get(updateURL)
	if err != nil {
		return "", "", fmt.Errorf("не вдалося прочитати список оновлень: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("список оновлень: сервер відповів %d", response.StatusCode)
	}
	var updates struct {
		Addons map[string]struct {
			Updates []struct {
				Version    string `json:"version"`
				UpdateLink string `json:"update_link"`
			} `json:"updates"`
		} `json:"addons"`
	}
	if err := json.NewDecoder(response.Body).Decode(&updates); err != nil {
		return "", "", fmt.Errorf("список оновлень незрозумілий: %w", err)
	}
	var link, version string
	for _, update := range updates.Addons[id].Updates {
		if update.UpdateLink != "" && (version == "" || compareVersions(update.Version, version) > 0) {
			link, version = update.UpdateLink, update.Version
		}
	}
	if link == "" {
		return "", "", errors.New("у списку оновлень ще немає жодної підписаної версії")
	}
	return link, version, nil
}

// compareVersions порівнює «1.13.2» і «1.9.0» за числами, а не як рядки.
func compareVersions(a, b string) int {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(left) || i < len(right); i++ {
		var x, y int
		if i < len(left) {
			fmt.Sscan(left[i], &x)
		}
		if i < len(right) {
			fmt.Sscan(right[i], &y)
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}

func extensionID() string {
	data, _ := extensionassets.Files.ReadFile("manifest.json")
	var manifest struct {
		Settings struct {
			Gecko struct {
				ID string `json:"id"`
			} `json:"gecko"`
		} `json:"browser_specific_settings"`
	}
	_ = json.Unmarshal(data, &manifest)
	return manifest.Settings.Gecko.ID
}

// openInFirefox — дія картки розширення в Діагностиці:
//
//	addons  — about:addons, звідки «Перевірити наявність оновлень»;
//	install — найновіший підписаний .xpi: Firefox сам запропонує встановити.
func (s *server) openInFirefox(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Target string `json:"target"`
	}
	_ = json.NewDecoder(r.Body).Decode(&request)

	firefox := findFirefox()
	if firefox == "" {
		writeError(w, http.StatusNotFound, errors.New("Firefox не знайдено"))
		return
	}

	target, version := "about:addons", ""
	if request.Target == "install" {
		updateURL, err := extensionUpdateURL()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		link, latest, err := latestExtensionLink(&http.Client{Timeout: 15 * time.Second}, updateURL, extensionID())
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		target, version = link, latest
	}

	if err := exec.Command(firefox, "-new-tab", target).Start(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"opened": target, "version": version})
}
