package config

import (
	"fmt"
	"os"
	"strings"
	"time"
)

func AppendLog(logPath, level, message string) error {
	logPath = strings.TrimSpace(logPath)
	if logPath == "" {
		logPath = DefaultLogFile()
	}
	if err := EnsureLogFile(logPath); err != nil {
		return err
	}

	level = strings.ToUpper(strings.TrimSpace(level))
	switch level {
	case "INFO", "WARN", "ERROR":
	default:
		level = "INFO"
	}

	message = strings.TrimSpace(message)
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()

	timestamp := time.Now().Format("2006-01-02 15:04:05")
	_, err = fmt.Fprintf(file, "[%s] %s %s\n", timestamp, level, message)
	return err
}
