//go:build !windows

package main

import "errors"

// Панель працює під Windows. Ця заглушка лише дає зібрати й протестувати
// пакет деінде.
func diskSpace(string) (uint64, uint64, error) {
	return 0, 0, errors.New("вільне місце визначається лише у Windows")
}
