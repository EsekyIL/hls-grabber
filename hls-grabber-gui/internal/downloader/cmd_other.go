//go:build !windows

package downloader

import "os/exec"

func configureCommand(cmd *exec.Cmd) {}
