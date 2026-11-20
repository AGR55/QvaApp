# Sintaxis: build multi-stage con binario estático y runtime sin root.
#
# El contexto de build es la raíz del repositorio para incluir el módulo
# compartido (services/shared) que resuelve el replace de go.mod:
#
#   docker build -f services/trading-core/Dockerfile -t trading-core .
FROM golang:1.27-bookworm AS build

WORKDIR /src/services/trading-core

ENV CGO_ENABLED=0 \
    GOWORK=off \
    GOFLAGS=-trimpath

COPY services/trading-core/go.mod services/trading-core/go.sum ./
COPY services/shared/go.mod ../shared/go.mod
RUN go mod download

COPY services/shared/ ../shared/
COPY services/trading-core/ ./

RUN go build -ldflags="-s -w" -o /out/trading-core ./cmd/trading-core

FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app

COPY --from=build /out/trading-core /app/trading-core

EXPOSE 8090

USER nonroot:nonroot

ENTRYPOINT ["/app/trading-core"]
