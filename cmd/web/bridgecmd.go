package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// Канал команд із панелі в розширення.
//
// Досі зв'язок був односторонній: розширення штовхало знайдені плейлисти в
// /api/inbox, а наказати йому щось панель не могла — сканування запускалось
// лише вручну з попапа, на відкритій сторінці.
//
// Черга, а не сокет. Розширення в Firefox живе як event page: його
// вивантажують між подіями, і будь-яке постійне з'єднання довелося б
// відновлювати після кожного пробудження. Черга ж переживає це сама — воркер
// прокидається, забирає накопичене й іде спати далі.
//
// Одна команда за раз і жодного паралелізму: сканування ходить по чужому
// сайту, який і без того сердиться на швидкість.

type bridgeCommandKind string

const (
	// probeCommand відкриває сторінку й повертає перелік озвучок. Окремо від
	// сканування, бо вибирати озвучки має людина, а для цього їх спершу
	// треба показати.
	probeCommand bridgeCommandKind = "probe"
	scanCommand  bridgeCommandKind = "scan"
)

type bridgeCommand struct {
	ID        string            `json:"id"`
	Kind      bridgeCommandKind `json:"kind"`
	URL       string            `json:"url"`
	Voices    []string          `json:"voices,omitempty"`
	CreatedAt time.Time         `json:"createdAt"`
}

// bridgeTranslator — одна озвучка зі сторінки.
type bridgeTranslator struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// bridgeSession — те, що бачить панель: остання команда та її наслідок.
//
// Один сеанс, а не історія: панель показує поточну роботу, а завершені лінки
// однаково лягають у inbox, який і є результатом.
type bridgeSession struct {
	Command     *bridgeCommand     `json:"command"`
	State       string             `json:"state"`
	Title       string             `json:"title"`
	Translators []bridgeTranslator `json:"translators"`
	Completed   int                `json:"completed"`
	Missed      int                `json:"missed"`
	Retries     int                `json:"retries"`
	Error       string             `json:"error"`
	UpdatedAt   time.Time          `json:"updatedAt"`
}

var bridgeCommandSeq atomic.Uint64

// enqueueBridgeCommand кладе команду й скидає стан сеансу.
func (s *server) enqueueBridgeCommand(kind bridgeCommandKind, url string, voices []string) *bridgeCommand {
	cmd := &bridgeCommand{
		ID:        fmt.Sprintf("%d", bridgeCommandSeq.Add(1)),
		Kind:      kind,
		URL:       strings.TrimSpace(url),
		Voices:    voices,
		CreatedAt: time.Now(),
	}
	s.mu.Lock()
	s.bridgeQueue = append(s.bridgeQueue, cmd)
	s.bridgeSession = bridgeSession{Command: cmd, State: "queued", UpdatedAt: time.Now()}
	s.mu.Unlock()
	return cmd
}

// startBridgeProbe — панель просить розібрати адресу.
func (s *server) startBridgeProbe(w http.ResponseWriter, r *http.Request) {
	var request struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !strings.HasPrefix(request.URL, "http") {
		writeError(w, http.StatusBadRequest, errBadURL)
		return
	}
	// Стан моста перевіряємо ДО постановки в чергу: команда, яку нема кому
	// забрати, просто висіла б у «queued», і панель показувала б вічне
	// очікування замість зрозумілої відмови.
	if !s.currentBridgeStatus().Connected {
		writeError(w, http.StatusConflict, errBridgeOffline)
		return
	}
	s.enqueueBridgeCommand(probeCommand, request.URL, nil)
	writeJSON(w, http.StatusOK, s.currentBridgeSession())
}

// startBridgeScan — панель просить обійти вибрані озвучки.
func (s *server) startBridgeScan(w http.ResponseWriter, r *http.Request) {
	var request struct {
		URL    string   `json:"url"`
		Voices []string `json:"voices"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !strings.HasPrefix(request.URL, "http") {
		writeError(w, http.StatusBadRequest, errBadURL)
		return
	}
	if len(request.Voices) == 0 {
		writeError(w, http.StatusBadRequest, errNoVoices)
		return
	}
	if !s.currentBridgeStatus().Connected {
		writeError(w, http.StatusConflict, errBridgeOffline)
		return
	}
	s.enqueueBridgeCommand(scanCommand, request.URL, request.Voices)
	writeJSON(w, http.StatusOK, s.currentBridgeSession())
}

// takeBridgeCommands віддає розширенню накопичене.
//
// Забираємо з черги одразу: повторна видача тієї самої команди означала б
// другий обхід того самого серіалу, а це десятки хвилин чужого трафіку.
// Ціна — команда, загублена разом із вивантаженою фоновою сторінкою; але
// панель бачить, що сеанс завис у «queued», і повторити його може людина.
func (s *server) takeBridgeCommands(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	taken := s.bridgeQueue
	s.bridgeQueue = nil
	if len(taken) > 0 {
		s.bridgeSession.State = "running"
		s.bridgeSession.UpdatedAt = time.Now()
	}
	s.lastBridgeSeen = time.Now()
	s.mu.Unlock()

	if taken == nil {
		taken = []*bridgeCommand{}
	}
	writeJSON(w, http.StatusOK, taken)
}

// reportBridgeResult приймає звіт розширення про хід і наслідок.
func (s *server) reportBridgeResult(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ID          string             `json:"id"`
		State       string             `json:"state"`
		Title       string             `json:"title"`
		Translators []bridgeTranslator `json:"translators"`
		Completed   int                `json:"completed"`
		Missed      int                `json:"missed"`
		Retries     int                `json:"retries"`
		Error       string             `json:"error"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	s.mu.Lock()
	// Звіт від чужої команди ігноруємо: розширення могло прокинутись зі
	// старим завданням уже після того, як людина запустила нове, і затерти
	// свіжий стан застарілим.
	if s.bridgeSession.Command == nil || s.bridgeSession.Command.ID != request.ID {
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]bool{"ignored": true})
		return
	}
	if request.State != "" {
		s.bridgeSession.State = request.State
	}
	if request.Title != "" {
		s.bridgeSession.Title = request.Title
	}
	if request.Translators != nil {
		s.bridgeSession.Translators = request.Translators
	}
	s.bridgeSession.Completed = request.Completed
	s.bridgeSession.Missed = request.Missed
	s.bridgeSession.Retries = request.Retries
	s.bridgeSession.Error = request.Error
	s.bridgeSession.UpdatedAt = time.Now()
	s.lastBridgeSeen = time.Now()
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) getBridgeSession(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.currentBridgeSession())
}

func (s *server) currentBridgeSession() bridgeSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bridgeSession
}
