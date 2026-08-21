//go:build windows

package main

import "syscall"

func hiddenWindowAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}
