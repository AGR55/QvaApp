// Comando de diagnóstico del corpus de replay para F2.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/corpus"
)

func main() {
	dir := flag.String("corpus", "parity/fixtures/replay/2026-11-12", "directorio del corpus")
	flag.Parse()
	loaded, err := corpus.Load(*dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "replay-probe: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf(
		"replay-probe: corpus=%s events=%d scenarios=%d steps=%d decisions=%d\n",
		loaded.Manifest.Corpus,
		loaded.Manifest.Counts.Events,
		loaded.Manifest.Counts.Scenarios,
		loaded.Manifest.Counts.Steps,
		loaded.Manifest.Counts.Decisions,
	)
}
