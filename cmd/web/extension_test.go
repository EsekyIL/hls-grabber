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
	for _, name := range extensionFileNames {
		if _, err := os.Stat(filepath.Join(filepath.Dir(manifestPath), name)); err != nil {
			t.Fatalf("missing exported file %s: %v", name, err)
		}
	}
}
