package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"
)

//
// ================= CONFIG STRUCT =================
//

type Config struct {
	Paths struct {
		YTDLP      string `yaml:"yt_dlp"`
		FFMPEG     string `yaml:"ffmpeg"`
		FFMPEG_DIR string `yaml:"ffmpeg_dir"`

		MoviesDir  string `yaml:"movies_dir"`
		SerialsDir string `yaml:"serials_dir"`
		LogFile    string `yaml:"log_file"`
		LinksDir   string `yaml:"links_dir"`
	} `yaml:"paths"`

	Download struct {
		MaxParallel   int `yaml:"max_parallel"`
		Retries       int `yaml:"retries"`
		RetryDelaySec int `yaml:"retry_delay_sec"`
	} `yaml:"download"`

	YTDLP struct {
		ConcurrentFragments int    `yaml:"concurrent_fragments"`
		Retries             int    `yaml:"retries"`
		FragmentRetries     int    `yaml:"fragment_retries"`
		Container           string `yaml:"container"`
	} `yaml:"yt_dlp"`
}

//
// ================= GLOBALS =================
//

var (
	reader = bufio.NewReader(os.Stdin)
	sem    chan struct{}
	wg     sync.WaitGroup
)

type AppLogger struct {
	Info  *log.Logger
	Error *log.Logger
}

//
// ================= INIT =================
//

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

func initLogger(logPath string) (*AppLogger, func()) {
	baseDir := exeDir()

	if logPath == "" {
		logPath = filepath.Join(baseDir, "download.log")
	}
	errPath := filepath.Join(baseDir, "errors.log")

	_ = os.MkdirAll(filepath.Dir(logPath), 0755)

	open := func(p string) *os.File {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			fmt.Printf("LOGGER ERROR: cannot open %s: %v\n", p, err)
			return nil
		}
		return f
	}

	logFile := open(logPath)
	errFile := open(errPath)

	var infoOut io.Writer = os.Stdout
	var errOut io.Writer = os.Stdout

	if logFile != nil {
		infoOut = io.MultiWriter(os.Stdout, logFile)
	}
	if errFile != nil {
		errOut = io.MultiWriter(os.Stdout, errFile)
	}

	infoLogger := log.New(infoOut, "INFO  ", log.Ldate|log.Ltime|log.Lmicroseconds)
	errLogger := log.New(errOut, "ERROR ", log.Ldate|log.Ltime|log.Lmicroseconds)

	cleanup := func() {
		if logFile != nil {
			logFile.Close()
		}
		if errFile != nil {
			errFile.Close()
		}
	}

	return &AppLogger{
		Info:  infoLogger,
		Error: errLogger,
	}, cleanup
}

func setupGracefulShutdown(logger *AppLogger) context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sig
		logger.Error.Println("CTRL+C received, shutting down...")
		cancel()
	}()
	return ctx
}

//
// ================= UTILS =================
//

func readLine(prompt string) string {
	fmt.Print(prompt)
	s, _ := reader.ReadString('\n')
	return strings.TrimSpace(s)
}

// для ФАЙЛІВ (фільми)
func sanitizeFilename(s string) string {
	repl := map[string]string{
		":": "_", "/": "_", "\\": "_", "?": "",
		`"`: "", "<": "", ">": "", "|": "",
	}
	for k, v := range repl {
		s = strings.ReplaceAll(s, k, v)
	}
	return strings.TrimSpace(s)
}

// для ПАПОК (серіали)
func sanitizeDirName(s string) string {
	repl := map[string]string{
		":": " ", "/": "", "\\": "", "?": "",
		`"`: "", "<": "", ">": "", "|": "",
	}
	for k, v := range repl {
		s = strings.ReplaceAll(s, k, v)
	}
	return strings.TrimSpace(s)
}

func retry(
	ctx context.Context,
	attempts int,
	delay time.Duration,
	fn func() error,
	logger *log.Logger,
) error {
	var err error

	for i := 1; i <= attempts; i++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		err = fn()
		if err == nil {
			return nil
		}

		logger.Printf("Retry %d/%d failed: %v\n", i, attempts, err)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return err
}

//
// ================= INPUT =================
//

func readMode() int {
	for {
		fmt.Println("1 - Movie")
		fmt.Println("2 - Series")
		switch readLine("Choose mode [1/2]: ") {
		case "1":
			return 1
		case "2":
			return 2
		default:
			fmt.Println("Allowed only 1 or 2")
		}
	}
}

//
// ================= DOWNLOAD =================
//

func runYTDLP(ctx context.Context, cfg *Config, url, workDir string) error {
	cmd := exec.CommandContext(
		ctx,
		cfg.Paths.YTDLP,
		"--continue",
		"--ffmpeg-location", cfg.Paths.FFMPEG_DIR,
		"--hls-use-mpegts",
		"-N", fmt.Sprint(cfg.YTDLP.ConcurrentFragments),
		"--concurrent-fragments", fmt.Sprint(cfg.YTDLP.ConcurrentFragments),
		"--retries", fmt.Sprint(cfg.YTDLP.Retries),
		"--fragment-retries", fmt.Sprint(cfg.YTDLP.FragmentRetries),
		"--merge-output-format", cfg.YTDLP.Container,
		"-o", filepath.Join(workDir, "temp_%(id)s_%(epoch)s.%(ext)s"),
		url,
	)

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func download(ctx context.Context, cfg *Config, logger *AppLogger, url, final, workDir string) {
	err := retry(
		ctx,
		cfg.Download.Retries,
		time.Duration(cfg.Download.RetryDelaySec)*time.Second,
		func() error {
			return runYTDLP(ctx, cfg, url, workDir)
		},
		logger.Error,
	)

	if err != nil {
		logger.Error.Printf("FAILED: %s\n", url)
		return
	}

	files, _ := filepath.Glob(filepath.Join(workDir, "temp_*.mp4"))
	if len(files) == 0 {
		logger.Info.Println("No temp files found")
		return
	}

	exec.Command(cfg.Paths.FFMPEG, "-y", "-i", files[0], "-c", "copy", final).Run()
	_ = os.Remove(files[0])
}

func downloadAsync(ctx context.Context, cfg *Config, logger *AppLogger, url, output, workDir string) {
	select {
	case <-ctx.Done():
		return
	case sem <- struct{}{}:
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { <-sem }()

		logger.Info.Printf("START: %s\n", output)
		download(ctx, cfg, logger, url, output, workDir)
		logger.Info.Printf("DONE: %s\n", output)
	}()
}

//
// ================= FLOWS =================
//

func movieFlow(ctx context.Context, cfg *Config, logger *AppLogger) {
	url := readLine("Paste video URL: ")
	name := sanitizeFilename(readLine("Paste movie name: "))

	_ = os.MkdirAll(cfg.Paths.MoviesDir, 0755)
	out := filepath.Join(cfg.Paths.MoviesDir, name+"."+cfg.YTDLP.Container)

	downloadAsync(ctx, cfg, logger, url, out, cfg.Paths.MoviesDir)
}

func seriesFlow(ctx context.Context, cfg *Config, logger *AppLogger) {
	listDir := cfg.Paths.LinksDir
	if listDir == "" {
		logger.Error.Println("links_dir is not set in config")
		return
	}
	listName := readLine("Paste list name (ex: url_list.ini): ")

	listFile := filepath.Join(listDir, listName)
	f, err := os.Open(listFile)
	if err != nil {
		logger.Error.Println(listName, "NOT FOUND")
		return

	}
	defer f.Close()

	rawName := readLine("Paste series name: ")
	seriesName := sanitizeDirName(rawName)
	season := readLine("Paste season number: ")

	base := filepath.Join(cfg.Paths.SerialsDir, seriesName, "Season "+season)
	_ = os.MkdirAll(base, 0755)

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	ep := 1
	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}

		url := scanner.Text()
		epNum := fmt.Sprintf("%02d", ep)
		filename := fmt.Sprintf("S%sE%s.%s", season, epNum, cfg.YTDLP.Container)
		fullPath := filepath.Join(base, filename)

		if _, err := os.Stat(fullPath); err == nil {
			logger.Info.Printf("SKIP (exists): %s\n", fullPath)
			ep++
			continue
		}

		downloadAsync(ctx, cfg, logger, url, fullPath, base)
		ep++
	}
}

//
// ================= MAIN =================
//

func main() {
	cfg, err := loadConfig("config.yaml")
	if err != nil {
		panic(err)
	}

	logger, closeLogs := initLogger(cfg.Paths.LogFile)
	defer closeLogs()

	sem = make(chan struct{}, cfg.Download.MaxParallel)

	ctx := setupGracefulShutdown(logger)
	mode := readMode()

	if mode == 1 {
		movieFlow(ctx, cfg, logger)
	} else {
		seriesFlow(ctx, cfg, logger)
	}

	logger.Info.Println("Waiting for active jobs...")
	wg.Wait()
	logger.Info.Println("EXIT")
}
