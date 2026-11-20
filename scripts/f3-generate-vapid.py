#!/usr/bin/env python3
"""Genera un par VAPID P-256 para Web Push y lo escribe como variables de entorno.

Formato compatible con webpush-go y con la spec VAPID:
- privada: 32 bytes big-endian, base64url sin padding.
- pública: punto P-256 sin comprimir (65 bytes), base64url sin padding.
"""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def main() -> int:
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_bytes = private_key.private_numbers().private_value.to_bytes(32, "big")
    public_bytes = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    subject = os.environ.get("WEB_PUSH_SUBJECT", "mailto:admin@qvapply.honux.tech")
    public = encode(public_bytes)
    print(f"WEB_PUSH_PUBLIC_KEY={public}")
    print(f"WEB_PUSH_PRIVATE_KEY={encode(private_bytes)}")
    print(f"WEB_PUSH_SUBJECT={subject}")
    print("PUSH_SEND_ENABLED=true")
    print(f"EDGE_PUSH_PUBLIC_KEY={public}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
