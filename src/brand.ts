/** Public, versioned identity assets shared by HTML and React surfaces. */
export const brandAssets = {
  horizontal: "/logo/encuentro-preciso-horizontal.svg",
  horizontalInverse: "/logo/encuentro-preciso-horizontal-inverse.svg",
  symbol: "/logo/encuentro-preciso-symbol.svg",
  symbolInverse: "/logo/encuentro-preciso-symbol-inverse.svg",
  favicon: "/logo/encuentro-preciso-favicon.svg",
  apple: "/logo/encuentro-preciso-icon-180.png",
  notification: "/logo/encuentro-preciso-icon-192.png",
  badge: "/logo/encuentro-preciso-badge.png",
} as const;

export function brandMarkup(className: "login-logo" | "boot-logo"): string {
  return `<span class="qva-brand ${className}" role="img" aria-label="QvaApply"><img class="qva-brand-light" src="${brandAssets.horizontal}" alt="" width="860" height="180"><img class="qva-brand-inverse" src="${brandAssets.horizontalInverse}" alt="" width="860" height="180"></span>`;
}
