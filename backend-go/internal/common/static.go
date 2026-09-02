package common

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// ServeSPA — раздача собранного фронтенда (vite build) из dir: файл по
// пути, если он есть; иначе index.html (маршруты React Router). Хэшированные
// ассеты Vite (/assets/*) можно кэшировать навсегда, index.html — нет.
// Возвращает false, если dir не задан или путь ведёт мимо каталога.
func ServeSPA(c *gin.Context, dir string) bool {
	if dir == "" {
		return false
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	rel := filepath.Clean("/" + c.Request.URL.Path)
	target := filepath.Join(root, rel)
	if !strings.HasPrefix(target, root+string(os.PathSeparator)) && target != root {
		return false
	}
	if st, err := os.Stat(target); err == nil && !st.IsDir() {
		if strings.HasPrefix(rel, "/assets/") {
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.ServeFile(c.Writer, c.Request, target)
		return true
	}
	index := filepath.Join(root, "index.html")
	if _, err := os.Stat(index); err != nil {
		return false
	}
	c.Header("Cache-Control", "no-cache")
	http.ServeFile(c.Writer, c.Request, index)
	return true
}
