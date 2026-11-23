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
| `DATA_DIR` | `./data` | Carpeta donde se guarda `agenda.json` |
| `TZ` | del sistema | Zona horaria, p. ej. `America/Argentina/Buenos_Aires` |

## Publicarla en internet

Sirve cualquier servicio que ejecute Node.js (Render, Railway, Fly.io, un VPS…). Comando de inicio: `npm start`. Definí `ADMIN_PASSWORD` y, para no perder las reservas al reiniciar, apuntá `DATA_DIR` a un disco persistente. Usá siempre HTTPS para que la contraseña viaje cifrada.
