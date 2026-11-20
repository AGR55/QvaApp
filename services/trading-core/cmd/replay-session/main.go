// Comando que ejecuta el corpus replay completo de F2.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/runner"
)

func main() {
	dir := flag.String("corpus", "parity/fixtures/replay/2026-11-12", "directorio del corpus")
	flag.Parse()
	report, err := runner.RunCorpus(*dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "replay-session: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf(
		"replay-session: %d/%d casos · %d/%d pasos\n",
		report.Cases, report.Cases, report.Matched, report.Steps,
	)
	if report.Matched != report.Steps {
		os.Exit(1)
	}
}
