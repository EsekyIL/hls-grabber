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
		Message: "Firefox-перехоплювач не підключений",
	}
	if connected {
		result.Status, result.Message = "ok", "Firefox-перехоплювач підключений"
		result.UpdateAvailable = version != "" && normalizeVersion(version) != normalizeVersion(extensionassets.Version)
		if result.UpdateAvailable {
			result.Status, result.Message = "warning", "У Firefox завантажена стара версія розширення"
		}
	} else if prepared {
		result.Message = "Файли готові; завантаж розширення у Firefox"
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
