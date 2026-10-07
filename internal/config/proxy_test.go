package config

import (
	"strings"
	"testing"
)

func TestParseProxies(t *testing.T) {
	list := strings.Join([]string{
		"# мої проксі",
		"",
		"1.2.3.4:8080",
		"5.6.7.8:1080:user:p@ss",
		"SOCKS5://login:secret@proxy.example:1080",
		"user:pass@9.9.9.9:3128",
		"1.2.3.4:8080",
	}, "\r\n")
	got, err := ParseProxies(list)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"http://1.2.3.4:8080",
		"http://user:p%40ss@5.6.7.8:1080",
		"socks5://login:secret@proxy.example:1080",
		"http://user:pass@9.9.9.9:3128",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestParseProxiesRejectsGarbage(t *testing.T) {
	for _, line := range []string{"just-text", "ftp://1.2.3.4:21", "1.2.3.4:99999", "a:b:c"} {
		if _, err := ParseProxies(line); err == nil {
			t.Fatalf("expected error for %q", line)
		}
	}
}

func TestRedactProxyHidesPassword(t *testing.T) {
	for _, proxy := range []string{"http://user:secret@1.2.3.4:8080", "1.2.3.4:8080:user:secret"} {
		if strings.Contains(RedactProxy(proxy), "secret") {
			t.Fatalf("password leaked: %s", RedactProxy(proxy))
		}
	}
}
