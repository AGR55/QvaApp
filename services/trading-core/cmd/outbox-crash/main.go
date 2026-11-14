// Helper de recuperación F2: reclama un mensaje y muere (kill -9) o recupera.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

func main() {
	dsn := flag.String("dsn", os.Getenv("TEST_POSTGRES_URL"), "DSN")
	mode := flag.String("mode", "claim", "claim|recover")
	worker := flag.String("worker", "worker", "worker id")
	now := flag.Int64("now", 1000, "epoch ms")
	lease := flag.Int64("lease-ms", 1000, "lease ms")
	flag.Parse()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, *dsn)
	if err != nil {
		fail(err)
	}
	defer pool.Close()
	repository := postgres.NewOutboxRepository(pool)
	messages, err := repository.ClaimDue(ctx, *worker, *now, *lease, 10)
	if err != nil {
		fail(err)
	}
	if len(messages) == 0 {
		fmt.Println("none")
		os.Exit(1)
	}
	fmt.Printf("claimed %s\n", messages[0].ID)
	if *mode == "claim" {
		time.Sleep(24 * time.Hour)
		return
	}
	for _, message := range messages {
		ok, err := repository.Complete(ctx, message.ID, *worker, *now+1)
		if err != nil || !ok {
			fail(fmt.Errorf("complete %s: %v", message.ID, err))
		}
		fmt.Printf("published %s\n", message.ID)
	}
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "outbox-crash: %v\n", err)
	os.Exit(2)
}
