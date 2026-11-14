package markethunting

import (
	"sync"
	"testing"
)

type testSource struct {
	mu     sync.Mutex
	update *Update
}

func (source *testSource) Mode() string       { return "hybrid" }
func (source *testSource) ProcessNext() error { return nil }
func (source *testSource) PollNext() (*Update, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	return source.update, nil
}

type testTrading struct {
	mu       sync.Mutex
	ingested int
}

func (trading *testTrading) IsPaused() bool { return false }
func (trading *testTrading) Ingest(Update, bool, func() bool) error {
	trading.mu.Lock()
	trading.ingested++
	trading.mu.Unlock()
	return nil
}

func TestScanAndStop(t *testing.T) {
	update := Update{Coin: "BANK_CUP", Side: "sell", ScannedAt: 1000}
	source := &testSource{update: &update}
	trading := &testTrading{}
	loops := New(source, trading, Options{})
	<-loops.Scan()
	loops.Stop()
	trading.mu.Lock()
	defer trading.mu.Unlock()
	if trading.ingested != 1 {
		t.Fatalf("ingested = %d, quiero 1", trading.ingested)
	}
	if !loops.Stopped() {
		t.Fatal("el motor debe quedar detenido")
	}
}

type blockingSource struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (source *blockingSource) Mode() string       { return "hybrid" }
func (source *blockingSource) ProcessNext() error { return nil }
func (source *blockingSource) PollNext() (*Update, error) {
	source.once.Do(func() { close(source.started) })
	<-source.release
	return nil, nil
}

func TestStopWaitsForScan(t *testing.T) {
	source := &blockingSource{started: make(chan struct{}), release: make(chan struct{})}
	loops := New(source, &testTrading{}, Options{})
	scanDone := loops.Scan()
	<-source.started
	stopDone := make(chan struct{})
	go func() {
		loops.Stop()
		close(stopDone)
	}()
	select {
	case <-stopDone:
		t.Fatal("Stop no debe terminar con un sondeo en vuelo")
	default:
	}
	close(source.release)
	<-scanDone
	<-stopDone
}
