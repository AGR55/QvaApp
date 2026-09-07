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
  | "isSeen"
  | "markSeen"
  | "pendingCancellations"
  | "recentAudit"
  | "recentFiat"
  | "recordFiatMovement"
  | "set"
  | "syncTradingAlerts"
  | "updateMutationIntent"
  | "updateOperation"
>;
