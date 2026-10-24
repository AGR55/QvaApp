export type P2pType = "buy" | "sell";
export type P2pFeedEvent =
  | "p2p.created"
  | "p2p.reopened"
  | "p2p.applied"
  | "p2p.paid"
  | "p2p.completed"
  | "p2p.cancelled"
  | "p2p.range_created"
  | "p2p.range_updated"
  | "p2p.range_closed";
/** Código de mercado fiat de QvaPay, configurable desde SQLite y el panel local. */
export type FiatMarket = string;
type P2pStatus =
  | "open"
  | "processing"
  | "paid"
  | "completed"
  | "cancelled"
  | "revision"
  | string;

export interface P2pOrder {
  paid_at?: string | null;
  released_at?: string | null;
  cancelled_at?: string | null;
  uuid: string;
  amount: number;
  receive: number;
  status: string;
  created_at?: string;
  updated_at?: string;
  Taker?: { uuid: string; username?: string; name?: string };
}

export interface P2pOffer {
  uuid: string;
  type: P2pType;
  coin: string;
  amount: number;
  receive: number;
  status: P2pStatus;
  message?: string | null;
  tags?: string[];
  only_kyc?: boolean | number;
  only_vip?: boolean | number;
  owner_uuid?: string;
  offer_kind?: "fixed" | "flexible" | string;
  available_amount?: number | string | null;
  order_min?: number | string | null;
  order_max?: number | string | null;
  Orders?: P2pOrder[];
  can_take_flexible?: boolean;
  requirements?: Partial<Record<"min_completed" | "min_rating" | "min_account_days" | "min_trustscore", number | string>> | null;
  requirements_met?: boolean;
  private?: boolean | number;
  webhook?: string | null;
  updated_at?: string;
  created_at?: string;
  details?: Record<string, string>;
  User?: {
    uuid: string;
    username?: string;
    name?: string;
    kyc?: boolean;
    vip?: boolean;
  };
  Peer?: { uuid: string; username?: string; name?: string } | null;
}

export interface P2pListPage {
  offers: P2pOffer[];
  total: number;
  currentPage: number;
  perPage: number;
}
export interface P2pAverage {
  average?: number;
  average_buy?: number;
  average_sell?: number;
  median_buy?: number;
  median_sell?: number;
  count?: number;
  updated_at?: string;
}
export interface QvaTransaction {
  uuid: string;
  amount: number;
  description?: string | null;
  remote_id?: string | null;
  status: string;
  created_at?: string;
  updated_at?: string;
  User?: { uuid?: string } | null;
  PaidBy?: { uuid?: string } | null;
  P2P?: {
    uuid?: string;
    amount?: number;
    coin?: string;
    receive?: number;
    status?: string;
  } | null;
  Wallet?: { Coin?: { tick?: string } | null } | null;
}

export interface QvaTransactionPage {
  transactions: QvaTransaction[];
  total?: number;
}

export type OperationState =
  | "applied"
  | "acknowledged"
  | "paid"
  | "revision"
  | "cancelled"
  | "completed"
  | "failed";
