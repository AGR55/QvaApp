package runtimeconfig_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

// testActorPrefix identifica las filas creadas por estas pruebas para poder
// restaurar la tabla sin tocar configuraciones ajenas.
const testActorPrefix = "runtimeconfig-test-"

type configRow struct {
	configJSON []byte
	version    int64
	reason     string
	updatedBy  string
	updatedAt  int64
}

type revisionRow struct {
	version    int64
	configJSON []byte
	reason     string
	updatedBy  string
	createdAt  int64
}

func repositorySetup(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	migration, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "db", "migrations", "0017_runtime_config.sql",
	))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("no se pudo aplicar la migración: %v", err)
	}

	// La tabla de configuración es un singleton: para que Seed y Save sean
	// deterministas se guarda el contenido actual y se restaura al terminar.
	previousConfig, err := snapshotConfig(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	previousRevisions, err := snapshotRevisions(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM shadow.runtime_config`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM shadow.runtime_config_revisions`); err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := restoreSnapshot(cleanupCtx, pool, previousConfig, previousRevisions); err != nil {
			t.Errorf("no se pudo restaurar shadow.runtime_config: %v", err)
		}
	})

	return pool
}

func snapshotConfig(ctx context.Context, pool *pgxpool.Pool) ([]configRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT config_json, version, reason, updated_by, updated_at
		FROM shadow.runtime_config
		ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	snapshot := make([]configRow, 0, 1)
	for rows.Next() {
		var row configRow
		if err := rows.Scan(
			&row.configJSON, &row.version, &row.reason, &row.updatedBy, &row.updatedAt,
		); err != nil {
			return nil, err
		}
		snapshot = append(snapshot, row)
	}
	return snapshot, rows.Err()
}

func snapshotRevisions(ctx context.Context, pool *pgxpool.Pool) ([]revisionRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT version, config_json, reason, updated_by, created_at
		FROM shadow.runtime_config_revisions
		ORDER BY version`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	snapshot := make([]revisionRow, 0)
	for rows.Next() {
		var row revisionRow
		if err := rows.Scan(
			&row.version, &row.configJSON, &row.reason, &row.updatedBy, &row.createdAt,
		); err != nil {
			return nil, err
		}
		snapshot = append(snapshot, row)
	}
	return snapshot, rows.Err()
}

func restoreSnapshot(
	ctx context.Context,
	pool *pgxpool.Pool,
	config []configRow,
	revisions []revisionRow,
) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // el rollback tras commit es inocuo

	if _, err := tx.Exec(ctx, `DELETE FROM shadow.runtime_config_revisions`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM shadow.runtime_config`); err != nil {
		return err
	}

	for _, row := range config {
		if _, err := tx.Exec(ctx, `
			INSERT INTO shadow.runtime_config
				(id, config_json, version, reason, updated_by, updated_at)
			VALUES (1, $1::jsonb, $2, $3, $4, $5)`,
			string(row.configJSON), row.version, row.reason, row.updatedBy, row.updatedAt,
		); err != nil {
			return err
		}
	}
	for _, row := range revisions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO shadow.runtime_config_revisions
				(version, config_json, reason, updated_by, created_at)
			VALUES ($1, $2::jsonb, $3, $4, $5)
			ON CONFLICT (version) DO UPDATE
			SET config_json = EXCLUDED.config_json,
				reason = EXCLUDED.reason,
				updated_by = EXCLUDED.updated_by,
				created_at = EXCLUDED.created_at`,
			row.version, string(row.configJSON), row.reason,
			row.updatedBy, row.createdAt,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func TestRepositorySeedIsIdempotent(t *testing.T) {
	pool := repositorySetup(t)
	repository := &runtimeconfig.Repository{Pool: pool}
	ctx := context.Background()

	if _, _, err := repository.Load(ctx); !errors.Is(err, runtimeconfig.ErrNotFound) {
		t.Fatalf("Load sin fila = %v, quiero ErrNotFound", err)
	}

	config := validConfig()
	now := time.UnixMilli(1_700_000_000_000)
	if err := repository.Seed(ctx, config, now); err != nil {
		t.Fatal(err)
	}

	loaded, version, err := repository.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if version != 1 {
		t.Fatalf("version = %d, quiero 1", version)
	}
	assertConfigEqual(t, loaded, config)

	// La segunda siembra no debe pisar la configuración existente.
	other := config
	other.MaxOpenOffers = 99
	if err := repository.Seed(ctx, other, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	loaded, version, err = repository.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if version != 1 || loaded.MaxOpenOffers != config.MaxOpenOffers {
		t.Fatalf("Seed pisó la configuración: version=%d config=%+v", version, loaded)
	}

	invalid := config
	invalid.Version = 2
	if err := repository.Seed(ctx, invalid, now); !errors.Is(err, runtimeconfig.ErrInvalidConfig) {
		t.Fatalf("Seed inválido = %v, quiero ErrInvalidConfig", err)
	}
	if _, version, err = repository.Load(ctx); err != nil || version != 1 {
		t.Fatalf("Seed inválido alteró la fila: version=%d err=%v", version, err)
	}
}

func TestRepositorySaveIncrementsVersionAndCreatesRevision(t *testing.T) {
	pool := repositorySetup(t)
	repository := &runtimeconfig.Repository{Pool: pool}
	ctx := context.Background()

	config := validConfig()
	now := time.UnixMilli(1_700_000_000_000)
	if err := repository.Seed(ctx, config, now); err != nil {
		t.Fatal(err)
	}

	first := config
	first.MaxOpenOffers = 7
	first.Markets[0].Label = "Bitcoin actualizado"
	firstVersion, err := repository.Save(
		ctx, first, "  ajuste del panel  ", testActorPrefix+"save", now.Add(time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if firstVersion != 2 {
		t.Fatalf("Save version = %d, quiero 2", firstVersion)
	}

	loaded, version, err := repository.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if version != 2 {
		t.Fatalf("Load version = %d, quiero 2", version)
	}
	assertConfigEqual(t, loaded, first)

	second := first
	second.MaxOpenOffers = 9
	secondVersion, err := repository.Save(
		ctx, second, "segundo ajuste", testActorPrefix+"save-2", now.Add(2*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if secondVersion != 3 {
		t.Fatalf("segundo Save version = %d, quiero 3", secondVersion)
	}

	revisions, err := repository.Revisions(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 2 {
		t.Fatalf("revisiones = %d, quiero 2", len(revisions))
	}
	if revisions[0].Version != 3 || revisions[1].Version != 2 {
		t.Fatalf("orden de revisiones = %d, %d",
			revisions[0].Version, revisions[1].Version)
	}
	if revisions[1].Reason != "ajuste del panel" {
		t.Fatalf("reason = %q", revisions[1].Reason)
	}
	if revisions[1].Actor != testActorPrefix+"save" {
		t.Fatalf("actor = %q", revisions[1].Actor)
	}
	if revisions[1].CreatedAt != now.Add(time.Minute).UnixMilli() {
		t.Fatalf("createdAt = %d", revisions[1].CreatedAt)
	}
	assertConfigEqual(t, revisions[1].Config, first)
	assertConfigEqual(t, revisions[0].Config, second)

	limited, err := repository.Revisions(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 1 || limited[0].Version != 3 {
		t.Fatalf("Revisions(limit=1) = %+v", limited)
	}
	// Un límite fuera de rango usa el valor por defecto.
	fallback, err := repository.Revisions(ctx, -5)
	if err != nil {
		t.Fatal(err)
	}
	if len(fallback) != 2 {
		t.Fatalf("Revisions(limit=-5) = %d revisiones, quiero 2", len(fallback))
	}

	invalid := second
	invalid.Version = 0
	if _, err := repository.Save(
		ctx, invalid, "no debe guardarse", testActorPrefix+"invalid", now,
	); !errors.Is(err, runtimeconfig.ErrInvalidConfig) {
		t.Fatalf("Save inválido = %v, quiero ErrInvalidConfig", err)
	}
	loaded, version, err = repository.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if version != 3 {
		t.Fatalf("Save inválido cambió la versión a %d", version)
	}
	assertConfigEqual(t, loaded, second)
	revisions, err = repository.Revisions(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 2 {
		t.Fatalf("Save inválido creó revisiones: %d", len(revisions))
	}
}

func TestRepositorySaveCreatesFirstVersion(t *testing.T) {
	pool := repositorySetup(t)
	repository := &runtimeconfig.Repository{Pool: pool}
	ctx := context.Background()

	config := validConfig()
	now := time.UnixMilli(1_700_000_000_000)
	version, err := repository.Save(
		ctx, config, "alta inicial", testActorPrefix+"first", now,
	)
	if err != nil {
		t.Fatal(err)
	}
	if version != 1 {
		t.Fatalf("Save version = %d, quiero 1", version)
	}

	loaded, loadedVersion, err := repository.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if loadedVersion != 1 {
		t.Fatalf("Load version = %d, quiero 1", loadedVersion)
	}
	assertConfigEqual(t, loaded, config)

	revisions, err := repository.Revisions(ctx, runtimeconfig.DefaultRevisionLimit)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 1 {
		t.Fatalf("revisiones = %d, quiero 1", len(revisions))
	}
	if revisions[0].Version != 1 || revisions[0].Reason != "alta inicial" ||
		revisions[0].Actor != testActorPrefix+"first" {
		t.Fatalf("revisión inesperada: %+v", revisions[0])
	}
}

func TestRepositoryTruncatesMetadata(t *testing.T) {
	pool := repositorySetup(t)
	repository := &runtimeconfig.Repository{Pool: pool}
	ctx := context.Background()

	longReason := strings.Repeat("r", runtimeconfig.MaxReasonLength+50)
	longActor := strings.Repeat("a", runtimeconfig.MaxActorLength+50)
	now := time.UnixMilli(1_700_000_000_000)
	if _, err := repository.Save(
		ctx, validConfig(), "  "+longReason+"  ", longActor, now,
	); err != nil {
		t.Fatal(err)
	}

	revisions, err := repository.Revisions(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 1 {
		t.Fatalf("revisiones = %d, quiero 1", len(revisions))
	}
	if len(revisions[0].Reason) != runtimeconfig.MaxReasonLength {
		t.Fatalf("reason = %d caracteres", len(revisions[0].Reason))
	}
	if len(revisions[0].Actor) != runtimeconfig.MaxActorLength {
		t.Fatalf("actor = %d caracteres", len(revisions[0].Actor))
	}
}

func assertConfigEqual(t *testing.T, got, want runtimeconfig.Config) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("config = %+v, quiero %+v", got, want)
	}
}
