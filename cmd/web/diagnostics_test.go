package main

import "testing"

func TestParseExpectedHash(t *testing.T) {
	const hash = "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8"
	value, err := parseExpectedHash(hash+"  yt-dlp.exe\nabc  other.exe", "yt-dlp.exe")
	if err != nil {
		t.Fatalf("parse hash: %v", err)
	}
	if value != hash {
		t.Fatalf("expected %s, got %s", hash, value)
	}
}

func TestParseFFmpegVersion(t *testing.T) {
	value := parseFFmpegVersion("ffmpeg version 9.0-essentials_build-www.gyan.dev Copyright")
	if value != "9.0-essentials_build-www.gyan.dev" {
		t.Fatalf("unexpected version: %q", value)
	}
}
