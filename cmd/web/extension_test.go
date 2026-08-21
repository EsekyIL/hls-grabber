package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	extensionassets "hls-grabber/browser-extension"
)

func TestExportExtensionWritesBundledVersion(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LOCALAPPDATA", root)

	manifestPath, err := exportExtension()
	if err != nil {
		t.Fatalf("export extension: %v", err)
	}
	if filepath.Dir(manifestPath) != filepath.Join(root, "hls-grabber", "browser-extension") {
		t.Fatalf("unexpected extension directory: %s", manifestPath)
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if manifest.Version != extensionassets.Version {
		t.Fatalf("expected version %s, got %s", extensionassets.Version, manifest.Version)
	}
	names, err := extensionFileNames()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if _, err := os.Stat(filepath.Join(filepath.Dir(manifestPath), name)); err != nil {
			t.Fatalf("missing exported file %s: %v", name, err)
		}
	}
}

// Кожен файл, який згадує маніфест, має бути серед вбудованих.
//
// Написано після поломки, що коштувала кількох годин: у go:embed додали
// cdn-api.js, у маніфест його вписали, а в перелік для експорту — ні. Firefox
// не впроваджує групу content scripts, коли бракує хоч одного файлу з неї,
// причому мовчки. Фон працював, попап працював, а будь-яка сторінка
// відповідала «Receiving end does not exist» — і причина здавалась якою
// завгодно: дозволами, антиботом, фоновими вкладками.
func TestManifestFilesAreEmbedded(t *testing.T) {
	raw, err := extensionassets.Files.ReadFile("manifest.json")
	if err != nil {
		t.Fatalf("маніфест не вбудовано: %v", err)
	}

	var manifest struct {
		Background struct {
			Scripts []string `json:"scripts"`
		} `json:"background"`
		ContentScripts []struct {
			JS []string `json:"js"`
		} `json:"content_scripts"`
		WebAccessible []struct {
			Resources []string `json:"resources"`
		} `json:"web_accessible_resources"`
		Action struct {
			Popup string `json:"default_popup"`
		} `json:"action"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("маніфест не розбирається: %v", err)
	}

	var required []string
	required = append(required, manifest.Background.Scripts...)
	for _, entry := range manifest.ContentScripts {
		required = append(required, entry.JS...)
	}
	for _, entry := range manifest.WebAccessible {
		required = append(required, entry.Resources...)
	}
	if manifest.Action.Popup != "" {
		required = append(required, manifest.Action.Popup)
	}

	for _, name := range required {
		if _, err := extensionassets.Files.ReadFile(name); err != nil {
			t.Errorf("%s згаданий у маніфесті, але не вбудований — Firefox мовчки "+
				"не впровадить набір, до якого він належить", name)
		}
	}
}

// Експортуємо рівно те, що вбудовано: саме розходження цих двох переліків і
// було причиною поломки вище.
func TestExportedFilesCoverEmbedded(t *testing.T) {
	names, err := extensionFileNames()
	if err != nil {
		t.Fatal(err)
	}
	have := make(map[string]bool, len(names))
	for _, name := range names {
		have[name] = true
	}
	for _, needed := range []string{"manifest.json", "service-worker.js", "content-script.js", "cdn-api.js", "popup.html", "popup.js", "stay-awake.js"} {
		if !have[needed] {
			t.Errorf("%s не потрапляє в теку для Firefox", needed)
		}
	}
}
