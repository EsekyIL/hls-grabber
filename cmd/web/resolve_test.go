package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	extensionassets "hls-grabber/browser-extension"
)

func TestPickQualityPrefersChosenThenBest(t *testing.T) {
	streams := []streamOption{
		{Quality: "720p", URLs: []string{"a720", "b720"}},
		{Quality: "1080p Ultra", URLs: []string{"a1080u"}},
		{Quality: "1080p", URLs: []string{"a1080"}},
	}
	if got := pickQuality(streams, "720p"); len(got) != 2 || got[0] != "a720" {
		t.Fatalf("chosen quality ignored: %v", got)
	}
	if got := pickQuality(streams, "4K"); len(got) != 1 || got[0] != "a1080u" {
		t.Fatalf("missing quality should fall back to best: %v", got)
	}
}

func TestRefreshURLsRoundTrip(t *testing.T) {
	s := &server{lastBridgeSeen: time.Now(), bridgeVersion: extensionassets.Version}
	job := &queueJob{Mode: "series", PageURL: "https://site.test/show.html", TranslatorID: "56", Season: "1", Episode: 3, Quality: "720p"}

	type answer struct {
		urls []string
		err  error
	}
	done := make(chan answer, 1)
	go func() {
		urls, err := s.refreshURLs(context.Background(), job)
		done <- answer{urls, err}
	}()

	// Розширення забирає запит…
	var commands []resolveCommand
	for deadline := time.Now().Add(2 * time.Second); len(commands) == 0; {
		if time.Now().After(deadline) {
			t.Fatal("resolve command never queued")
		}
		rec := httptest.NewRecorder()
		s.takeResolveCommands(rec, httptest.NewRequest(http.MethodGet, "/api/bridge/resolves", nil))
		if err := json.Unmarshal(rec.Body.Bytes(), &commands); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if c := commands[0]; c.URL != job.PageURL || c.TranslatorID != "56" || c.Season != "1" || c.Episode != "3" {
		t.Fatalf("unexpected command: %+v", c)
	}

	// …і повертає свіжі адреси.
	body := `{"id":"` + commands[0].ID + `","streams":[{"quality":"720p","urls":["fresh1","fresh2"]},{"quality":"1080p","urls":["hd"]}]}`
	rec := httptest.NewRecorder()
	s.reportResolved(rec, httptest.NewRequest(http.MethodPost, "/api/bridge/resolved", strings.NewReader(body)))

	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	if len(got.urls) != 2 || got.urls[0] != "fresh1" {
		t.Fatalf("unexpected urls: %v", got.urls)
	}
}

func TestRefreshURLsFailsFastWithoutBridge(t *testing.T) {
	s := &server{}
	start := time.Now()
	if _, err := s.refreshURLs(context.Background(), &queueJob{}); err == nil {
		t.Fatal("expected offline error")
	}
	if time.Since(start) > time.Second {
		t.Fatal("offline bridge must not wait for the timeout")
	}
}
