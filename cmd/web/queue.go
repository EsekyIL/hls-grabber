package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"hls-grabber/internal/config"
	"hls-grabber/internal/downloader"
)

type queueJob struct {
	ID        string    `json:"id"`
	Mode      string    `json:"mode"`
	URL       string    `json:"url"`
	Title     string    `json:"title"`
	Voice     string    `json:"voice,omitempty"`
	Season    string    `json:"season,omitempty"`
	Episode   int       `json:"episode,omitempty"`
	OutputDir string    `json:"outputDir,omitempty"`
	State     string    `json:"state"`
	Percent   float64   `json:"percent"`
	Message   string    `json:"message,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type queueManager struct {
	mu      sync.Mutex
	jobs    []*queueJob
	active  string
	wake    chan struct{}
	path    string
	dl      *downloader.Downloader
	cfg     *config.Config
	publish func(downloader.DownloadStats)
}

func newQueueManager(cfg *config.Config, dl *downloader.Downloader, publish func(downloader.DownloadStats)) (*queueManager, error) {
	configPath, err := config.Path()
	if err != nil {
		return nil, err
	}
	q := &queueManager{cfg: cfg, dl: dl, publish: publish, wake: make(chan struct{}, 1), path: filepath.Join(filepath.Dir(configPath), "queue.json")}
	if data, err := os.ReadFile(q.path); err == nil {
		_ = json.Unmarshal(data, &q.jobs)
	}
	for _, job := range q.jobs {
		if job.State == "running" {
			job.State = "pending"
		}
	}
	if err := q.saveLocked(); err != nil {
		return nil, err
	}
	return q, nil
}

func (q *queueManager) start() { go q.worker(); q.signal() }
func (q *queueManager) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *queueManager) enqueue(request downloadRequest) ([]*queueJob, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	now := time.Now()
	created := make([]*queueJob, 0)
	add := func(url, voice, season string, episode int) {
		job := &queueJob{ID: fmt.Sprintf("%d-%d", now.UnixNano(), len(q.jobs)+len(created)), Mode: request.Mode, URL: strings.TrimSpace(url), Title: strings.TrimSpace(request.Title), Voice: strings.TrimSpace(voice), Season: strings.TrimSpace(season), Episode: episode, OutputDir: strings.TrimSpace(request.OutputDir), State: "pending", CreatedAt: now, UpdatedAt: now}
		created = append(created, job)
	}
	if request.Mode == "movie" {
		add(request.URL, "", "", 0)
	} else {
		for _, item := range request.Items {
			if strings.TrimSpace(item.URL) == "" || strings.TrimSpace(item.Season) == "" || item.Episode < 1 {
				continue
			}
			add(item.URL, item.Voice, item.Season, item.Episode)
		}
		if len(created) > 0 {
			q.jobs = append(q.jobs, created...)
			if err := q.saveLocked(); err != nil {
				return nil, err
			}
			q.signal()
			return created, nil
		}
		start, _ := strconv.Atoi(request.StartEpisode)
		if start < 1 {
			start = 1
		}
		urls := request.URLs
		if request.Source == "list" {
			data, err := os.ReadFile(filepath.Join(q.cfg.Paths.LinksDir, strings.TrimSpace(request.URL)))
			if err != nil {
				return nil, err
			}
			for _, line := range strings.Split(string(data), "\n") {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasPrefix(line, "#") && !strings.HasPrefix(line, ";") {
					urls = append(urls, line)
				}
			}
		}
		for index, url := range urls {
			if strings.TrimSpace(url) != "" {
				add(url, "", request.Season, start+index)
			}
		}
	}
	if len(created) == 0 {
		return nil, fmt.Errorf("no downloadable URLs")
	}
	q.jobs = append(q.jobs, created...)
	if err := q.saveLocked(); err != nil {
		return nil, err
	}
	q.signal()
	return created, nil
}

func (q *queueManager) snapshot() []*queueJob {
	q.mu.Lock()
	defer q.mu.Unlock()
	result := make([]*queueJob, len(q.jobs))
	for i, job := range q.jobs {
		copy := *job
		result[i] = &copy
	}
	return result
}

func (q *queueManager) worker() {
	for range q.wake {
		for {
			q.mu.Lock()
			var job *queueJob
			for _, candidate := range q.jobs {
				if candidate.State == "pending" {
					job = candidate
					break
				}
			}
			if job == nil {
				q.mu.Unlock()
				break
			}
			job.State, job.UpdatedAt, q.active = "running", time.Now(), job.ID
			_ = q.saveLocked()
			q.mu.Unlock()
			var err error
			if job.Mode == "movie" {
				err = q.dl.DownloadMovie(context.Background(), job.URL, job.Title, job.OutputDir)
			} else {
				err = q.dl.DownloadSeriesEpisode(context.Background(), job.URL, job.Title, job.Voice, job.Season, job.Episode, job.OutputDir)
			}
			q.mu.Lock()
			q.active = ""
			job.UpdatedAt = time.Now()
			job.Percent = 100
			if job.State == "cancelled" {
				job.Message = "Скасовано"
			} else if err != nil {
				job.State, job.Message = "error", err.Error()
			} else {
				job.State, job.Message = "finished", "Завершено"
			}
			_ = q.saveLocked()
			q.mu.Unlock()
		}
	}
}

func (q *queueManager) progress(stats downloader.DownloadStats) {
	q.mu.Lock()
	for _, job := range q.jobs {
		if job.ID == q.active {
			job.Percent, job.Message, job.UpdatedAt = stats.Percent, stats.Message, time.Now()
			break
		}
	}
	_ = q.saveLocked()
	q.mu.Unlock()
	q.publish(stats)
}

func (q *queueManager) clearFinished() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	kept := q.jobs[:0]
	for _, job := range q.jobs {
		if job.State != "finished" && job.State != "error" {
			kept = append(kept, job)
		}
	}
	q.jobs = kept
	return q.saveLocked()
}

func (q *queueManager) action(id, action string) error {
	q.mu.Lock()
	index := -1
	for i, job := range q.jobs {
		if job.ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		q.mu.Unlock()
		return fmt.Errorf("queue job not found")
	}
	job := q.jobs[index]
	cancelActive := false
	switch action {
	case "remove":
		if job.State == "running" {
			q.mu.Unlock()
			return fmt.Errorf("stop the active job before removing it")
		}
		q.jobs = append(q.jobs[:index], q.jobs[index+1:]...)
	case "retry":
		if job.State != "error" && job.State != "cancelled" {
			q.mu.Unlock()
			return fmt.Errorf("only failed or cancelled jobs can be retried")
		}
		job.State, job.Message, job.Percent, job.UpdatedAt = "pending", "", 0, time.Now()
	case "up":
		if job.State != "pending" || index == 0 {
			q.mu.Unlock()
			return nil
		}
		q.jobs[index-1], q.jobs[index] = q.jobs[index], q.jobs[index-1]
	case "down":
		if job.State != "pending" || index == len(q.jobs)-1 {
			q.mu.Unlock()
			return nil
		}
		q.jobs[index+1], q.jobs[index] = q.jobs[index], q.jobs[index+1]
	case "cancel":
		if job.State == "running" {
			job.State, job.Message, job.UpdatedAt = "cancelled", "Скасовано", time.Now()
			cancelActive = true
		} else if job.State == "pending" {
			job.State, job.Message, job.UpdatedAt = "cancelled", "Скасовано", time.Now()
		}
	default:
		q.mu.Unlock()
		return fmt.Errorf("unknown queue action")
	}
	err := q.saveLocked()
	q.mu.Unlock()
	if cancelActive {
		q.dl.CancelActive()
	}
	q.signal()
	return err
}

func (q *queueManager) stopAll() error {
	q.mu.Lock()
	for _, job := range q.jobs {
		if job.State == "pending" || job.State == "running" {
			job.State, job.Message, job.UpdatedAt = "cancelled", "Скасовано", time.Now()
		}
	}
	err := q.saveLocked()
	q.mu.Unlock()
	q.dl.CancelActive()
	return err
}

func (q *queueManager) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(q.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(q.jobs, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(q.path, data, 0o644)
}
