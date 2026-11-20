// Benchmark local del prototipo replay F2.
package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/corpus"
	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/runner"
)

func main() {
	dir := flag.String("corpus", "parity/fixtures/replay/2026-11-12", "directorio del corpus")
	iterations := flag.Int("iterations", 1000, "iteraciones")
	flag.Parse()
	loaded, err := corpus.Load(*dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "replay-bench: %v\n", err)
		os.Exit(1)
	}
	for index := 0; index < 20; index++ {
		if _, err := runner.RunLoaded(loaded); err != nil {
			fmt.Fprintf(os.Stderr, "replay-bench warmup: %v\n", err)
			os.Exit(1)
		}
	}
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	durations := make([]time.Duration, 0, *iterations)
	started := time.Now()
	for index := 0; index < *iterations; index++ {
		start := time.Now()
		report, err := runner.RunLoaded(loaded)
		if err != nil {
			fmt.Fprintf(os.Stderr, "replay-bench: %v\n", err)
			os.Exit(1)
		}
		if report.Matched != report.Steps {
			fmt.Fprintf(os.Stderr, "replay-bench: pasos incompletos %+v\n", report)
			os.Exit(1)
		}
		durations = append(durations, time.Since(start))
	}
	total := time.Since(started)
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	sort.Slice(durations, func(left, right int) bool { return durations[left] < durations[right] })
	percentile := func(p float64) time.Duration {
		if len(durations) == 0 {
			return 0
		}
		index := int(float64(len(durations)-1) * p)
		return durations[index]
	}
	steps := *iterations * loaded.Manifest.Counts.Steps
	decisions := *iterations * loaded.Manifest.Counts.Decisions
	fmt.Printf(
		"replay-bench: iterations=%d total=%s p50=%s p95=%s p99=%s steps/s=%.0f decisions/s=%.0f alloc/iter=%.0f B rss=%.1fMB\n",
		*iterations, total.Round(time.Microsecond),
		percentile(0.50), percentile(0.95), percentile(0.99),
		float64(steps)/total.Seconds(), float64(decisions)/total.Seconds(),
		float64(after.TotalAlloc-before.TotalAlloc)/float64(*iterations),
		float64(rssKB())/1024,
	)
}

func rssKB() int64 {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				value, _ := strconv.ParseInt(fields[1], 10, 64)
				return value
			}
		}
	}
	return 0
}
