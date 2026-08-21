package main

import (
	"path/filepath"
	"testing"

	"hls-grabber/internal/config"
)

func TestEnqueuePreservesCapturedEpisodeMetadata(t *testing.T) {
	q := &queueManager{
		cfg:  &config.Config{},
		wake: make(chan struct{}, 1),
		path: filepath.Join(t.TempDir(), "queue.json"),
	}

	jobs, err := q.enqueue(downloadRequest{
		Mode:  "series",
		Title: "Example Show",
		Items: []downloadItem{
			{URL: "https://example.test/e01.m3u8", Voice: "Voice A", Season: "1", Episode: 1},
			{URL: "https://example.test/e03.m3u8", Voice: "Voice B", Season: "1", Episode: 3},
		},
	})
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if len(jobs) != 2 {
		t.Fatalf("expected 2 jobs, got %d", len(jobs))
	}
	if jobs[0].Episode != 1 || jobs[1].Episode != 3 {
		t.Fatalf("episode numbers were renumbered: %d, %d", jobs[0].Episode, jobs[1].Episode)
	}
	if jobs[0].Voice != "Voice A" || jobs[1].Voice != "Voice B" {
		t.Fatalf("voice metadata was lost: %q, %q", jobs[0].Voice, jobs[1].Voice)
	}
}
