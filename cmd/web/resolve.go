package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Оновлення протухлих посилань.
//
// Адреси, які віддає get_cdn_series, підписані й живуть обмежений час. Черга
// ж переживає перезапуск панелі, і серія, поставлена ввечері, вранці отримує
// 403 на всіх дзеркалах. Повтор тут не допоможе — допоможе лише свіжа адреса.
//
// Взяти її може тільки розширення: запит має йти зі сторінки сайту, з її
// куками. Тому панель кладе для нього окрему команду й чекає відповіді.
//
// Окремо від probe/scan, а не ще одним видом тієї ж команди. Ті скидають
// сеанс, який панель показує людині, і виконуються по одній за раз — а
// сканування серіалу триває хвилинами. Оновлення ж короткі, фонові й мають
// проходити навіть посеред обходу.

// resolveTimeout — скільки чекати на розширення. Воно опитує панель раз на
// п'ятнадцять секунд, потім відкриває сторінку й чекає на неї до сорока.
const resolveTimeout = 2 * time.Minute

type resolveCommand struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	TranslatorID string `json:"translatorId,omitempty"`
	Voice        string `json:"voice,omitempty"`
	Season       string `json:"season"`
	Episode      string `json:"episode"`
}

type resolveResult struct {
	Streams []streamOption
	Err     error
}

// canRefresh — чи вистачає задачі даних, щоб попросити свіжу адресу.
//
// Лише серії: обхід через API сайту знає тільки їх. Задачі, поставлені до
// цієї версії, сторінки не пам'ятають, і для них оновлення просто немає.
func canRefresh(job *queueJob) bool {
	return job.Mode != "movie" && strings.HasPrefix(job.PageURL, "http") &&
		job.Season != "" && job.Episode > 0 && (job.TranslatorID != "" || job.Voice != "")
}

// refreshURLs просить у розширення свіжі адреси для задачі.
//
// Повертає адреси тієї ж якості, що була вибрана; якщо її більше немає —
// найкращої з наявних. Перша — основна, решта — дзеркала.
func (s *server) refreshURLs(ctx context.Context, job *queueJob) ([]string, error) {
	status := s.currentBridgeStatus()
	if !status.Connected {
		return nil, errBridgeOffline
	}
	// Стара збірка розширення про цю команду не знає, і чекати на неї дві
	// хвилини означало б просто дві хвилини тиші.
	if status.UpdateAvailable {
		return nil, errors.New("у Firefox стара версія розширення: перезавантаж її в Діагностиці")
	}

	cmd := &resolveCommand{
		ID:           fmt.Sprintf("r%d", bridgeCommandSeq.Add(1)),
		URL:          job.PageURL,
		TranslatorID: job.TranslatorID,
		Voice:        job.Voice,
		Season:       job.Season,
		Episode:      fmt.Sprint(job.Episode),
	}
	done := make(chan resolveResult, 1)
	s.mu.Lock()
	if s.resolveWaiters == nil {
		s.resolveWaiters = make(map[string]chan resolveResult)
	}
	s.resolveWaiters[cmd.ID] = done
	s.resolveQueue = append(s.resolveQueue, cmd)
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.resolveWaiters, cmd.ID)
		for i, queued := range s.resolveQueue {
			if queued == cmd {
				s.resolveQueue = append(s.resolveQueue[:i], s.resolveQueue[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
	}()

	timer := time.NewTimer(resolveTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, errors.New("розширення не відповіло на запит свіжого посилання")
	case result := <-done:
		if result.Err != nil {
			return nil, result.Err
		}
		urls := pickQuality(result.Streams, job.Quality)
		if len(urls) == 0 {
			return nil, errors.New("сайт не віддав жодної адреси для цієї серії")
		}
		return urls, nil
	}
}

// pickQuality бере адреси потрібної якості, а без неї — найкращої.
func pickQuality(streams []streamOption, quality string) []string {
	if quality != "" {
		for _, option := range streams {
			if option.Quality == quality && len(option.URLs) > 0 {
				return option.URLs
			}
		}
	}
	var best []string
	bestScore := -1
	for _, option := range streams {
		if len(option.URLs) == 0 {
			continue
		}
		if score := qualityScore(option.Quality); score > bestScore {
			best, bestScore = option.URLs, score
		}
	}
	return best
}

// takeResolveCommands віддає розширенню накопичені запити.
func (s *server) takeResolveCommands(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	taken := s.resolveQueue
	s.resolveQueue = nil
	s.lastBridgeSeen = time.Now()
	s.mu.Unlock()

	if taken == nil {
		taken = []*resolveCommand{}
	}
	writeJSON(w, http.StatusOK, taken)
}

// reportResolved приймає свіжі адреси від розширення.
func (s *server) reportResolved(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ID      string         `json:"id"`
		Streams []streamOption `json:"streams"`
		Error   string         `json:"error"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	s.mu.Lock()
	done := s.resolveWaiters[request.ID]
	delete(s.resolveWaiters, request.ID)
	s.lastBridgeSeen = time.Now()
	s.mu.Unlock()

	// Ніхто не чекає — задачу вже скасували або вийшов час. Не помилка:
	// розширення однаково нічого з цим не зробило б.
	if done == nil {
		writeJSON(w, http.StatusOK, map[string]bool{"ignored": true})
		return
	}
	result := resolveResult{Streams: request.Streams}
	if request.Error != "" {
		result.Err = errors.New(request.Error)
	}
	done <- result
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
