package downloader

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"hls-grabber/internal/config"
)

func TestParseProgressLine(t *testing.T) {
	line := "__PROGRESS__|5242880|10485760|0|2097152.0|12|8|16"

	stats, ok := parseProgressLine(line, "Mad Max")
	if !ok {
		t.Fatal("expected progress line to be parsed")
	}

	if stats.Status != "downloading" {
		t.Fatalf("unexpected status: %s", stats.Status)
	}
	if stats.Title != "Mad Max" {
		t.Fatalf("unexpected title: %s", stats.Title)
	}
	if stats.DownloadedBytes != 5242880 {
		t.Fatalf("unexpected downloaded bytes: %d", stats.DownloadedBytes)
	}
	if stats.TotalBytes != 10485760 {
		t.Fatalf("unexpected total bytes: %d", stats.TotalBytes)
	}
	if stats.FragmentIndex != 8 || stats.FragmentCount != 16 {
		t.Fatalf("unexpected fragments: %d/%d", stats.FragmentIndex, stats.FragmentCount)
	}
	if stats.Percent != 50 {
		t.Fatalf("unexpected percent: %f", stats.Percent)
	}
	if stats.SpeedMB != 2 {
		t.Fatalf("unexpected speedMB: %f", stats.SpeedMB)
	}
}

func TestParseProgressLineRejectsNonProgress(t *testing.T) {
	if _, ok := parseProgressLine("[download] Destination: file.mp4", "Mad Max"); ok {
		t.Fatal("expected non-progress line to be ignored")
	}
}

func TestUniquePathKeepsExistingFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Film.mp4")
	if got := uniquePath(path); got != path {
		t.Fatalf("free path changed: %s", got)
	}
	for _, name := range []string{"Film.mp4", "Film (2).mp4"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got, want := uniquePath(path), filepath.Join(dir, "Film (3).mp4"); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestErrorReason(t *testing.T) {
	cases := map[string]string{
		"ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden": "Unable to download webpage: HTTP Error 403: Forbidden",
		"ERROR: Postprocessing: ffprobe not found":                               "Postprocessing: ffprobe not found",
	}
	for line, want := range cases {
		if got, ok := errorReason(line); !ok || got != want {
			t.Fatalf("%q: got %q", line, got)
		}
	}
	if _, ok := errorReason("[download] 5% of 100MiB"); ok {
		t.Fatal("progress line treated as error")
	}
}

func TestIsMissingFragmentFile(t *testing.T) {
	missing := errors.New(`Unable to download video: [Errno 2] No such file or directory: 'C:\\Users\\x\\AppData\\Local\\Temp\\hls-grabber\\job-1\\temp_index_1.mp4.part-Frag265' (exit status 1)`)
	if !isMissingFragmentFile(missing) {
		t.Fatal("expected missing fragment error to be recognised")
	}
	for _, err := range []error{nil, errors.New("HTTP Error 403: Forbidden (exit status 1)"), errors.New("No such file or directory: 'C:\\out\\video.mp4'")} {
		if isMissingFragmentFile(err) {
			t.Fatalf("unexpected match: %v", err)
		}
	}
}

func TestRemuxTransportStreamToMP4(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg не знайдено")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "episode.mp4")
	// MPEG-TS під розширенням .mp4 — саме те, що лишає --hls-use-mpegts.
	prepare := exec.Command(ffmpeg, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x36:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-c:a", "aac", "-f", "mpegts", path)
	if out, err := prepare.CombinedOutput(); err != nil {
		t.Skipf("не вдалося підготувати TS: %v %s", err, out)
	}
	if ok, _ := isMPEGTS(path); !ok {
		t.Fatal("expected prepared file to be MPEG-TS")
	}

	d := New(&config.Config{})
	d.cfg.Paths.FFmpegPath = ffmpeg
	d.cfg.Paths.LogFile = filepath.Join(dir, "test.log")
	d.remuxTransportStream(context.Background(), "test", path)

	if ok, _ := isMPEGTS(path); ok {
		t.Fatal("file is still MPEG-TS after remux")
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) < 8 || string(data[4:8]) != "ftyp" {
		t.Fatalf("expected MP4 with ftyp box, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "episode.remux.mp4")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temporary remux file left behind")
	}
}
