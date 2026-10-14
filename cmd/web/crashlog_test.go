package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Дочірній процес вмикає crash.log і падає; батьківський перевіряє, що звіт
// дійшов у файл, хоч stderr ніхто не читає.
func TestCrashLogCapturesPanic(t *testing.T) {
	if os.Getenv("HLS_CRASH_CHILD") == "1" {
		enableCrashLog()
		panic("перевірка crash.log")
	}

	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=TestCrashLogCapturesPanic")
	cmd.Env = append(os.Environ(), "HLS_CRASH_CHILD=1", "TMPDIR="+dir, "TEMP="+dir, "TMP="+dir)
	if err := cmd.Run(); err == nil {
		t.Fatal("child process was expected to crash")
	}

	data, err := os.ReadFile(filepath.Join(dir, "hls-grabber", "crash.log"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "запуск панелі") || !strings.Contains(text, "перевірка crash.log") || !strings.Contains(text, "goroutine") {
		t.Fatalf("crash.log has no crash report:\n%s", text)
	}
}
