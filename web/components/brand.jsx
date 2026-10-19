import React from "react";
import { brandAssets } from "../../src/brand.ts";

export function Brand({ symbol = false, className = "" }) {
  const width = symbol ? 256 : 860;
  const height = symbol ? 256 : 180;
  return (
    <span className={`qva-brand ${symbol ? "qva-brand-symbol" : ""} ${className}`} role="img" aria-label="QvaApply">
      <img className="qva-brand-light" src={symbol ? brandAssets.symbol : brandAssets.horizontal} alt="" width={width} height={height} decoding="async" />
      <img className="qva-brand-inverse" src={symbol ? brandAssets.symbolInverse : brandAssets.horizontalInverse} alt="" width={width} height={height} decoding="async" />
    </span>
  );
}
