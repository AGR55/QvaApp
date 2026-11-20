package main

import (
	"errors"
	"fmt"
	"runtime"
	"sync"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/markethunting"
)

type mhSource struct {
	mode        func() string
	processNext func() error
	pollNext    func() (*markethunting.Update, error)
}

func (source *mhSource) Mode() string                             { return source.mode() }
func (source *mhSource) ProcessNext() error                       { return source.processNext() }
func (source *mhSource) PollNext() (*markethunting.Update, error) { return source.pollNext() }

type mhTrading struct {
	paused func() bool
	ingest func(markethunting.Update, bool, func() bool) error
}

func (trading *mhTrading) IsPaused() bool { return trading.paused() }
func (trading *mhTrading) Ingest(update markethunting.Update, realtime bool, isCurrent func() bool) error {
	return trading.ingest(update, realtime, isCurrent)
}

type mhActivity struct {
	ch chan struct{}
}

func newMHActivity() *mhActivity {
	return &mhActivity{ch: make(chan struct{}, 256)}
}

func (activity *mhActivity) signal() {
	activity.ch <- struct{}{}
}

func (activity *mhActivity) wait(count int) {
	for index := 0; index < count; index++ {
		<-activity.ch
	}
}

func mhPage(coin string, scannedAt int64, sequence *int64) markethunting.Update {
	return markethunting.Update{Coin: coin, Side: "sell", ScannedAt: scannedAt, DispatchSequence: sequence}
}

func mhPollSequence(updates []markethunting.Update) func() (*markethunting.Update, error) {
	var mu sync.Mutex
	index := 0
	return func() (*markethunting.Update, error) {
		mu.Lock()
		defer mu.Unlock()
		if index >= len(updates) {
			return nil, nil
		}
		update := updates[index]
		index++
		return &update, nil
	}
}

func mhNew(source *mhSource, trading *mhTrading, options markethunting.Options) *markethunting.Loops {
	return markethunting.New(source, trading, options)
}

func mhWaitStopped(loops *markethunting.Loops) {
	for attempt := 0; attempt < 10_000 && !loops.Stopped(); attempt++ {
		runtime.Gosched()
	}
}

func mhPollingProgress() (any, *opError) {
	entered := make(chan struct{})
	blocked := make(chan struct{})
	var enteredOnce sync.Once
	polls := 0
	ingested := 0
	activity := newMHActivity()
	source := &mhSource{
		mode: func() string { return "hybrid" },
		processNext: func() error {
			enteredOnce.Do(func() { close(entered) })
			<-blocked
			return nil
		},
		pollNext: func() (*markethunting.Update, error) {
			polls++
			update := mhPage("BANK_CUP", 1000, nil)
			return &update, nil
		},
	}
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, realtime bool, _ func() bool) error {
			if update.Coin != "BANK_CUP" || !realtime {
				return errors.New("ingesta inesperada")
			}
			ingested++
			activity.signal()
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{})
	feed := make(chan bool, 1)
	go func() { feed <- loops.Feed() }()
	<-entered
	<-loops.Scan()
	activity.wait(1)
	pollsAfter := polls
	ingestedAfter := ingested
	secondFeed := loops.Feed()
	close(blocked)
	<-feed
	loops.Stop()
	return map[string]any{"scan": true, "polls": pollsAfter, "ingested": ingestedAfter, "secondFeed": secondFeed}, nil
}

func mhFeedProgress() (any, *opError) {
	blocked := make(chan struct{})
	polls := 0
	feed := 0
	paused := false
	source := &mhSource{
		mode:        func() string { return "hybrid" },
		processNext: func() error { feed++; return nil },
		pollNext: func() (*markethunting.Update, error) {
			polls++
			<-blocked
			return nil, nil
		},
	}
	trading := &mhTrading{
		paused: func() bool { return paused },
		ingest: func(markethunting.Update, bool, func() bool) error { return nil },
	}
	loops := mhNew(source, trading, markethunting.Options{})
	scanDone := loops.Scan()
	feedRun := loops.Feed()
	feedAfter := feed
	close(blocked)
	<-scanDone
	paused = true
	<-loops.Scan()
	loops.Feed()
	pollsAfter := polls
	feedTotal := feed
	loops.Stop()
	return map[string]any{"feedRun": feedRun, "feedAfter": feedAfter, "polls": pollsAfter, "feedTotal": feedTotal}, nil
}

func mhLatestPage() (any, *opError) {
	blocked := make(chan struct{})
	activity := newMHActivity()
	updates := []markethunting.Update{
		mhPage("BANK_CUP", 1000, nil),
		mhPage("BANK_CUP", 2000, nil),
		mhPage("BANK_CUP", 3000, nil),
		mhPage("BANK_CUP", 2500, nil),
		mhPage("ZELLE", 4000, nil),
	}
	source := &mhSource{mode: func() string { return "hybrid" }, processNext: func() error { return nil }, pollNext: mhPollSequence(updates)}
	var mu sync.Mutex
	ingested := make([]markethunting.Update, 0)
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, _ bool, _ func() bool) error {
			mu.Lock()
			ingested = append(ingested, update)
			mu.Unlock()
			defer activity.signal()
			if update.ScannedAt == 1000 {
				<-blocked
			}
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{})
	for index := 0; index < 5; index++ {
		<-loops.Scan()
	}
	mu.Lock()
	before := make([]int64, 0, len(ingested))
	for _, update := range ingested {
		before = append(before, update.ScannedAt)
	}
	mu.Unlock()
	close(blocked)
	activity.wait(3)
	mu.Lock()
	after := make([]any, 0, len(ingested))
	for _, update := range ingested {
		after = append(after, map[string]any{"scannedAt": update.ScannedAt, "realtimeRecovery": true})
	}
	mu.Unlock()
	loops.Stop()
	return map[string]any{"remaining": 0, "before": before, "after": after}, nil
}

func mhIngestError() (any, *opError) {
	blocked := make(chan error, 1)
	activity := newMHActivity()
	updates := []markethunting.Update{mhPage("BANK_CUP", 1000, nil), mhPage("BANK_CUP", 2000, nil)}
	source := &mhSource{mode: func() string { return "hybrid" }, processNext: func() error { return nil }, pollNext: mhPollSequence(updates)}
	var mu sync.Mutex
	ingested := make([]int64, 0)
	errorsSeen := make([]string, 0)
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, _ bool, _ func() bool) error {
			mu.Lock()
			ingested = append(ingested, update.ScannedAt)
			mu.Unlock()
			defer activity.signal()
			if update.ScannedAt == 1000 {
				return <-blocked
			}
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{OnError: func(err error) {
		mu.Lock()
		errorsSeen = append(errorsSeen, err.Error())
		mu.Unlock()
	}})
	<-loops.Scan()
	<-loops.Scan()
	blocked <- errors.New("fallo")
	activity.wait(2)
	mu.Lock()
	defer mu.Unlock()
	loops.Stop()
	return map[string]any{"errors": errorsSeen, "ingested": ingested}, nil
}

func mhPauseStop() (any, *opError) {
	outcomes := make([]any, 0, 2)
	for _, stop := range []bool{false, true} {
		blocked := make(chan struct{})
		activity := newMHActivity()
		updates := []markethunting.Update{mhPage("BANK_CUP", 1000, nil), mhPage("BANK_CUP", 2000, nil)}
		paused := false
		ingested := 0
		source := &mhSource{mode: func() string { return "hybrid" }, processNext: func() error { return nil }, pollNext: mhPollSequence(updates)}
		trading := &mhTrading{
			paused: func() bool { return paused },
			ingest: func(markethunting.Update, bool, func() bool) error {
				ingested++
				defer activity.signal()
				<-blocked
				return nil
			},
		}
		loops := mhNew(source, trading, markethunting.Options{})
		<-loops.Scan()
		<-loops.Scan()
		var stopDone chan struct{}
		if stop {
			stopDone = make(chan struct{})
			go func() {
				loops.Stop()
				close(stopDone)
			}()
			mhWaitStopped(loops)
		} else {
			paused = true
		}
		close(blocked)
		activity.wait(1)
		if stop {
			<-stopDone
		} else {
			loops.Stop()
		}
		outcomes = append(outcomes, map[string]any{"stop": stop, "ingested": ingested})
	}
	return map[string]any{"outcomes": outcomes}, nil
}

func mhGenerationInvalidate() (any, *opError) {
	ingestion := make(chan struct{})
	polling := make(chan struct{})
	version := 0
	calls := 0
	var mu sync.Mutex
	ingested := make([]int64, 0)
	activity := newMHActivity()
	source := &mhSource{
		mode:        func() string { return "hybrid" },
		processNext: func() error { return nil },
		pollNext: func() (*markethunting.Update, error) {
			mu.Lock()
			calls++
			call := calls
			mu.Unlock()
			if call == 3 {
				<-polling
			}
			update := mhPage("BANK_CUP", int64(call)*1000, nil)
			return &update, nil
		},
	}
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, _ bool, _ func() bool) error {
			mu.Lock()
			ingested = append(ingested, update.ScannedAt)
			mu.Unlock()
			defer activity.signal()
			<-ingestion
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{Generation: func() string {
		mu.Lock()
		defer mu.Unlock()
		return fmt.Sprintf("%d", version)
	}})
	<-loops.Scan()
	<-loops.Scan()
	third := loops.Scan()
	mu.Lock()
	version++
	mu.Unlock()
	close(polling)
	<-third
	close(ingestion)
	activity.wait(1)
	loops.Stop()
	mu.Lock()
	defer mu.Unlock()
	return map[string]any{"ingested": ingested}, nil
}

func mhStopWaits() (any, *opError) {
	feedGate := make(chan struct{})
	pollGate := make(chan struct{})
	ingestion := make(chan struct{})
	activity := newMHActivity()
	calls := 0
	var mu sync.Mutex
	source := &mhSource{
		mode:        func() string { return "hybrid" },
		processNext: func() error { <-feedGate; return nil },
		pollNext: func() (*markethunting.Update, error) {
			mu.Lock()
			calls++
			call := calls
			mu.Unlock()
			if call == 2 {
				<-pollGate
			}
			update := mhPage("BANK_CUP", 1000, nil)
			return &update, nil
		},
	}
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(markethunting.Update, bool, func() bool) error {
			defer activity.signal()
			<-ingestion
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{})
	<-loops.Scan()
	feedDone := make(chan bool, 1)
	go func() { feedDone <- loops.Feed() }()
	pollDone := loops.Scan()
	stopDone := make(chan struct{})
	go func() {
		loops.Stop()
		close(stopDone)
	}()
	mhWaitStopped(loops)
	close(feedGate)
	close(pollGate)
	<-feedDone
	<-pollDone
	select {
	case <-stopDone:
		// No debe cerrarse antes de liberar la ingesta.
	default:
	}
	before := false
	close(ingestion)
	<-stopDone
	after := true
	return map[string]any{"beforeIngestion": before, "afterIngestion": after}, nil
}

func mhTiming() (any, *opError) {
	blocked := make(chan struct{})
	var clock int64 = 10
	updates := []markethunting.Update{mhPage("BANK_CUP", 1000, nil), mhPage("BANK_CUP", 2000, nil)}
	source := &mhSource{mode: func() string { return "hybrid" }, processNext: func() error { return nil }, pollNext: mhPollSequence(updates)}
	var mu sync.Mutex
	timings := make([]any, 0)
	activity := newMHActivity()
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, _ bool, _ func() bool) error {
			defer activity.signal()
			if update.ScannedAt == 1000 {
				<-blocked
			} else {
				mu.Lock()
				clock = 40
				mu.Unlock()
			}
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{
		MonotonicNow: func() int64 {
			mu.Lock()
			defer mu.Unlock()
			return clock
		},
		OnTiming: func(timing markethunting.Timing) {
			mu.Lock()
			timings = append(timings, map[string]any{
				"queueMs":      timing.QueueMs,
				"evaluationMs": timing.EvaluationMs,
				"outcome":      timing.Outcome,
			})
			mu.Unlock()
			panic("telemetría")
		},
	})
	<-loops.Scan()
	mu.Lock()
	clock = 15
	mu.Unlock()
	<-loops.Scan()
	mu.Lock()
	clock = 30
	mu.Unlock()
	close(blocked)
	activity.wait(2)
	loops.Stop()
	mu.Lock()
	defer mu.Unlock()
	return map[string]any{"timings": timings}, nil
}

func mhGenerationReplaces() (any, *opError) {
	blocked := make(chan struct{})
	activity := newMHActivity()
	var mu sync.Mutex
	version := 0
	ingested := make([]int64, 0)
	updates := []markethunting.Update{
		mhPage("BANK_CUP", 1000, nil),
		mhPage("BANK_CUP", 3000, nil),
		mhPage("BANK_CUP", 2000, nil),
	}
	source := &mhSource{mode: func() string { return "hybrid" }, processNext: func() error { return nil }, pollNext: mhPollSequence(updates)}
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, _ bool, _ func() bool) error {
			mu.Lock()
			ingested = append(ingested, update.ScannedAt)
			mu.Unlock()
			defer activity.signal()
			if update.ScannedAt == 1000 {
				<-blocked
			}
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{Generation: func() string {
		mu.Lock()
		defer mu.Unlock()
		return fmt.Sprintf("%d", version)
	}})
	<-loops.Scan()
	<-loops.Scan()
	mu.Lock()
	version++
	mu.Unlock()
	<-loops.Scan()
	close(blocked)
	activity.wait(2)
	loops.Stop()
	mu.Lock()
	defer mu.Unlock()
	return map[string]any{"ingested": ingested}, nil
}

func mhDispatchSequence() (any, *opError) {
	blocked := make(chan struct{})
	activity := newMHActivity()
	one, two, three := int64(1), int64(2), int64(3)
	updates := []markethunting.Update{
		mhPage("BANK_CUP", 1000, &one),
		mhPage("BANK_CUP", 3000, &two),
		mhPage("BANK_CUP", 2000, &three),
		mhPage("BANK_CUP", 4000, &two),
	}
	source := &mhSource{mode: func() string { return "hybrid" }, processNext: func() error { return nil }, pollNext: mhPollSequence(updates)}
	var mu sync.Mutex
	ingested := make([]any, 0)
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, _ bool, _ func() bool) error {
			mu.Lock()
			value := int64(-1)
			if update.DispatchSequence != nil {
				value = *update.DispatchSequence
			}
			ingested = append(ingested, value)
			mu.Unlock()
			defer activity.signal()
			if value == 1 {
				<-blocked
			}
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{})
	for index := 0; index < 4; index++ {
		<-loops.Scan()
	}
	close(blocked)
	activity.wait(2)
	loops.Stop()
	mu.Lock()
	defer mu.Unlock()
	return map[string]any{"ingested": ingested}, nil
}

func mhSlowRead() (any, *opError) {
	var mu sync.Mutex
	calls := 0
	releases := make([]chan struct{}, 0)
	callStarted := make(chan int, 16)
	activity := newMHActivity()
	ingested := make([]int64, 0)
	source := &mhSource{
		mode:        func() string { return "hybrid" },
		processNext: func() error { return nil },
		pollNext: func() (*markethunting.Update, error) {
			mu.Lock()
			calls++
			call := calls
			var release chan struct{}
			if call != 2 {
				release = make(chan struct{})
				releases = append(releases, release)
			}
			mu.Unlock()
			callStarted <- call
			if release != nil {
				<-release
			}
			update := mhPage("BANK_CUP", int64(call)*1000, nil)
			return &update, nil
		},
	}
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, _ bool, _ func() bool) error {
			mu.Lock()
			ingested = append(ingested, update.ScannedAt)
			mu.Unlock()
			activity.signal()
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{})
	loops.Scan()
	<-callStarted
	<-loops.Scan()
	<-callStarted
	activity.wait(1)
	mu.Lock()
	first := append([]int64(nil), ingested...)
	mu.Unlock()
	for index := 0; index < 4; index++ {
		done := loops.Scan()
		select {
		case <-callStarted:
		case <-done:
		}
	}
	mu.Lock()
	callsAfter := calls
	mu.Unlock()
	stopDone := make(chan struct{})
	go func() {
		loops.Stop()
		close(stopDone)
	}()
	mhWaitStopped(loops)
	mu.Lock()
	stoppedBeforeRelease := false
	releasesCopy := append([]chan struct{}(nil), releases...)
	mu.Unlock()
	for _, release := range releasesCopy {
		close(release)
	}
	<-stopDone
	mu.Lock()
	after := append([]int64(nil), ingested...)
	mu.Unlock()
	return map[string]any{
		"first":                first,
		"calls":                callsAfter,
		"stoppedBeforeRelease": stoppedBeforeRelease,
		"after":                after,
	}, nil
}

func mhDiscardReasons() (any, *opError) {
	outcomes := make([]any, 0, 2)
	for _, finalReason := range []string{"control", "shutdown"} {
		blocked := make(chan struct{})
		paused := false
		var mu sync.Mutex
		reasons := make([]string, 0)
		updates := []markethunting.Update{mhPage("BANK_CUP", 1000, nil), mhPage("BANK_CUP", 2000, nil), mhPage("BANK_CUP", 3000, nil)}
		for index := 0; index < 65; index++ {
			updates = append(updates, mhPage(fmt.Sprintf("TEST_%d", index), int64(4000+index), nil))
		}
		source := &mhSource{mode: func() string { return "hybrid" }, processNext: func() error { return nil }, pollNext: mhPollSequence(updates)}
		trading := &mhTrading{
			paused: func() bool { return paused },
			ingest: func(markethunting.Update, bool, func() bool) error {
				<-blocked
				return nil
			},
		}
		loops := mhNew(source, trading, markethunting.Options{OnTiming: func(timing markethunting.Timing) {
			if timing.Reason != "" {
				mu.Lock()
				reasons = append(reasons, timing.Reason)
				mu.Unlock()
			}
		}})
		for index := 0; index < len(updates); index++ {
			<-loops.Scan()
		}
		if finalReason == "control" {
			paused = true
			<-loops.Scan()
		}
		stopDone := make(chan struct{})
		go func() {
			loops.Stop()
			close(stopDone)
		}()
		mhWaitStopped(loops)
		close(blocked)
		<-stopDone
		mu.Lock()
		outcomes = append(outcomes, map[string]any{"finalReason": finalReason, "reasons": append([]string(nil), reasons...)})
		mu.Unlock()
	}
	return map[string]any{"outcomes": outcomes}, nil
}

func mhQueueLimit() (any, *opError) {
	blocked := make(chan struct{})
	activity := newMHActivity()
	updates := []markethunting.Update{mhPage("BANK_CUP", 1000, nil)}
	for index := 0; index < 65; index++ {
		updates = append(updates, mhPage(fmt.Sprintf("TEST_%d", index), int64(2000+index), nil))
	}
	source := &mhSource{mode: func() string { return "hybrid" }, processNext: func() error { return nil }, pollNext: mhPollSequence(updates)}
	var mu sync.Mutex
	ingested := make([]markethunting.Update, 0)
	trading := &mhTrading{
		paused: func() bool { return false },
		ingest: func(update markethunting.Update, _ bool, _ func() bool) error {
			mu.Lock()
			ingested = append(ingested, update)
			mu.Unlock()
			defer activity.signal()
			if update.Coin == "BANK_CUP" && update.ScannedAt == 1000 {
				<-blocked
			}
			return nil
		},
	}
	loops := mhNew(source, trading, markethunting.Options{})
	for index := 0; index < 66; index++ {
		<-loops.Scan()
	}
	close(blocked)
	activity.wait(65)
	loops.Stop()
	mu.Lock()
	defer mu.Unlock()
	firstAfterHead := any(nil)
	if len(ingested) > 1 {
		firstAfterHead = ingested[1].Coin
	}
	last := any(nil)
	if len(ingested) > 0 {
		last = ingested[len(ingested)-1].Coin
	}
	return map[string]any{"count": len(ingested), "firstAfterHead": firstAfterHead, "last": last}, nil
}
