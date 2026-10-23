# Tink references optional compile-time annotations. These exact annotation
# classes are absent from the runtime; keep all cryptographic runtime checks.
# Rules match AGP's generated missing_rules.txt (no broad warning suppression).
-dontwarn com.google.errorprone.annotations.CanIgnoreReturnValue
-dontwarn com.google.errorprone.annotations.CheckReturnValue
-dontwarn com.google.errorprone.annotations.Immutable
-dontwarn com.google.errorprone.annotations.RestrictedApi
-dontwarn javax.annotation.Nullable
-dontwarn javax.annotation.concurrent.GuardedBy
