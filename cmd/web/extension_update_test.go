package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.13.2", "1.9.0", 1},
		{"1.13.2", "1.13.2", 0},
		{"1.13", "1.13.1", -1},
		{"2.0.0", "1.99.99", 1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Fatalf("compareVersions(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestLatestExtensionLinkPicksNewest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"addons":{"hls-grabber-bridge@local":{"updates":[
			{"version":"1.9.0","update_link":"https://x/old.xpi"},
			{"version":"1.13.2","update_link":"https://x/new.xpi"},
			{"version":"1.13.1","update_link":"https://x/mid.xpi"}]}}}`))
	}))
	defer server.Close()

	link, version, err := latestExtensionLink(server.Client(), server.URL, "hls-grabber-bridge@local")
	if err != nil {
		t.Fatal(err)
	}
	if link != "https://x/new.xpi" || version != "1.13.2" {
		t.Fatalf("got %s %s", link, version)
	}
}

func TestLatestExtensionLinkEmptyList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"addons":{"hls-grabber-bridge@local":{"updates":[]}}}`))
	}))
	defer server.Close()

	if _, _, err := latestExtensionLink(server.Client(), server.URL, "hls-grabber-bridge@local"); err == nil || !strings.Contains(err.Error(), "немає жодної") {
		t.Fatalf("expected empty-list error, got %v", err)
	}
}

func TestBundledManifestHasUpdateURL(t *testing.T) {
	url, err := extensionUpdateURL()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "https://") || !strings.HasSuffix(url, "/updates.json") {
		t.Fatalf("unexpected update_url %q", url)
	}
	if extensionID() == "" {
		t.Fatal("extension id is empty")
	}
}

func TestStaticFilesAreNotCachedBlindly(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	for path, want := range map[string]string{"/app.js": "no-cache", "/api/status": ""} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", path, nil))
		if got := recorder.Header().Get("Cache-Control"); got != want {
			t.Fatalf("%s: Cache-Control = %q, want %q", path, got, want)
		}
	}
}
