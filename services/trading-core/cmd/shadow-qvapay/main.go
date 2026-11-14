// Comando shadow-qvapay: lee QvaPay en modo estrictamente read-only y guarda
// solo un resumen no sensible en shadow.qvapay_snapshots.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/vault"
)

type output struct {
	RunID      string `json:"runId"`
	UserKnown  bool   `json:"userKnown"`
	Balance    string `json:"balance"`
	Offers     int    `json:"offers"`
	Averages   int    `json:"averages"`
	CapturedAt int64  `json:"capturedAt"`
}

func main() {
	databaseURL := flag.String("database-url", "", "DSN de PostgreSQL (fallback: DATABASE_URL)")
	baseURL := flag.String("base-url", envOrDefault("QVAPAY_API_BASE_URL", "https://api.qvapay.com"), "base URL de QvaPay")
	runID := flag.String("run-id", "", "identificador del run")
	flag.Parse()

	dsn := strings.TrimSpace(*databaseURL)
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "shadow-qvapay: falta -database-url o DATABASE_URL")
		os.Exit(2)
	}
	encryptedToken := strings.TrimSpace(os.Getenv("QVA_TOKEN_CIPHERTEXT"))
	if encryptedToken == "" {
		fmt.Fprintln(os.Stderr, "shadow-qvapay: falta QVA_TOKEN_CIPHERTEXT")
		os.Exit(2)
	}
	key := strings.TrimSpace(os.Getenv("LOCAL_ENCRYPTION_KEY"))
	if key == "" {
		fmt.Fprintln(os.Stderr, "shadow-qvapay: falta LOCAL_ENCRYPTION_KEY")
		os.Exit(2)
	}
	vaultClient, err := vault.New(key)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: %v\n", err)
		os.Exit(1)
	}
	token, err := vaultClient.Decrypt(encryptedToken)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: no se pudo descifrar el token QvaPay\n")
		os.Exit(1)
	}
	client, err := qvapay.New(*baseURL, token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: %v\n", err)
		os.Exit(1)
	}

	id := strings.TrimSpace(*runID)
	if id == "" {
		id = "qvapay-" + time.Now().UTC().Format("20060102T150405Z")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	user, err := client.User(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: leer /user: %v\n", err)
		os.Exit(1)
	}
	offers, err := client.Offers(ctx, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: leer /p2p: %v\n", err)
		os.Exit(1)
	}
	averages, err := client.Averages(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: leer /p2p/averages: %v\n", err)
		os.Exit(1)
	}

	capturedAt := time.Now().Unix()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: conectar PostgreSQL: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: PostgreSQL no responde: %v\n", err)
		os.Exit(1)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO shadow.qvapay_snapshots
			(run_id, user_uuid, balance, offers, averages, captured_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (run_id) DO UPDATE SET
			user_uuid = excluded.user_uuid,
			balance = excluded.balance,
			offers = excluded.offers,
			averages = excluded.averages,
			captured_at = excluded.captured_at`,
		id, user.UUID, user.Balance.Format(8), len(offers), len(averages), capturedAt,
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-qvapay: persistir snapshot: %v\n", err)
		os.Exit(1)
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(output{
		RunID:      id,
		UserKnown:  user.UUID != "",
		Balance:    user.Balance.Format(8),
		Offers:     len(offers),
		Averages:   len(averages),
		CapturedAt: capturedAt,
	})
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
