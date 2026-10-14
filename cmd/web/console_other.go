//go:build !windows

package main

// Ховати вікно консолі є сенс лише у Windows.
func hideOwnConsole() {}
