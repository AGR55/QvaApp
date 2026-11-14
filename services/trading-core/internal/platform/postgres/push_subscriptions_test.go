package postgres_test

import (
	"context"
	"encoding/base64"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

func pushSubscriptionsSetup(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), "TRUNCATE shadow.push_subscriptions"); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func pushRepoKey(size int) string {
	raw := make([]byte, size)
	for index := range raw {
		raw[index] = 7
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func pushRepoSubscription(endpoint, label string) notifier.PushSubscription {
	return notifier.PushSubscription{
		Endpoint: endpoint,
		P256DH:   pushRepoKey(65),
		Auth:     pushRepoKey(16),
		Label:    label,
	}
}

func TestPushSubscriptionRepositoryUpsertListCountDelete(t *testing.T) {
	pool := pushSubscriptionsSetup(t)
	repository := postgres.NewPushSubscriptionRepository(pool)
	ctx := context.Background()

	now := time.UnixMilli(1_700_000_000_000)
	expiresAt := now.Add(24 * time.Hour)

	second := pushRepoSubscription("https://push.example/b", "segunda")
	if err := repository.Upsert(ctx, second, now, expiresAt); err != nil {
		t.Fatal(err)
	}
	first := pushRepoSubscription("https://push.example/a", "primera")
	if err := repository.Upsert(ctx, first, now, expiresAt); err != nil {
		t.Fatal(err)
	}

	count, err := repository.Count(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("count = %d, quiero 2", count)
	}

	listed, err := repository.List(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 {
		t.Fatalf("listado = %+v", listed)
	}
	if listed[0].Endpoint != first.Endpoint || listed[1].Endpoint != second.Endpoint {
		t.Fatalf("orden = %+v", listed)
	}
	if listed[0].P256DH != first.P256DH || listed[0].Auth != first.Auth ||
		listed[0].Label != first.Label {
		t.Fatalf("suscripción alterada = %+v", listed[0])
	}

	// El upsert del mismo endpoint actualiza datos sin crear otra fila y
	// conserva created_at.
	updated := pushRepoSubscription("https://push.example/a", "actualizada")
	updated.P256DH = pushRepoKey(66)
	updatedAt := now.Add(time.Minute)
	if err := repository.Upsert(ctx, updated, updatedAt, expiresAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	count, err = repository.Count(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("count tras upsert = %d, quiero 2", count)
	}

	listed, err = repository.List(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if listed[0].Label != "actualizada" || listed[0].P256DH != updated.P256DH {
		t.Fatalf("upsert no actualizó la suscripción = %+v", listed[0])
	}

	var createdAt, updatedStored int64
	if err := pool.QueryRow(ctx, `
		SELECT created_at, updated_at
		FROM shadow.push_subscriptions
		WHERE endpoint = $1`,
		updated.Endpoint,
	).Scan(&createdAt, &updatedStored); err != nil {
		t.Fatal(err)
	}
	if createdAt != now.UnixMilli() {
		t.Fatalf("created_at = %d, quiero %d", createdAt, now.UnixMilli())
	}
	if updatedStored != updatedAt.UnixMilli() {
		t.Fatalf("updated_at = %d, quiero %d", updatedStored, updatedAt.UnixMilli())
	}

	limited, err := repository.List(ctx, now, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 1 || limited[0].Endpoint != first.Endpoint {
		t.Fatalf("listado con límite = %+v", limited)
	}
	unlimited, err := repository.List(ctx, now, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(unlimited) != 2 {
		t.Fatalf("listado sin límite = %+v", unlimited)
	}

	deleted, err := repository.Delete(ctx, first.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if !deleted {
		t.Fatal("Delete no encontró la suscripción existente")
	}
	deleted, err = repository.Delete(ctx, first.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if deleted {
		t.Fatal("Delete encontró una suscripción ya eliminada")
	}
	count, err = repository.Count(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count tras delete = %d, quiero 1", count)
	}
}

func TestPushSubscriptionRepositoryFiltersExpired(t *testing.T) {
	pool := pushSubscriptionsSetup(t)
	repository := postgres.NewPushSubscriptionRepository(pool)
	ctx := context.Background()

	now := time.UnixMilli(1_700_000_000_000)
	active := pushRepoSubscription("https://push.example/active", "activa")
	if err := repository.Upsert(ctx, active, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	expired := pushRepoSubscription("https://push.example/expired", "expirada")
	if err := repository.Upsert(ctx, expired, now, now); err != nil {
		t.Fatal(err)
	}

	count, err := repository.Count(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d, quiero 1", count)
	}
	listed, err := repository.List(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Endpoint != active.Endpoint {
		t.Fatalf("listado = %+v", listed)
	}

	// La fila expirada sigue en la tabla; sólo se omite en lectura.
	var total int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM shadow.push_subscriptions`).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != 2 {
		t.Fatalf("filas = %d, quiero 2", total)
	}
}

func TestPushSubscriptionRepositoryRejectsInvalidSubscription(t *testing.T) {
	pool := pushSubscriptionsSetup(t)
	repository := postgres.NewPushSubscriptionRepository(pool)
	ctx := context.Background()

	now := time.UnixMilli(1_700_000_000_000)
	invalid := pushRepoSubscription("https://push.example/a", "inválida")
	invalid.Auth = "no-es-base64url!"
	if err := repository.Upsert(ctx, invalid, now, now.Add(time.Hour)); err == nil {
		t.Fatal("Upsert aceptó un secreto auth inválido")
	}
	invalid = pushRepoSubscription("http://push.example/a", "inválida")
	if err := repository.Upsert(ctx, invalid, now, now.Add(time.Hour)); err == nil {
		t.Fatal("Upsert aceptó un endpoint http remoto")
	}

	count, err := repository.Count(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("count = %d, quiero 0", count)
	}
}
