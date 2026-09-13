import React from "react";

export function MarketIdentity({ market, code, label, iconUrl, color, size = "md" }) {
  const identity = market || { code, label, iconUrl, color };
  return (
    <span
      className={`market-identity market-identity-${size}`}
      style={{ "--market-accent": identity.color || "#6f8494" }}
    >
      {identity.iconUrl ? (
        <img src={identity.iconUrl} alt="" aria-hidden="true" width="40" height="40" />
      ) : (
        <span className="market-identity-fallback" aria-hidden="true">
          {String(identity.label || identity.code || "?").trim().slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="market-identity-copy">
        <strong>{identity.label || identity.code}</strong>
      </span>
    </span>
  );
}
