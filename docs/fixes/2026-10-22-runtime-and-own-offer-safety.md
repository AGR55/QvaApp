# Runtime security and own-offer investigation

## Reproduced bug

The ten-second idle liquidity task could cancel a fixed own sell offer when releasing capital for the configured maximum operation would leave less than QvaPay's minimum. This ran without a concrete external opportunity. A regression reproduced an unsolicited cancellation of a manually published ten-QUSD offer.

Preparation now selects only an offer whose remaining inventory stays above the existing minimum. It may partially reduce a suitable larger fixed offer, preserving its price. It never cancels an offer solely to prepare idle liquidity. The existing compensated release flow for an actual opportunity is preserved. This reproduces a possible cause in code; production audit is required to attribute individual remote cancellations.

## Security release

Node.js 24.22.1 LTS is the 21 October 2026 security release. Production Docker and CI use that patch; package engines require the supported 24 line at or above this patch. Deployment pulls the selected base image before building, so cached images do not silently retain old runtime/base layers.

Fastify and fast-uri were updated within their compatible release lines. The production audit found five low/moderate advisories before the update and none afterward. The full application check passes using the downloaded Node.js 24.22.1 binary, whose SHA-256 was checked against the official release manifest.

Official references:
- https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
- https://nodejs.org/en/blog/release/v24.22.1
- https://www.php.net/archive/2026.php#2026-10-21-5

PHP exposure must be determined from the host and container inventory; the hosting provider's identity is not evidence of an installed PHP runtime.

## Protected diagnosis

The manual `Encrypted read-only VPS diagnostics` workflow executes a checked-in read-only diagnostic script through the existing production SSH channel. Supply a public PEM X.509 certificate as its input; keep the corresponding private key local. The report includes operation IDs, timings and system metadata, so it is encrypted with authenticated AES-256-GCM CMS before upload. The encrypted artifact expires after one day. Neither credentials/environment variables nor complete process arguments are collected. The workflow does not apply, edit, cancel, restart or install anything.
