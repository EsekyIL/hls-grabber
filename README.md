
# hls-grabber

CLI utility for downloading movies and TV series from HLS sources using **yt-dlp**.

The project is designed for **local viewing**, clean folder structure, and manual control over episode URLs (for example, collected via browser DevTools or Video DownloadHelper).

No scraping, no website automation — only a controlled download pipeline.

---

## Features

- Movie and Series modes
- Parallel downloads with configurable limit
- Resume and retry support
- Graceful shutdown (Ctrl+C)
- Clean and predictable folder structure
- Series naming without underscores
- Episodes named strictly as `S1E01.mp4`
- YAML-based configuration
- Windows-focused workflow
- Uses external `yt-dlp` and `ffmpeg`

---

## Folder Structure

### Movies

```
Videos/
└── films/
    └── Movie Name.mp4
```

### Series

```
Videos/
└── serials/
    └── Series Name/
        └── Season 1/
            ├── S1E01.mp4
            ├── S1E02.mp4
            └── S1E03.mp4
```

This structure is optimal for **local playback** and can be used by media servers if needed later.

---

## Requirements

- Windows
- Go 1.22+
- yt-dlp
- ffmpeg

---

## Configuration

The application is configured using a YAML file.

Create your own configuration file from the example:

```bash
copy config.example.yaml config.yaml
```

Then edit `config.yaml` and adjust all paths and settings according to your system.

The `config.yaml` file is ignored by git and must not be committed.

---

## Usage

Run directly:

```bash
go run .
```

Build executable:

```bash
go build -o hls-grabber.exe
```

---

## Notes

- Episode URLs must be collected manually (for example via browser DevTools or Video DownloadHelper).
- The program does **not** scrape or automate websites.
- Intended for **personal, local use only**.
- No media content is included or distributed with this project.

---

## License

MIT
