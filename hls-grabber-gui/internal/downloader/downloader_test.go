package downloader

import "testing"

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
