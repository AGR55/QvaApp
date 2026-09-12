import React from "react";

const MARKET_META = {
  BANK_CUP: { icon: "/icons/cup.svg", tone: "cup" },
  BANDECPREPAGO: { icon: "/icons/tropical.png", tone: "prepago" },
  CLASICA: { icon: "/icons/clasica.png", tone: "clasica" },
};

export function MarketIdentity({ code, label, size = "md", showCode = true }) {
  const meta = MARKET_META[code] || { tone: "default" };
  return (
    <span className={`market-identity market-identity-${size} market-identity-${meta.tone}`}>
      {meta.icon ? <img src={meta.icon} alt="" aria-hidden="true" width="40" height="40" /> : <span className="market-identity-fallback" aria-hidden="true">{String(code || "?").slice(0, 1)}</span>}
      <span className="market-identity-copy">
        <strong>{label || code}</strong>
        {showCode ? <small>{code}</small> : null}
      </span>
    </span>
  );
}
