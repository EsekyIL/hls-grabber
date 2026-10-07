package extensionassets

import "embed"

// Files contains the Firefox bridge shipped inside the local web executable.
//
//go:embed manifest.json service-worker.js content-script.js cdn-api.js uakino.js popup.html popup.js stay-awake.js Geist-Variable.woff2 Geist.LICENSE.txt
var Files embed.FS

const Version = "1.12.0"
