//go:build !windows

package downloader

import "errors"

// Пауза завантаження (призупинення процесу yt-dlp) є лише у Windows. Ці
// заглушки потрібні, щоб пакет збирався й тестувався деінде.
var errSuspendUnsupported = errors.New("призупинення процесу підтримується лише у Windows")

func suspendProcessTree(int) error { return errSuspendUnsupported }

func resumeProcessTree(int) error { return errSuspendUnsupported }
