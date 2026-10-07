package config

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// ParseProxies розбирає список проксі: по одному в рядку, порожні рядки й
// «# коментарі» пропускаються. Розуміє три записи, у яких постачальники
// зазвичай віддають списки:
//
//	socks5://user:pass@host:port   — повна адреса (http, https, socks4, socks4a, socks5, socks5h)
//	host:port                      — без схеми, вважаємо http
//	host:port:user:pass            — так віддає більшість платних постачальників
//
// Повертає адреси у вигляді, який розуміє yt-dlp (--proxy).
func ParseProxies(text string) ([]string, error) {
	var proxies []string
	seen := make(map[string]bool)
	for number, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		proxy, err := normalizeProxy(line)
		if err != nil {
			return nil, fmt.Errorf("проксі, рядок %d: %w", number+1, err)
		}
		if !seen[proxy] {
			seen[proxy] = true
			proxies = append(proxies, proxy)
		}
	}
	return proxies, nil
}

func normalizeProxy(line string) (string, error) {
	if !strings.Contains(line, "://") {
		parts := strings.SplitN(line, ":", 4)
		// host:port:логін:пароль перевіряємо першим і за числовим портом:
		// пароль сам може містити «@» чи «:», і тоді запис схожий на
		// логін:пароль@host.
		_, portErr := strconv.Atoi(parts[1%len(parts)])
		switch {
		case len(parts) == 4 && portErr == nil && !strings.Contains(parts[0], "@"):
			line = "http://" + url.UserPassword(parts[2], parts[3]).String() + "@" + net.JoinHostPort(parts[0], parts[1])
		case strings.Contains(line, "@"):
			line = "http://" + line
		case len(parts) == 2:
			line = "http://" + line
		default:
			return "", fmt.Errorf("незрозумілий запис %q: очікую host:port, host:port:логін:пароль або схема://host:port", RedactProxy(line))
		}
	}

	parsed, err := url.Parse(line)
	if err != nil {
		return "", fmt.Errorf("незрозуміла адреса %q", RedactProxy(line))
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "socks4", "socks4a", "socks5", "socks5h":
	default:
		return "", fmt.Errorf("непідтримувана схема %q", parsed.Scheme)
	}
	host, port, err := net.SplitHostPort(parsed.Host)
	if err != nil || host == "" {
		return "", fmt.Errorf("у %q немає хоста й порту", RedactProxy(line))
	}
	if value, err := strconv.Atoi(port); err != nil || value < 1 || value > 65535 {
		return "", fmt.Errorf("неправильний порт у %q", RedactProxy(line))
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Path, parsed.RawQuery, parsed.Fragment = "", "", ""
	return parsed.String(), nil
}

// RedactProxy ховає пароль: адреса проксі йде в журнал і в повідомлення про
// помилки, а пароль туди потрапляти не має.
func RedactProxy(proxy string) string {
	if parsed, err := url.Parse(proxy); err == nil && parsed.User != nil {
		return parsed.Redacted()
	}
	if parts := strings.Split(proxy, ":"); len(parts) == 4 && !strings.Contains(proxy, "://") {
		return parts[0] + ":" + parts[1] + ":" + parts[2] + ":xxxxx"
	}
	return proxy
}
