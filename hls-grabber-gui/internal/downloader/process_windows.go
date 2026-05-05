package downloader

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const processSuspendResume = 0x0800

var (
	ntdll           = windows.NewLazySystemDLL("ntdll.dll")
	ntSuspendProc   = ntdll.NewProc("NtSuspendProcess")
	ntResumeProcess = ntdll.NewProc("NtResumeProcess")
)

func suspendProcessTree(rootPID int) error {
	pids, err := processTreePIDs(uint32(rootPID))
	if err != nil {
		return err
	}

	for i := len(pids) - 1; i >= 0; i-- {
		if err := callNtProcess(ntSuspendProc, pids[i]); err != nil {
			return err
		}
	}

	return nil
}

func resumeProcessTree(rootPID int) error {
	pids, err := processTreePIDs(uint32(rootPID))
	if err != nil {
		return err
	}

	for _, pid := range pids {
		if err := callNtProcess(ntResumeProcess, pid); err != nil {
			return err
		}
	}

	return nil
}

func processTreePIDs(rootPID uint32) ([]uint32, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)

	parentByPID := make(map[uint32]uint32)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))

	if err := windows.Process32First(snapshot, &entry); err != nil {
		return nil, err
	}

	for {
		parentByPID[entry.ProcessID] = entry.ParentProcessID
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			break
		}
	}

	result := []uint32{rootPID}
	for index := 0; index < len(result); index++ {
		parent := result[index]
		for pid, ppid := range parentByPID {
			if ppid == parent && !containsPID(result, pid) {
				result = append(result, pid)
			}
		}
	}

	return result, nil
}

func containsPID(values []uint32, needle uint32) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func callNtProcess(proc *windows.LazyProc, pid uint32) error {
	handle, err := windows.OpenProcess(processSuspendResume, false, pid)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(handle)

	status, _, _ := proc.Call(uintptr(handle))
	if status != 0 {
		return fmt.Errorf("process control failed for pid %d: status 0x%x", pid, status)
	}

	return nil
}
