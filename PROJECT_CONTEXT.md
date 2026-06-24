# Contexto del Proyecto: IA Status Bot

Este documento sirve como base de conocimiento para cualquier agente de IA o desarrollador que necesite modificar o entender este proyecto en el futuro.

## 1. Descripción General
Es un bot serverless diseñado para monitorear el estado de los servicios de Inteligencia Artificial (principalmente OpenAI y Claude de Anthropic) y enviar alertas a Discord. 
El sistema es bidireccional:
1. **Monitoreo Automático**: Ejecuta una tarea programada (cron) que revisa el estado de las plataformas. Si hay una caída o recuperación, alerta inmediatamente en un canal de Discord.
2. **Comandos Manuales**: Permite a los usuarios de Discord ejecutar el comando `/status` para pedir un reporte a demanda en tiempo real.

## 2. Arquitectura y Tecnologías
*   **Infraestructura**: Cloudflare Workers (Edge Computing).
*   **Lenguaje**: TypeScript.
*   **Almacenamiento (Estado)**: Cloudflare KV Namespace (`IA_STATUS_KV`). Sirve para recordar el estado anterior de la IA (operacional, caída, etc.) y no mandar alertas repetitivas, solo cuando el estado *cambia*.
*   **Integración**: Webhooks de Discord (para enviar los mensajes ricos/embeds) y Discord Interactions Endpoint (para recibir los comandos nativos Slash).

## 3. Puntos Críticos del Código (`src/index.ts`)
*   **Verificación de Seguridad Nativa (Web Crypto API)**:
    Las peticiones que vienen de Discord para comandos Slash (*Interactions*) deben ser verificadas criptográficamente. **NO se usan librerías externas** (como `discord-interactions`) porque causan problemas de compatibilidad en Cloudflare Workers. Todo está implementado nativamente usando `crypto.subtle` (algoritmo Ed25519) en la función `verifyDiscordRequest`.
*   **Ejecución de Tareas Largas**:
    Dado que Discord exige que los comandos Slash se respondan en menos de 3 segundos, usamos `ctx.waitUntil(...)` para responder inmediatamente a Discord con un mensaje de "Procesando..." mientras que la petición HTTP a los statuspages de OpenAI/Claude sucede en segundo plano.
*   **Extracción de Incidentes**:
    La función `checkAtlassianStatus` no solo lee el indicador de estado global, sino que procesa el arreglo `data.incidents` para extraer el título de la falla, el impacto, la última actualización y lo traduce todo con marcas de tiempo en UTC.

## 4. Configuración y Secretos de Entorno
El Worker necesita las siguientes variables (Secretos gestionados vía `npx wrangler secret put`):
*   `DISCORD_WEBHOOK_URL`: La URL del Webhook del canal de alertas.
*   `DISCORD_PUBLIC_KEY`: La Clave Pública de la aplicación de Discord (obtenida del portal de desarrolladores de Discord).

El archivo de configuración principal es `wrangler.toml`, el cual tiene:
*   Definición del KV Namespace.
*   El trigger del cron (`*/15 * * * *` = cada 15 minutos).
*   **IMPORTANTE**: `compatibility_flags = ["nodejs_compat"]` está activo para asegurar compatibilidad con ciertos flujos nativos y polyfills.

## 5. Comandos y Despliegue
*   **Pruebas Locales**: `npm run dev` (inicia miniflare/wrangler localmente).
*   **Despliegue a Producción**: `npm run deploy` (sube el worker a la infraestructura de Cloudflare).

## 6. Configuración en Discord Developer Portal
Si el bot debe reinstalarse o cambiarse de URL:
1.  **Interactions Endpoint URL**: Se debe configurar apuntando a la URL pública del Worker en Cloudflare (`https://<tu-worker>.<tu-subdominio>.workers.dev`).
2.  **Registro de Comandos**: El registro del comando `/status` se hace interactuando con la API REST de Discord. (Previamente se usó un script temporal local `register.js` con el token del bot, el cual fue eliminado por seguridad tras ejecutarlo). No hace falta volver a registrar el comando a menos que se quiera cambiar su estructura o añadir nuevos.

## 7. Notas para el Agente AI Futuro
*   **NUNCA añadas dependencias de Node.js que utilicen `Buffer` o `crypto` pesado** para el manejo de Discord. Limítate a usar `Web Crypto API` (nativa del entorno Edge).
*   Si vas a agregar un nuevo servicio de IA (Midjourney, Perplexity, etc.), añádelo en el arreglo constante `SERVICES` dentro de `src/index.ts`. Solo debes asegurarte de parsear su Statuspage correspondiente adaptando la función `checkStatus`.
