package main

import (
	"fmt"
	"sync"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/huntingbalance"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/scheduler"
)

func huntingBalanceStop() (any, *opError) {
	plan := scheduler.New(nil)
	var mu sync.Mutex
	events := make([]string, 0)
	appendEvent := func(event string) {
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
	}
	contains := func(target string) bool {
		mu.Lock()
		defer mu.Unlock()
		for _, event := range events {
			if event == target {
				return true
			}
		}
		return false
	}
	countEvent := func(target string) int {
		mu.Lock()
		defer mu.Unlock()
		count := 0
		for _, event := range events {
			if event == target {
				count++
			}
		}
		return count
	}

	warmEntered := make(chan struct{})
	prepareEntered := make(chan struct{})
	warming := make(chan struct{})
	preparation := make(chan struct{})

	loops, err := huntingbalance.Register(plan, huntingbalance.Dependencies{
		RefreshQusd: func() error {
			appendEvent("warm")
			close(warmEntered)
			<-warming
			appendEvent("warm-completed")
			return nil
		},
		Prepare: func() error {
			appendEvent("prepare")
			close(prepareEntered)
			<-preparation
			appendEvent("prepare-completed")
			return nil
		},
		StopReads: func() error {
			appendEvent("cache-stopped")
			return nil
		},
	})
	if err != nil {
		return nil, validation(fmt.Sprintf("no se pudieron registrar los bucles: %v", err))
	}

	warmDone := make(chan struct{})
	go func() {
		_, _ = plan.Run("hunting_balance")
		close(warmDone)
	}()
	<-warmEntered
	prepareDone := make(chan struct{})
	go func() {
		_, _ = plan.Run("hunting_liquidity")
		close(prepareDone)
	}()
	<-prepareEntered

	stopDone := make(chan struct{})
	plan.Stop()
	go func() {
		loops.Stop()
		close(stopDone)
	}()

	close(warming)
	<-warmDone
	cacheStoppedAfterWarm := contains("cache-stopped")
	_, _ = plan.Run("hunting_balance")
	warmCount := countEvent("warm")
	close(preparation)
	<-prepareDone
	<-stopDone
	plan.Stop()

	mu.Lock()
	result := append([]string(nil), events...)
	mu.Unlock()
	return map[string]any{
		"events":                result,
		"cacheStoppedAfterWarm": cacheStoppedAfterWarm,
		"warmCount":             warmCount,
	}, nil
}
