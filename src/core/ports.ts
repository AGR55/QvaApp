import type { QvaPayClient } from "../qvapay.js";
import type { Store } from "../store.js";

/** Minimal capability granted to market observers. */
export type MarketListingGateway = Pick<QvaPayClient, "listOffersPage">;

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
  | "activeReservedQusd"
  | "applicationReservedCapital"
  | "cooperativeParticipantReserved"
  | "audit"
  | "excludeAutomaticReapplyAfterManualCancel"
  | "createMutationIntent"
  | "createOperation"
  | "get"
  | "getOperation"
  | "getMutationIntent"
  | "dailyAppliedQusd"
  | "unresolvedMutationIntents"
  | "hasUnresolvedMutation"
  | "hasUnresolvedMutationForOffer"
  | "hasFiatMovement"
  | "isSeen"
  | "isExcludedAfterManualCancel"
  | "loadRemoteResource"
  | "latestMarketFeedState"
  | "lastPauseChange"
  | "markSeen"
  | "pendingCancellations"
  | "recentAudit"
  | "recentFiat"
  | "recentMutationIntents"
  | "recentSellMedian"
  | "recordFiatMovement"
  | "recordDecisionEvent"
  | "recordMarketObservation"
  | "resolveTradingAlert"
  | "recoverableMutationIntents"
  | "saveRemoteResource"
  | "visibleOperations"
  | "saveChatThread"
  | "chatThread"
  | "chatThreads"
  | "set"
  | "syncTradingAlerts"
  | "upsertTradingAlert"
  | "updateMutationIntent"
  | "updateOperation"
>;
