package main

import (
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/dashboard"
)

func dashboardMarginResult(margin dashboard.Margin) map[string]any {
	return map[string]any{
		"cost":          margin.Cost.Format(8),
		"grossRevenue":  margin.GrossRevenue.Format(8),
		"netRevenue":    margin.NetRevenue.Format(8),
		"netProfit":     margin.NetProfit.Format(8),
		"marginPercent": margin.MarginPercent.Format(8),
		"breakEvenRate": margin.BreakEvenRate.Format(8),
	}
}

func dashboardAllocationResult(allocations []dashboard.Allocation) []any {
	result := make([]any, 0, len(allocations))
	for _, allocation := range allocations {
		result = append(result, map[string]any{
			"rate": allocation.Rate.Format(8),
			"fiat": allocation.Fiat.Format(8),
			"qusd": allocation.Qusd.Format(8),
		})
	}
	return result
}

func dashboardHistoryPoints(raw []any) ([]dashboard.HistoryPoint, []map[string]any, *opError) {
	points := make([]dashboard.HistoryPoint, 0, len(raw))
	objects := make([]map[string]any, 0, len(raw))
	for index, item := range raw {
		fields, ok := item.(map[string]any)
		if !ok {
			return nil, nil, validation("Cada punto del histórico debe ser un objeto.")
		}
		coin, failure := stringField(fields, "coin")
		if failure != nil {
			return nil, nil, failure
		}
		createdAt, failure := integerField(fields, "createdAt")
		if failure != nil {
			return nil, nil, failure
		}
		points = append(points, dashboard.HistoryPoint{Coin: coin, CreatedAt: createdAt, Index: index})
		objects = append(objects, fields)
	}
	return points, objects, nil
}

func dashboardHistoryResult(selected []dashboard.HistoryPoint, originals []map[string]any) []any {
	result := make([]any, 0, len(selected))
	for _, point := range selected {
		result = append(result, originals[point.Index])
	}
	return result
}
