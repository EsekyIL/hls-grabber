//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32                = windows.NewLazySystemDLL("kernel32.dll")
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procGetConsoleWindow    = kernel32.NewProc("GetConsoleWindow")
	procGetConsoleProcesses = kernel32.NewProc("GetConsoleProcessList")
	procShowWindow          = user32.NewProc("ShowWindow")
)

const swHide = 0

// hideOwnConsole ховає вікно консолі, якщо воно належить лише панелі.
//
// Збірка без консолі (-H=windowsgui) прибирала вікно, але разом із ним і
// стандартні потоки, і з такою збіркою панель працювала негаразд. Тож
// панель лишається консольною програмою, а вікно ховає сама.
//
// Лише свою консоль: запущена ярликом чи подвійним кліком, панель отримує
// окреме вікно, і в ньому немає інших процесів. Запущена з PowerShell, вона
// ділить вікно терміналу з ним, і ховати його було б грубо: людина
// втратила б свій термінал разом із виводом панелі.
func hideOwnConsole() {
	window, _, _ := procGetConsoleWindow.Call()
	if window == 0 {
		return
	}
	var processes [2]uint32
	count, _, _ := procGetConsoleProcesses.Call(uintptr(unsafe.Pointer(&processes[0])), uintptr(len(processes)))
	if count != 1 {
		return
	}
	procShowWindow.Call(window, swHide)
}
