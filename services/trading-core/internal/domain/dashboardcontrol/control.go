// Package dashboardcontrol orquesta los controles del panel de
// `src/dashboard.ts` sin acoplarse al read model completo.
package dashboardcontrol

// Trading son las operaciones de control del núcleo.
type Trading interface {
	SetPaused(paused bool, source string)
	Activate() error
	UpdateHunting(value any)
	ActiveMarkets() []string
}

// Refreshers son las lecturas del panel.
type Refreshers interface {
	RefreshBalance() error
	RefreshOwnOffers() error
	RefreshTransactions() error
	RefreshMarket(code string) error
}

// Service expone los controles.
type Service struct {
	trading    Trading
	refreshers Refreshers
}

// New crea el servicio.
func New(trading Trading, refreshers Refreshers) *Service {
	return &Service{trading: trading, refreshers: refreshers}
}

// SetPaused pausa localmente o reanuda validando QvaPay.
func (service *Service) SetPaused(paused bool) error {
	if paused {
		service.trading.SetPaused(true, "panel web")
		return nil
	}
	return service.trading.Activate()
}

// UpdateHunting delega la configuración de cacería.
func (service *Service) UpdateHunting(value any) {
	service.trading.UpdateHunting(value)
}

// RefreshCache actualiza los recursos en el orden estable del panel.
func (service *Service) RefreshCache(refreshMarkets bool) error {
	if err := service.refreshers.RefreshBalance(); err != nil {
		return err
	}
	if err := service.refreshers.RefreshOwnOffers(); err != nil {
		return err
	}
	if err := service.refreshers.RefreshTransactions(); err != nil {
		return err
	}
	if !refreshMarkets {
		return nil
	}
	for _, code := range service.trading.ActiveMarkets() {
		if err := service.refreshers.RefreshMarket(code); err != nil {
			return err
		}
	}
	return nil
}
