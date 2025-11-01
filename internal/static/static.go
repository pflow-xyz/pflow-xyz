package static

import (
	"embed"
	"io/fs"
)

//go:embed all:public
var publicFS embed.FS

// Public returns the embedded public filesystem
func Public() (fs.FS, error) {
	return fs.Sub(publicFS, "public")
}
