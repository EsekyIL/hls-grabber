package config

type Config struct {
	General  GeneralConfig  `json:"general"`
	Paths    PathsConfig    `json:"paths"`
	Download DownloadConfig `json:"download"`
	YTDLP    YTDLPConfig    `json:"yt_dlp"`
}

type GeneralConfig struct {
	Version  int    `json:"version"`
	Language string `json:"language"`
}

type PathsConfig struct {
	YTDLPPath  string `json:"yt_dlp_path"`
	FFmpegPath string `json:"ffmpeg_path"`
	MoviesDir  string `json:"movies_dir"`
	SerialsDir string `json:"serials_dir"`
	LogFile    string `json:"log_file"`
	LinksDir   string `json:"links_dir"`
}

type DownloadConfig struct {
	MaxParallel   int `json:"max_parallel"`
	Retries       int `json:"retries"`
	RetryDelaySec int `json:"retry_delay_sec"`
}

type YTDLPConfig struct {
	ConcurrentFragments int    `json:"concurrent_fragments"`
	Retries             int    `json:"retries"`
	FragmentRetries     int    `json:"fragment_retries"`
	Container           string `json:"container"`
	CookiesFromBrowser  string `json:"cookies_from_browser"`
	Continue            bool   `json:"continue"`
	HLSUseMPEGTS        bool   `json:"hls_use_mpegts"`
	SafeMode            bool   `json:"safe_mode"`
}
