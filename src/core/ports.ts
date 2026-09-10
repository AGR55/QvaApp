import type { QvaPayClient } from "../qvapay.js";
import type { Store } from "../store.js";

/** Protocol seam shared by the real QvaPay adapter and deterministic tests. */
export type QvaPayGateway = Pick<
  QvaPayClient,
  | "apply"
  | "cancel"
  | "confirmReceived"
  | "createOffer"
  | "editOffer"
  | "getOffer"
  | "listOffers"
  | "listOffersPage"
  | "listTransactions"
  | "listChat"
  | "markPaid"
  | "p2pAverages"
  | "profile"
  | "qusdBalance"
  | "sendChat"
>;

/** Persistence seam used by the trading module. */
export type TradingRepository = Pick<
  Store,
  | "activeOperations"
  | "audit"
  | "createMutationIntent"
  | "createOperation"
  | "get"
  | "getOperation"
  | "findWorkflowByTarget"
  | "isSeen"
  | "loadRemoteResource"
  | "markSeen"
  | "pendingCancellations"
  | "recentAudit"
  | "recentFiat"
  | "recentMutationIntents"
  | "recordFiatMovement"
  | "recordDecisionEvent"
  | "recordMarketObservation"
  | "saveRemoteResource"
  | "set"
  | "syncTradingAlerts"
  | "upsertTradingAlert"
  | "updateMutationIntent"
  | "updateOperation"
>;
