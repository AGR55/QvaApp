// Package moneycore reproduce los escenarios money-core del corpus F2.
package moneycore

//lint:file-ignore S1016 conversión explícita para mantener el orden del snapshot

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/riskpolicy"
)

// Session es el prototipo de pipeline de una operación.
type Session struct {
	start        int64
	now          int64
	qusdBalance  decimal.Value
	reservedQusd decimal.Value
	applyError   string
	workflow     *workflowState
	operations   []operationState
	intents      []intentState
	ownOffers    []ownOfferState
	lastResult   map[string]any
	target       Target
	ownSnapshot  map[string]any
	ownUUID      string
}

type workflowState struct {
	Ref   string
	State string
	Error *string
}

type operationState struct {
	UUID        string
	OfferType   string
	Coin        string
	Amount      decimal.Value
	Receive     decimal.Value
	Rate        decimal.Value
	State       string
	AutoApplied bool
	OrderUUID   *string
}

type intentState struct {
	Ref           string
	Kind          string
	State         string
	OperationUUID string
	Workflow      string
	Error         *string
}

type ownOfferState struct {
	Workflow     string
	OriginalUUID string
	State        string
	RestoredUUID string
	Error        *string
}

// New crea una sesión con el reloj del corpus.
func New(start int64) *Session {
	return &Session{start: start, now: start + 2}
}

// Decide evalúa riesgo y ejecuta el pipeline de aplicación.
func (session *Session) Decide(input map[string]any) (map[string]any, []map[string]any, string, error) {
	target, err := targetOf(input)
	if err != nil {
		return nil, nil, "", err
	}
	session.target = target
	gateway, err := parseGateway(input["gateway"])
	if err != nil {
		return nil, nil, "", err
	}
	upstream := make([]map[string]any, 0)
	if session.workflow != nil {
		result := session.lastResult
		return result, upstream, session.Digest(), nil
	}

	balance := session.qusdBalance
	if value, ok := gateway.balance(); ok {
		balance = value
		upstream = append(upstream, map[string]any{
			"method":  "qusdBalance",
			"options": map[string]any{"priority": true},
		})
	}
	referenceRate, err := decimalField(input, "referenceRate")
	if err != nil {
		return nil, nil, "", err
	}
	margin, err := decimalField(input, "expectedMarginPercent")
	if err != nil {
		return nil, nil, "", err
	}
	priceDecision := stringValue(input["priceDecision"], "eligible")
	priceReason := stringValue(input["priceReason"], "")

	decision, err := session.evaluate(target, balance, referenceRate, margin, priceDecision, priceReason)
	if err != nil {
		return nil, nil, "", err
	}
	if balance.Cmp(target.Amount) < 0 {
		own, ok := gateway.nextListOffer()
		if !ok {
			result := session.decisionResult(decision, nil)
			session.lastResult = result
			return result, upstream, session.Digest(), nil
		}
		upstream = append(upstream, map[string]any{
			"method": "listOffers",
			"query":  map[string]any{"my": true, "take": 100, "page": 1, "status": "open"},
		})
		offerFields, _ := own.(map[string]any)
		ownUUID := stringValue(offerFields["uuid"], "")
		upstream = append(upstream, map[string]any{"method": "getOffer", "uuid": ownUUID})
		_, _ = gateway.nextGetOffer(ownUUID)
		cancelOutcome := gateway.next("cancel")
		upstream = append(upstream, map[string]any{
			"method":       "cancel",
			"uuid":         ownUUID,
			"responseHash": hashValue(cancelOutcome.ok()),
		})
		ownAmount, _ := decimalValue(offerFields["amount"])
		session.qusdBalance = balance.Add(ownAmount)
		balance = session.qusdBalance
		decision, err = session.evaluate(target, balance, referenceRate, margin, priceDecision, priceReason)
		if err != nil {
			return nil, nil, "", err
		}
		session.ownSnapshot = offerFields
		session.ownUUID = ownUUID
	}
	if decision.Kind != riskpolicy.Apply {
		result := session.decisionResult(decision, nil)
		session.lastResult = result
		return result, upstream, session.Digest(), nil
	}

	outcome := gateway.next("apply")
	upstream = append(upstream, map[string]any{
		"method":       "apply",
		"uuid":         target.UUID,
		"optionsHash":  hashValue(map[string]any{"amount": nil}),
		"responseHash": hashValue(outcome.ok()),
	})
	session.workflow = &workflowState{Ref: "wf-1", State: "applied"}
	switch {
	case outcome.errKind == "api":
		session.workflow.State = "restored"
		message := outcome.errMessage
		session.workflow.Error = &message
		session.newIntent("apply", "rejected", target.UUID, &message)
		restored, restoreUpstream := session.restoreOwn(gateway)
		upstream = append(upstream, restoreUpstream...)
		decision.Kind = riskpolicy.Blocked
		decision.Reasons = append(decision.Reasons, "QvaPay rechazó la aplicación: "+message)
		result := session.decisionResult(decision, session.workflow)
		session.lastResult = result
		_ = restored
		return result, upstream, session.Digest(), nil
	case outcome.errKind == "uncertain":
		session.workflow.State = "apply_uncertain"
		session.reservedQusd = target.Amount
		message := "No se recibió confirmación de QvaPay para apply; se requiere conciliación."
		session.applyError = message
		session.workflow.Error = &message
		session.newIntent("apply", "uncertain", target.UUID, &message)
		decision.Kind = riskpolicy.Blocked
		decision.Reasons = append(decision.Reasons, "QvaPay no confirmó la aplicación: "+message)
		result := session.decisionResult(decision, session.workflow)
		session.lastResult = result
		return result, upstream, session.Digest(), nil
	default:
		session.newIntent("apply", "confirmed", target.UUID, nil)
		session.operations = append(session.operations, operationState{
			UUID: target.UUID, OfferType: "buy", Coin: target.Coin,
			Amount: target.Amount, Receive: target.Receive,
			Rate: mustDiv(target.Receive, target.Amount), State: "applied", AutoApplied: true,
		})
		result := session.decisionResult(decision, session.workflow)
		result["applicationConfirmed"] = true
		session.lastResult = result
		return result, upstream, session.Digest(), nil
	}
}

// Reconcile resuelve una aplicación incierta leyendo el estado remoto.
func (session *Session) Reconcile(input map[string]any) (map[string]any, []map[string]any, string, error) {
	if session.workflow == nil {
		return nil, nil, "", fmt.Errorf("workflow desconocido")
	}
	gateway, err := parseGateway(input["gateway"])
	if err != nil {
		return nil, nil, "", err
	}
	if session.workflow.State == "applied" {
		return map[string]any{"outcome": "applied", "detail": "El flujo ya estaba cerrado."}, []map[string]any{}, session.Digest(), nil
	}
	if session.workflow.State != "apply_uncertain" {
		return map[string]any{"outcome": "unresolved", "detail": "Estado remoto no concluyente."}, []map[string]any{}, session.Digest(), nil
	}
	target, err := targetOf(input)
	if err != nil {
		// El paso de reconciliación no repite target: se usa el de la sesión.
		target = session.target
	}
	upstream := []map[string]any{{"method": "getOffer", "uuid": target.UUID}}
	outcome, ok := gateway.getOffer(target.UUID)
	if !ok || outcome.errKind != "" {
		return nil, upstream, "", fmt.Errorf("getOffer no declarado")
	}
	remote, _ := outcome.okValue.(map[string]any)
	status := stringValue(remote["status"], "")
	if status == "pending" {
		detail := "Estado remoto no concluyente: pending."
		session.workflow.Error = &detail
		return map[string]any{"outcome": "unresolved", "detail": detail}, upstream, session.Digest(), nil
	}
	if status == "processing" || status == "paid" || status == "completed" {
		message := session.applyError
		session.workflow.State = "applied"
		session.workflow.Error = nil
		session.reservedQusd = decimal.Zero()
		for index := range session.intents {
			if session.intents[index].Kind == "apply" {
				session.intents[index].State = "reconciled"
				session.intents[index].Error = &message
			}
		}
		session.operations = append(session.operations, operationState{
			UUID: target.UUID, OfferType: "buy", Coin: target.Coin,
			Amount: target.Amount, Receive: target.Receive,
			Rate: mustDiv(target.Receive, target.Amount), State: "applied", AutoApplied: true,
		})
		return map[string]any{"outcome": "applied", "detail": "Aplicación confirmada en estado processing."}, upstream, session.Digest(), nil
	}
	return map[string]any{"outcome": "unresolved", "detail": "Estado remoto no concluyente."}, upstream, session.Digest(), nil
}

// State devuelve el snapshot público.
func (session *Session) State() map[string]any {
	return map[string]any{
		"operations":   session.operationViews(),
		"reservedQusd": session.reservedQusd.Format(8),
		"workflows":    session.workflowViews(),
		"ownOffers":    session.ownOfferViews(),
		"intents":      session.intentViews(),
		"feed":         []any{},
		"observations": []any{},
	}
}

type digestSnapshot struct {
	Operations   []operationView `json:"operations"`
	ReservedQusd string          `json:"reservedQusd"`
	Workflows    []workflowView  `json:"workflows"`
	OwnOffers    []ownOfferView  `json:"ownOffers"`
	Intents      []intentView    `json:"intents"`
	Feed         []any           `json:"feed"`
	Observations []any           `json:"observations"`
}

type operationView struct {
	UUID        string  `json:"uuid"`
	OfferType   string  `json:"offerType"`
	Coin        string  `json:"coin"`
	Amount      string  `json:"amount"`
	Receive     string  `json:"receive"`
	Rate        string  `json:"rate"`
	State       string  `json:"state"`
	AutoApplied bool    `json:"autoApplied"`
	OrderUUID   *string `json:"orderUuid"`
}

type workflowView struct {
	Ref   string  `json:"ref"`
	State string  `json:"state"`
	Error *string `json:"error"`
}

type ownOfferView struct {
	Workflow     string  `json:"workflow"`
	OriginalUUID string  `json:"originalUuid"`
	State        string  `json:"state"`
	RestoredUUID string  `json:"restoredUuid"`
	Error        *string `json:"error"`
}

type intentView struct {
	Ref           string  `json:"ref"`
	Kind          string  `json:"kind"`
	State         string  `json:"state"`
	OperationUUID string  `json:"operationUuid"`
	Workflow      string  `json:"workflow"`
	Error         *string `json:"error"`
}

// Digest reproduce el stateDigest del oráculo.
func (session *Session) Digest() string {
	operations := session.operationViews()
	sort.Slice(operations, func(left, right int) bool { return operations[left].UUID < operations[right].UUID })
	workflows := session.workflowViews()
	sort.Slice(workflows, func(left, right int) bool { return workflows[left].Ref < workflows[right].Ref })
	ownOffers := session.ownOfferViews()
	sort.Slice(ownOffers, func(left, right int) bool {
		return ownOffers[left].Workflow+":"+ownOffers[left].OriginalUUID <
			ownOffers[right].Workflow+":"+ownOffers[right].OriginalUUID
	})
	intents := session.intentViews()
	snapshot := digestSnapshot{
		Operations: operations, ReservedQusd: session.reservedQusd.Format(8), Workflows: workflows,
		OwnOffers: ownOffers, Intents: intents, Feed: []any{}, Observations: []any{},
	}
	sum := sha256.Sum256(canonicalBytes(snapshot))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (session *Session) operationViews() []operationView {
	result := make([]operationView, 0, len(session.operations))
	for _, operation := range session.operations {
		result = append(result, operationView{
			UUID: operation.UUID, OfferType: operation.OfferType, Coin: operation.Coin,
			Amount: operation.Amount.Format(8), Receive: operation.Receive.Format(8),
			Rate: operation.Rate.Format(8), State: operation.State,
			AutoApplied: operation.AutoApplied, OrderUUID: operation.OrderUUID,
		})
	}
	return result
}

func (session *Session) workflowViews() []workflowView {
	if session.workflow == nil {
		return []workflowView{}
	}
	return []workflowView{{Ref: session.workflow.Ref, State: session.workflow.State, Error: session.workflow.Error}}
}

func (session *Session) ownOfferViews() []ownOfferView {
	result := make([]ownOfferView, 0, len(session.ownOffers))
	for _, own := range session.ownOffers {
		result = append(result, ownOfferView{
			Workflow: own.Workflow, OriginalUUID: own.OriginalUUID,
			State: own.State, RestoredUUID: own.RestoredUUID, Error: own.Error,
		})
	}
	return result
}

func (session *Session) intentViews() []intentView {
	result := make([]intentView, 0, len(session.intents))
	for _, intent := range session.intents {
		result = append(result, intentView{
			Ref: intent.Ref, Kind: intent.Kind, State: intent.State,
			OperationUUID: intent.OperationUUID, Workflow: intent.Workflow, Error: intent.Error,
		})
	}
	sort.Slice(result, func(left, right int) bool {
		return fmt.Sprintf("%s:%s:%s:%s", result[left].Kind, result[left].State, result[left].OperationUUID, result[left].Workflow) <
			fmt.Sprintf("%s:%s:%s:%s", result[right].Kind, result[right].State, result[right].OperationUUID, result[right].Workflow)
	})
	return result
}

func (session *Session) newIntent(kind, state, operationUUID string, err *string) {
	prefix := "intent-"
	session.intents = append(session.intents, intentState{
		Ref: prefix + strconv.Itoa(len(session.intents)+1), Kind: kind, State: state,
		OperationUUID: operationUUID, Workflow: "wf-1", Error: err,
	})
}

func (session *Session) evaluate(target Target, balance, referenceRate, margin decimal.Value, priceDecision, priceReason string) (riskpolicy.Decision, error) {
	return riskpolicy.Evaluate(riskpolicy.Context{
		Now: decimal.FromInt(session.now),
		Opportunity: riskpolicy.Opportunity{
			UUID: target.UUID, Market: target.Coin, Side: riskpolicy.SellQusd,
			QusdAmount: target.Amount, RequiredFiat: target.Receive,
			QuotedRate: mustDiv(target.Receive, target.Amount), ReferenceRate: referenceRate,
			ObservedAt: decimal.FromInt(session.now),
		},
		Limits: riskpolicy.Limits{
			MaxQusdPerOperation: decimal.FromInt(25), MaxConcurrentQusdExposure: decimal.FromInt(50),
			MaxDailyAppliedQusd: decimal.FromInt(100), MaxConcurrentOperations: decimal.FromInt(2),
			MinQusdReserve: decimal.Zero(), MaxQuoteAgeSeconds: decimal.FromInt(45),
			MinExpectedMarginPercent: decimal.MustParse("0.5"), MaxSlippagePercent: decimal.FromInt(1),
			MaxConsecutiveErrors: decimal.FromInt(3), MarketCooldownSeconds: decimal.FromInt(30),
			CounterpartyCooldownSeconds: decimal.FromInt(300),
		},
		PriceDecision: riskpolicy.PriceDecision(priceDecision), PriceReason: priceReason,
		ExpectedMarginPercent: margin, QusdBalance: balance,
		ConcurrentQusdExposure: decimal.Zero(), DailyAppliedQusd: decimal.Zero(),
		ActiveOperations: decimal.Zero(), ConsecutiveErrors: decimal.Zero(),
	})
}

func (session *Session) decisionResult(decision riskpolicy.Decision, workflow *workflowState) map[string]any {
	result := map[string]any{
		"decision": map[string]any{
			"kind":                      string(decision.Kind),
			"opportunityUuid":           decision.OpportunityUUID,
			"evaluatedAt":               session.now,
			"requiredQusd":              decision.RequiredQusd.Format(8),
			"requiredFiat":              decision.RequiredFiat.Format(8),
			"projectedExposureQusd":     decision.ProjectedExposureQusd.Format(8),
			"projectedDailyAppliedQusd": decision.ProjectedDailyAppliedQusd.Format(8),
			"checks":                    checkViews(decision.Checks),
			"reasons":                   decision.Reasons,
		},
		"applicationConfirmed": false,
	}
	if workflow != nil {
		result["workflow"] = map[string]any{"state": workflow.State, "error": workflow.Error}
		result["workflowRef"] = workflow.Ref
	} else {
		result["workflow"] = nil
	}
	return result
}

func checkViews(checks []riskpolicy.Check) []any {
	result := make([]any, 0, len(checks))
	for _, check := range checks {
		item := map[string]any{"code": check.Code, "status": string(check.Status), "reason": check.Reason}
		if check.Actual != nil {
			item["actual"] = scalar(check.Actual)
		}
		if check.Limit != nil {
			item["limit"] = scalar(check.Limit)
		}
		result = append(result, item)
	}
	return result
}

func scalar(value any) any {
	switch typed := value.(type) {
	case decimal.Value:
		if integer, ok := typed.Int64(); ok {
			return integer
		}
		return typed.Format(4)
	default:
		return value
	}
}

var _ = sort.Strings
