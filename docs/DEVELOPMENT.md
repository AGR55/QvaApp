# Desarrollo local

El servidor (`pnpm start`) sirve los archivos compilados de `public/dashboard`.
Para que los cambios de `web/` se compilen automáticamente mientras trabajas,
abre dos terminales:

```bash
pnpm dev:web   # recompila app.js/app.css al guardar
pnpm dev       # ejecuta el servidor local con recarga del backend
```

Si solo vas a ejecutar el servidor de producción local, ejecuta `pnpm build`
antes de `pnpm start`. El servidor envía `Cache-Control: no-store` para que una
recarga no conserve un bundle antiguo.
