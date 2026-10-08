package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
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

// Збій yt-dlp — ненульовий код виходу. Саме такі помилки варто повторювати.
var errNetwork = fmt.Errorf("yt-dlp: %w", &exec.ExitError{})

func testQueue(t *testing.T, retries int, download func(ctx context.Context, job *queueJob, url string) error) *queueManager {
	t.Helper()
	cfg := &config.Config{}
	cfg.Download.Retries = retries
	return &queueManager{cfg: cfg, wake: make(chan struct{}, 1), path: filepath.Join(t.TempDir(), "queue.json"), download: download}
}

func TestRunJobFallsBackToMirror(t *testing.T) {
	var tried []string
	q := testQueue(t, 0, func(_ context.Context, _ *queueJob, url string) error {
		tried = append(tried, url)
		if url == "https://a.test/x.m3u8" {
			return errNetwork
		}
		return nil
	})
	job := &queueJob{URL: "https://a.test/x.m3u8", Mirrors: []string{"https://b.test/x.m3u8"}}
	if err := q.runJob(context.Background(), job); err != nil {
		t.Fatalf("mirror should have succeeded: %v", err)
	}
	if len(tried) != 2 || tried[1] != "https://b.test/x.m3u8" {
		t.Fatalf("unexpected attempts: %v", tried)
	}
}

func TestRunJobRetriesNetworkErrors(t *testing.T) {
	calls := 0
	q := testQueue(t, 2, func(context.Context, *queueJob, string) error {
		calls++
		return errNetwork
	})
	job := &queueJob{URL: "https://a.test/x.m3u8", Mirrors: []string{"https://b.test/x.m3u8"}}
	if err := q.runJob(context.Background(), job); err == nil {
		t.Fatal("expected failure after all attempts")
	}
	// Три кола по дві адреси.
	if calls != 6 {
		t.Fatalf("expected 6 calls, got %d", calls)
	}
}

func TestRunJobDoesNotRetryConfigErrors(t *testing.T) {
	calls := 0
	q := testQueue(t, 3, func(context.Context, *queueJob, string) error {
		calls++
		return errors.New("output directory is required")
	})
	job := &queueJob{URL: "https://a.test/x.m3u8", Mirrors: []string{"https://b.test/x.m3u8"}}
	if err := q.runJob(context.Background(), job); err == nil {
		t.Fatal("expected error")
	}
	if calls != 1 {
		t.Fatalf("config error must not be retried, got %d calls", calls)
	}
}

func TestRunJobStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	q := testQueue(t, 5, func(context.Context, *queueJob, string) error {
		calls++
		cancel()
		return errNetwork
	})
	q.cfg.Download.RetryDelaySec = 60
	if err := q.runJob(ctx, &queueJob{URL: "https://a.test/x.m3u8", Mirrors: []string{"https://b.test/x.m3u8"}}); err == nil {
		t.Fatal("expected cancellation error")
	}
	if calls != 1 {
		t.Fatalf("cancelled job kept going: %d calls", calls)
	}
}

func TestEnqueueKeepsMirrors(t *testing.T) {
	q := testQueue(t, 0, nil)
	jobs, err := q.enqueue(downloadRequest{
		Mode:  "series",
		Title: "Example Show",
		Items: []downloadItem{{URL: "https://a.test/1.m3u8", Mirrors: []string{"https://a.test/1.m3u8", " ", "https://b.test/1.m3u8"}, Season: "1", Episode: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := jobs[0].Mirrors; len(got) != 1 || got[0] != "https://b.test/1.m3u8" {
		t.Fatalf("mirrors not cleaned: %v", got)
	}
}

func TestRunJobRefreshesExpiredLinks(t *testing.T) {
	refreshes := 0
	q := testQueue(t, 0, func(_ context.Context, _ *queueJob, url string) error {
		if strings.Contains(url, "fresh") {
			return nil
		}
		return errNetwork
	})
	q.refresh = func(context.Context, *queueJob) ([]string, error) {
		refreshes++
		return []string{"https://a.test/fresh.m3u8", "https://b.test/fresh.m3u8"}, nil
	}
	job := &queueJob{Mode: "series", URL: "https://a.test/old.m3u8", PageURL: "https://site.test/show.html", Voice: "Voice", Season: "1", Episode: 2}
	if err := q.runJob(context.Background(), job); err != nil {
		t.Fatalf("fresh link should have worked: %v", err)
	}
	if refreshes != 1 {
		t.Fatalf("expected one refresh, got %d", refreshes)
	}
	if job.URL != "https://a.test/fresh.m3u8" || len(job.Mirrors) != 1 {
		t.Fatalf("job keeps stale addresses: %s %v", job.URL, job.Mirrors)
	}
}

func TestRunJobRefreshesOnlyOnce(t *testing.T) {
	refreshes, calls := 0, 0
	q := testQueue(t, 2, func(context.Context, *queueJob, string) error {
		calls++
		return errNetwork
	})
	q.refresh = func(context.Context, *queueJob) ([]string, error) {
		refreshes++
		return []string{"https://a.test/fresh.m3u8"}, nil
	}
	job := &queueJob{Mode: "series", URL: "https://a.test/old.m3u8", PageURL: "https://site.test/show.html", Voice: "Voice", Season: "1", Episode: 2}
	if err := q.runJob(context.Background(), job); err == nil {
		t.Fatal("expected failure")
	}
	if refreshes != 1 {
		t.Fatalf("refresh must happen once per run, got %d", refreshes)
	}
	// Три кола плюс одне додаткове зі свіжою адресою.
	if calls != 4 {
		t.Fatalf("expected 4 download calls, got %d", calls)
	}
}

func TestRunJobSkipsRefreshWithoutPage(t *testing.T) {
	q := testQueue(t, 0, func(context.Context, *queueJob, string) error { return errNetwork })
	q.refresh = func(context.Context, *queueJob) ([]string, error) {
		t.Fatal("refresh called for a job without page data")
		return nil, nil
	}
	if err := q.runJob(context.Background(), &queueJob{Mode: "series", URL: "https://a.test/x.m3u8", Season: "1", Episode: 1}); err == nil {
		t.Fatal("expected failure")
	}
}

func TestRunJobContinuesWhenRefreshFails(t *testing.T) {
	calls := 0
	q := testQueue(t, 1, func(context.Context, *queueJob, string) error {
		calls++
		if calls == 2 {
			return nil
		}
		return errNetwork
	})
	q.refresh = func(context.Context, *queueJob) ([]string, error) { return nil, errors.New("bridge offline") }
	job := &queueJob{Mode: "series", URL: "https://a.test/x.m3u8", PageURL: "https://site.test/show.html", Voice: "Voice", Season: "1", Episode: 1}
	if err := q.runJob(context.Background(), job); err != nil {
		t.Fatalf("ordinary retry should still run: %v", err)
	}
}

func TestEnqueueKeepsRefreshData(t *testing.T) {
	q := testQueue(t, 0, nil)
	jobs, err := q.enqueue(downloadRequest{Mode: "series", Title: "Show", Items: []downloadItem{{
		URL: "https://a.test/1.m3u8", Season: "1", Episode: 1,
		PageURL: "https://site.test/show.html", TranslatorID: "56", Quality: "1080p",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if job := jobs[0]; job.PageURL != "https://site.test/show.html" || job.TranslatorID != "56" || job.Quality != "1080p" {
		t.Fatalf("refresh data lost: %+v", job)
	}
}
