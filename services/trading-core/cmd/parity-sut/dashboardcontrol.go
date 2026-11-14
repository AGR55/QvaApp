package main

import (
	"fmt"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/dashboardcontrol"
)

type controlTrading struct {
	calls         *[]string
	hunting       any
	activeMarkets []string
}

func (trading *controlTrading) SetPaused(paused bool, source string) {
	*trading.calls = append(*trading.calls, fmt.Sprintf("pause:%t:%s", paused, source))
}

func (trading *controlTrading) Activate() error {
	*trading.calls = append(*trading.calls, "activate")
	return nil
}

func (trading *controlTrading) UpdateHunting(value any) {
	trading.hunting = value
}

func (trading *controlTrading) ActiveMarkets() []string {
	return trading.activeMarkets
}

type controlRefreshers struct {
	calls *[]string
}

func (refreshers *controlRefreshers) RefreshBalance() error {
	*refreshers.calls = append(*refreshers.calls, "balance")
	return nil
}

func (refreshers *controlRefreshers) RefreshOwnOffers() error {
	*refreshers.calls = append(*refreshers.calls, "own")
	return nil
}

func (refreshers *controlRefreshers) RefreshTransactions() error {
	*refreshers.calls = append(*refreshers.calls, "transactions")
	return nil
}

func (refreshers *controlRefreshers) RefreshMarket(code string) error {
	*refreshers.calls = append(*refreshers.calls, code)
	return nil
}

func dashboardControlPause() (any, *opError) {
	calls := make([]string, 0)
	trading := &controlTrading{calls: &calls}
	service := dashboardcontrol.New(trading, &controlRefreshers{calls: &calls})
	if err := service.SetPaused(true); err != nil {
		return nil, validation(err.Error())
	}
	if err := service.SetPaused(false); err != nil {
		return nil, validation(err.Error())
	}
	return map[string]any{"calls": calls}, nil
}

func dashboardControlHunting(fields map[string]any) (any, *opError) {
	value, ok := fields["value"].(map[string]any)
	if !ok {
		return nil, validation("El campo value debe ser un objeto.")
	}
	calls := make([]any, 0)
	trading := &controlTrading{calls: new([]string), hunting: value}
	service := dashboardcontrol.New(trading, &controlRefreshers{calls: new([]string)})
	service.UpdateHunting(value)
	calls = append(calls, trading.hunting)
	return map[string]any{"calls": calls}, nil
}

func dashboardControlRefresh() (any, *opError) {
	firstCalls := make([]string, 0)
	firstTrading := &controlTrading{calls: &firstCalls, activeMarkets: []string{"CUP", "CLASICA"}}
	first := dashboardcontrol.New(firstTrading, &controlRefreshers{calls: &firstCalls})
	if err := first.RefreshCache(false); err != nil {
		return nil, validation(err.Error())
	}
	secondCalls := make([]string, 0)
	secondTrading := &controlTrading{calls: &secondCalls, activeMarkets: []string{"CUP", "CLASICA"}}
	second := dashboardcontrol.New(secondTrading, &controlRefreshers{calls: &secondCalls})
	if err := second.RefreshCache(true); err != nil {
		return nil, validation(err.Error())
	}
	return map[string]any{"first": firstCalls, "second": secondCalls}, nil
}
