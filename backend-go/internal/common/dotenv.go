package common

import (
	"bufio"
	"os"
	"strings"
)

// LoadDotEnv подхватывает backend/.env для консольных команд (cmd/recalc,
// cmd/smoke), которые запускают руками, а не через docker compose.
//
// Правила те же, что были у dev.sh и у dotenv в Nest: уже заданные переменные
// окружения НЕ перекрываются, обрамляющие кавычки снимаются, $ не
// раскрывается, комментарии и пустые строки пропускаются. Файла нет — молча
// ничего не делаем: в контейнере переменные приходят из compose.
func LoadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimSuffix(sc.Text(), "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(strings.TrimPrefix(key, "export "))
		if key == "" {
			continue
		}
		val = strings.TrimSpace(val)
		if len(val) >= 2 && (val[0] == '"' && val[len(val)-1] == '"' || val[0] == '\'' && val[len(val)-1] == '\'') {
			val = val[1 : len(val)-1]
		}
		if _, already := os.LookupEnv(key); !already {
			os.Setenv(key, val)
		}
	}
}
