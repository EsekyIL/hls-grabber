package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func Default() Config {
	return Config{
		General: GeneralConfig{
			Version:  1,
			Language: "uk",
		},
		Paths: PathsConfig{
			LogFile: DefaultLogFile(),
		},
		Download: DownloadConfig{
			MaxParallel:   4,
			Retries:       3,
			RetryDelaySec: 5,
		},
		YTDLP: YTDLPConfig{
			ConcurrentFragments: 8,
			Retries:             10,
			FragmentRetries:     10,
			Container:           "mp4",
			CookiesFromBrowser:  "",
			Continue:            true,
			HLSUseMPEGTS:        true,
			SafeMode:            false,
		},
	}
}

func (c *Config) Normalize() {
	c.General.Language = normalizeLanguage(strings.ToLower(strings.TrimSpace(c.General.Language)))
	if c.General.Language == "" {
		c.General.Language = "uk"
	}
	c.Paths.YTDLPPath = strings.TrimSpace(c.Paths.YTDLPPath)
	c.Paths.FFmpegPath = strings.TrimSpace(c.Paths.FFmpegPath)
	c.Paths.MoviesDir = strings.TrimSpace(c.Paths.MoviesDir)
	c.Paths.SerialsDir = strings.TrimSpace(c.Paths.SerialsDir)
	c.Paths.LogFile = strings.TrimSpace(c.Paths.LogFile)
	if c.Paths.LogFile == "" {
		c.Paths.LogFile = DefaultLogFile()
	}
	c.Paths.LinksDir = strings.TrimSpace(c.Paths.LinksDir)
	c.YTDLP.Container = strings.TrimSpace(c.YTDLP.Container)
	c.YTDLP.CookiesFromBrowser = strings.ToLower(strings.TrimSpace(c.YTDLP.CookiesFromBrowser))
}

func DefaultLogFile() string {
	return filepath.Join(os.TempDir(), "hls-grabber", "download.log")
}

func EnsureLogFile(logPath string) error {
	logPath = strings.TrimSpace(logPath)
	if logPath == "" {
		logPath = DefaultLogFile()
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return err
	}

	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	return file.Close()
}

func filePath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	dir := filepath.Join(base, "hls-grabber")
	return filepath.Join(dir, "config.json"), nil
}

func Path() (string, error) {
	return filePath()
}

func Load() (*Config, error) {
	cfg := Default()

	p, err := filePath()
	if err != nil {
		return &cfg, err
	}

	data, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if err := Save(cfg); err != nil {
				return &cfg, err
			}
			return &cfg, nil
		}
		return &cfg, err
	}

	if err := json.Unmarshal(data, &cfg); err != nil {
		defaultCfg := Default()
		return &defaultCfg, err
	}

	needsSave := strings.TrimSpace(cfg.Paths.LogFile) == ""
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		defaultCfg := Default()
		return &defaultCfg, err
	}
	if err := EnsureLogFile(cfg.Paths.LogFile); err != nil {
		return &cfg, err
	}
	if needsSave {
		if err := Save(cfg); err != nil {
			return &cfg, err
		}
	}

	return &cfg, nil
}

func Save(cfg Config) error {
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		return err
	}

	p, err := filePath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := EnsureLogFile(cfg.Paths.LogFile); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}

	return os.Rename(tmp, p)
}

func (c Config) Validate() error {
	if c.General.Version <= 0 {
		return errors.New("invalid config version")
	}
	if !SupportedLanguage(c.General.Language) {
		return errors.New("unsupported language")
	}
	if c.Download.MaxParallel <= 0 {
		return errors.New("max_parallel must be > 0")
	}
	if c.Download.Retries < 0 {
		return errors.New("retries must be >= 0")
	}
	if c.Download.RetryDelaySec < 0 {
		return errors.New("retry_delay_sec must be >= 0")
	}
	if c.YTDLP.ConcurrentFragments <= 0 {
		return errors.New("concurrent_fragments must be > 0")
	}
	if c.YTDLP.Retries < 0 {
		return errors.New("yt_dlp retries must be >= 0")
	}
	if c.YTDLP.FragmentRetries < 0 {
		return errors.New("fragment_retries must be >= 0")
	}
	if c.YTDLP.Container == "" {
		return errors.New("container is required")
	}
	if !isValidCookiesBrowser(c.YTDLP.CookiesFromBrowser) {
		return errors.New("unsupported cookies browser")
	}

	return nil
}

func isValidCookiesBrowser(browser string) bool {
	switch browser {
	case "", "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi":
		return true
	default:
		return false
	}
}

func (c Config) ValidateForMovieDownload() error {
	return c.ValidateForMovieDownloadTo("")
}

func (c Config) ValidateForMovieDownloadTo(outputDir string) error {
	if err := c.validateToolPaths(); err != nil {
		return err
	}
	if outputDir == "" && c.Paths.MoviesDir == "" {
		return errors.New("movies directory is required")
	}
	return nil
}

func (c Config) ValidateForSeriesDownload() error {
	return c.ValidateForSeriesDownloadTo("")
}

func (c Config) ValidateForSeriesDownloadTo(outputDir string) error {
	if err := c.ValidateForSeriesDirectDownloadTo(outputDir); err != nil {
		return err
	}
	if c.Paths.LinksDir == "" {
		return errors.New("links directory is required")
	}
	return nil
}

func (c Config) ValidateForSeriesDirectDownload() error {
	return c.ValidateForSeriesDirectDownloadTo("")
}

func (c Config) ValidateForSeriesDirectDownloadTo(outputDir string) error {
	if err := c.validateToolPaths(); err != nil {
		return err
	}
	if outputDir == "" && c.Paths.SerialsDir == "" {
		return errors.New("series directory is required")
	}
	return nil
}

func (c Config) validateToolPaths() error {
	if err := c.Validate(); err != nil {
		return err
	}
	if c.Paths.YTDLPPath == "" {
		return errors.New("yt-dlp path is required")
	}
	if c.Paths.FFmpegPath == "" {
		return errors.New("ffmpeg path is required")
	}
	return nil
}
