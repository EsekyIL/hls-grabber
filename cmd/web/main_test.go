package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmptyInboxIsJSONArray(t *testing.T) {
	server := &server{}
	recorder := httptest.NewRecorder()
	server.getInbox(recorder, httptest.NewRequest("GET", "/api/inbox", nil))
	if body := strings.TrimSpace(recorder.Body.String()); body != "[]" {
		t.Fatalf("expected empty JSON array, got %s", body)
	}
}

// isPlaylistURL має приймати рівно те саме, що PLAYLIST_RE у
// service-worker.js. Розійдись вони — розширення ловило б адреси, які сервер
// мовчки викидає на вході, і зникали б вони без жодного сліду.
func TestIsPlaylistURL(t *testing.T) {
	accept := []string{
		"https://cdn.example/stream/index.m3u8",
		"https://cdn.example/stream/index.m3u8?token=abc",
		"https://cdn.example/stream/index.m3u8#frag",
		"https://cdn.example/playlist?type=m3u8",
		"https://cdn.example/get?id=7&format=m3u8",
		"https://cdn.example/hls/master",
		"https://cdn.example/hls/master?sig=1",
		"HTTPS://CDN.EXAMPLE/STREAM/INDEX.M3U8",
	}
	for _, url := range accept {
		if !isPlaylistURL(url) {
			t.Errorf("мало прийняти, але відхилено: %s", url)
		}
	}

	reject := []string{
		"",
		"https://cdn.example/stream/segment.ts",
		"https://cdn.example/poster.jpg",
		// .m3u8 всередині шляху, а не в кінці сегмента: це вже не плейлист,
		// а тека з таким іменем.
		"https://cdn.example/.m3u8x/file.ts",
		"https://cdn.example/mastermind/page.html",
	}
	for _, url := range reject {
		if isPlaylistURL(url) {
			t.Errorf("мало відхилити, але прийнято: %s", url)
		}
	}
}

func TestQualityScoreOrdersLabels(t *testing.T) {
	// «1080p Ultra» вище за «1080p»: висота однакова, і самих лише цифр для
	// порівняння замало.
	order := []string{"360p", "480p", "720p", "1080p", "1080p Ultra"}
	for i := 1; i < len(order); i++ {
		if qualityScore(order[i]) <= qualityScore(order[i-1]) {
			t.Errorf("%q мало бути вище за %q", order[i], order[i-1])
		}
	}
}

func TestBestStreamPicksHighest(t *testing.T) {
	streams := []streamOption{
		{Quality: "360p", URLs: []string{"http://a/360.m3u8"}},
		{Quality: "1080p Ultra", URLs: []string{"http://a/ultra.m3u8", "http://mirror/ultra.m3u8"}},
		{Quality: "720p", URLs: []string{"http://a/720.m3u8"}},
		// Без адрес — не має перемогти, хоч підпис і найвищий.
		{Quality: "2160p", URLs: nil},
	}
	if got := bestStream(streams); got != "http://a/ultra.m3u8" {
		t.Errorf("вибрано %q", got)
	}
	if got := bestStream(nil); got != "" {
		t.Errorf("порожній набір мав дати порожньо, а дав %q", got)
	}
}
