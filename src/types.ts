export type P2pType = "buy" | "sell";
/** Código de mercado fiat de QvaPay, configurable desde SQLite y el panel local. */
export type FiatMarket = string;
export type P2pStatus =
  | "open"
  | "processing"
  | "paid"
  | "completed"
  | "cancelled"
  | "revision"
  | string;

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

export interface P2pListResponse {
  offers: P2pOffer[];
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
  count?: number;
  updated_at?: string;
}
export interface QvaErrorBody {
  error?: string;
  message?: string;
  info?: string;
}

export interface QvaTransaction {
  uuid: string;
  amount: number;
  description?: string | null;
  remote_id?: string | null;
  status: string;
  created_at?: string;
  updated_at?: string;
  P2P?: {
    uuid?: string;
    amount?: number;
    coin?: string;
    receive?: number;
    status?: string;
  } | null;
  Wallet?: { Coin?: { tick?: string } | null } | null;
}

export type OperationState =
  | "applied"
  | "acknowledged"
  | "paid"
  | "cancelled"
  | "completed"
  | "failed";
