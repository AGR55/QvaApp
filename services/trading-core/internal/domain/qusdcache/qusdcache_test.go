package qusdcache

import (
	"sync"
	"sync/atomic"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func TestConcurrentGetsShareOneRead(t *testing.T) {
	var reads int64
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	cache := New(Runtime{
		Read: func(bool) (decimal.Value, error) {
			atomic.AddInt64(&reads, 1)
			once.Do(func() { close(started) })
			<-release
			return decimal.FromInt(10), nil
		},
		Epoch: func() string { return "1" },
		Now:   func() int64 { return 1_000 },
	})

	const workers = 20
	values := make(chan decimal.Value, workers)
	var wait sync.WaitGroup
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			value, err := cache.Get(Options{Priority: true})
			if err == nil {
				values <- value
			}
		}()
	}
	<-started
	close(release)
	wait.Wait()
	close(values)
	count := 0
	for value := range values {
		if value.Cmp(decimal.FromInt(10)) != 0 {
			t.Fatalf("saldo = %s", value.Format(8))
		}
		count++
	}
	if count != workers {
		t.Fatalf("valores = %d, quiero %d", count, workers)
	}
	if got := atomic.LoadInt64(&reads); got != 1 {
		t.Fatalf("lecturas = %d, quiero 1", got)
	}
	cache.Stop()
}

func TestStopWaitsForInFlightRead(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	cache := New(Runtime{
		Read: func(bool) (decimal.Value, error) {
			once.Do(func() { close(started) })
			<-release
			return decimal.FromInt(10), nil
		},
		Epoch: func() string { return "1" },
		Now:   func() int64 { return 1_000 },
	})

	finished := make(chan error, 1)
	go func() {
		_, err := cache.Get(Options{Priority: true})
		finished <- err
	}()
	<-started
	stopped := cache.BeginStop()
	select {
	case <-stopped:
		t.Fatal("Stop no debe terminar con una lectura en vuelo")
	default:
	}
	close(release)
	<-stopped
	if err := <-finished; err != ErrClosed {
		t.Fatalf("error = %v, quiero ErrClosed", err)
	}
}
