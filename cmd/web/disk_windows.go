//go:build windows

package main

import "golang.org/x/sys/windows"

// diskSpace — вільне й загальне місце на диску, де лежить path.
func diskSpace(path string) (free, total uint64, err error) {
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	var totalFree uint64
	err = windows.GetDiskFreeSpaceEx(pointer, &free, &total, &totalFree)
	return free, total, err
}
