# Agenda de clases particulares

Página web con dos vistas:

- **Pública** (`/`): muestra, en vista semanal, las horas libres y ocupadas de cada día. **Nunca** muestra nombres: el servidor solo envía "libre"/"ocupado" a esta vista.
- **Privada** (`/admin`): protegida con usuario y contraseña. Tocás un horario para reservarlo con el nombre del alumno (y una nota opcional), bloquearlo sin nombre, editarlo o liberarlo. Permite repetir una clase semanalmente (4–26 semanas) y configurar días, horario de atención y duración de cada clase.

No tiene dependencias: solo necesita Node.js 18 o superior.

## Uso

```bash
ADMIN_USER=admin ADMIN_PASSWORD='una-contraseña-segura' npm start
```

Abrí http://localhost:3000 (pública) y http://localhost:3000/admin (privada).

Si no definís `ADMIN_PASSWORD`, se genera una contraseña temporal y se muestra en la consola al arrancar.

### Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `ADMIN_USER` | `admin` | Usuario de la vista privada |
| `ADMIN_PASSWORD` | (aleatoria) | Contraseña de la vista privada |
| `PORT` | `3000` | Puerto del servidor |
| `DATA_DIR` | `./data` | Carpeta donde se guarda `agenda.json` (solo en local) |
| `SESSION_SECRET` | (derivada de la contraseña) | Clave para firmar la cookie de sesión. Opcional |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | — | Base de datos Redis. Obligatoria en Vercel; Vercel la completa sola al conectar Upstash |

## Publicarla en Vercel

Vercel no guarda archivos entre visitas, así que las reservas se guardan en una base de datos **Upstash Redis** (tiene plan gratuito).

1. En [vercel.com](https://vercel.com) → **Add New… → Project** → importá el repositorio `Agenda`. No cambies nada de la configuración de build (ya está en `vercel.json`) y hacé clic en **Deploy**.
2. En el proyecto → pestaña **Storage** → **Create Database** → elegí **Upstash** (Redis) → creala con el plan gratuito y conectala al proyecto. Esto agrega solas las variables de conexión.
3. En **Settings → Environment Variables** agregá:
   - `ADMIN_PASSWORD`: tu contraseña (obligatoria).
   - `ADMIN_USER`: tu usuario (opcional, por defecto `admin`).
4. En **Deployments** → los tres puntos del último deploy → **Redeploy**, para que tome las variables nuevas.

Listo: la página pública queda en `https://<tu-proyecto>.vercel.app` y tu panel en `https://<tu-proyecto>.vercel.app/admin`.

Al cambiar `ADMIN_PASSWORD` se cierran todas las sesiones abiertas.

## Otros servicios

También funciona en cualquier servicio que ejecute Node.js (Render, Railway, un VPS…) con `npm start`. Ahí podés usar Redis igual que en Vercel, o guardar en archivo apuntando `DATA_DIR` a un disco persistente.
