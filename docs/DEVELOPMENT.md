# Desarrollo local

El servidor (`pnpm start`) sirve los archivos compilados de `public/dashboard`.
Para revisar únicamente la interfaz sin conectar Telegram ni QvaPay, usa el
preview aislado:

```bash
pnpm preview:ui
```

Abre `http://127.0.0.1:3100` con la contraseña `preview-segura-2026`. Este
comando usa datos de demostración, no lee `.env` y no inicia el bot. Para una
validación automática equivalente, ejecuta `pnpm check:ui`.

Para que los cambios de `web/` se compilen automáticamente mientras trabajas,
abre dos terminales:

```bash
pnpm dev:web   # recompila app.js/app.css al guardar
pnpm dev       # ejecuta el servidor local con recarga del backend
```

`pnpm dev` y `pnpm dev:all` sí arrancan el proceso operativo: no los ejecutes
con las credenciales reales mientras la VPS use el mismo bot de Telegram o la
misma cuenta QvaPay.

Si solo vas a ejecutar el servidor de producción local, ejecuta `pnpm build`
antes de `pnpm start`. El servidor envía `Cache-Control: no-store` para que una
recarga no conserve un bundle antiguo.
