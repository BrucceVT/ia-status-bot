const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const InteractionResponseType = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4 };

async function verifyDiscordRequest(request: Request, publicKey: string) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.clone().text();

  if (!signature || !timestamp) return false;

  const hexToUint8Array = (hex: string) => {
    return new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  };

  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToUint8Array(publicKey),
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
      false,
      ['verify']
    );

    return await crypto.subtle.verify(
      'NODE-ED25519',
      key,
      hexToUint8Array(signature),
      encoder.encode(timestamp + body)
    );
  } catch (e) {
    return false;
  }
}

export interface Env {
  IA_STATUS_KV: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  DISCORD_PUBLIC_KEY: string;
  GEMINI_API_KEY?: string;
}

type ServiceStatus = 'operational' | 'degraded' | 'maintenance' | 'down' | 'unknown';

interface ServiceInfo {
  name: string;
  status: ServiceStatus;
  description: string;
}

interface ServiceConfig {
  name: string;
  checkStatus: (env: Env) => Promise<ServiceInfo>;
}

// Check Atlassian Statuspage format
async function checkAtlassianStatus(name: string, url: string): Promise<ServiceInfo> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { name, status: 'unknown', description: `HTTP Error ${response.status}` };
    }
    const data: any = await response.json();
    const indicator = data.status?.indicator || 'none';
    let description = data.status?.description || 'Unknown status';

    // Parse active incidents if any
    if (data.incidents && data.incidents.length > 0) {
      const activeIncident = data.incidents[0];
      const statusEmoji = activeIncident.status === 'resolved' ? '✅' : '🔍';
      
      description = `**Incidente:** ${activeIncident.name}\n`;
      description += `**Estado:** ${statusEmoji} ${activeIncident.status} (Impacto: ${activeIncident.impact || 'desconocido'})\n`;
      
      if (activeIncident.incident_updates && activeIncident.incident_updates.length > 0) {
        const lastUpdate = activeIncident.incident_updates[0];
        const dateStr = new Date(lastUpdate.updated_at).toLocaleString('es-ES', { timeZone: 'UTC' });
        description += `\n**Último reporte (${dateStr} UTC):**\n> ${lastUpdate.body}`;
      }
    }

    let status: ServiceStatus = 'operational';
    if (indicator === 'minor') status = 'degraded';
    else if (indicator === 'major' || indicator === 'critical') status = 'down';
    else if (indicator === 'maintenance') status = 'maintenance';
    else if (indicator === 'none') status = 'operational';

    return { name, status, description };
  } catch (error: any) {
    return { name, status: 'unknown', description: error.message };
  }
}

// Configuración de los servicios a monitorear
const SERVICES: ServiceConfig[] = [
  {
    name: 'OpenAI',
    checkStatus: () => checkAtlassianStatus('OpenAI', 'https://status.openai.com/api/v2/summary.json'),
  },
  {
    name: 'Claude (Anthropic)',
    checkStatus: () => checkAtlassianStatus('Claude', 'https://status.claude.com/api/v2/summary.json'),
  }
];

async function sendDiscordWebhook(url: string, serviceName: string, oldStatus: ServiceStatus, newStatus: ServiceStatus, description: string, isManual: boolean = false) {
  let color = 0x808080; // gris por defecto
  let title = isManual ? `📊 Estado actual de ${serviceName}` : `⚠️ Cambio de estado en ${serviceName}`;
  
  if (newStatus === 'operational') {
    color = 0x00FF00; // verde
    if (!isManual) title = `✅ ${serviceName} está nuevamente Operativo`;
  } else if (newStatus === 'down') {
    color = 0xFF0000; // rojo
    if (!isManual) title = `🛑 ${serviceName} reporta una Caída`;
  } else if (newStatus === 'degraded') {
    color = 0xFFA500; // naranja
    if (!isManual) title = `⚠️ ${serviceName} reporta Rendimiento Degradado`;
  } else if (newStatus === 'maintenance') {
    color = 0x0000FF; // azul
    if (!isManual) title = `🔧 ${serviceName} está en Mantenimiento`;
  }

  const descText = isManual 
    ? `**Estado Actual:** ${newStatus.toUpperCase()}\n\n**Detalles:** ${description}`
    : `El estado ha cambiado de **${oldStatus}** a **${newStatus}**.\n\n**Detalles:** ${description}`;

  const payload = {
    embeds: [
      {
        title: title,
        description: descText,
        color: color,
        timestamp: new Date().toISOString()
      }
    ]
  };

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export default {
  // Manejador para el Cron Trigger
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DISCORD_WEBHOOK_URL) {
      console.error('DISCORD_WEBHOOK_URL no está configurado.');
      return;
    }

    const kvKey = 'service_states';
    
    // 1. Obtener estados anteriores desde KV
    let previousStates: Record<string, ServiceStatus> = {};
    try {
      const stored = await env.IA_STATUS_KV.get(kvKey);
      if (stored) {
        previousStates = JSON.parse(stored);
      }
    } catch (e) {
      console.error('Error leyendo de KV', e);
    }

    const currentStates: Record<string, ServiceStatus> = {};
    let statesChanged = false;

    // 2. Verificar cada servicio
    for (const service of SERVICES) {
      const info = await service.checkStatus(env);
      currentStates[service.name] = info.status;

      const oldStatus = previousStates[service.name] || 'unknown';
      
      // 3. Comparar y enviar alerta si cambió
      if (info.status !== oldStatus && oldStatus !== 'unknown' && info.status !== 'unknown') {
        console.log(`Estado cambiado para ${service.name}: ${oldStatus} -> ${info.status}`);
        await sendDiscordWebhook(env.DISCORD_WEBHOOK_URL, service.name, oldStatus, info.status, info.description, false);
        statesChanged = true;
      } else if (oldStatus === 'unknown' && info.status !== 'unknown') {
        // Primera ejecución exitosa o recuperación de un estado unknown previo
        currentStates[service.name] = info.status;
        statesChanged = true;
      }
    }

    // 4. Guardar nuevos estados si hubo algún cambio o si es la primera vez
    if (statesChanged || Object.keys(previousStates).length === 0) {
      // Si es la primera vez que se ejecuta, enviamos un mensaje de "Bot Iniciado"
      if (Object.keys(previousStates).length === 0) {
        await sendDiscordWebhook(
          env.DISCORD_WEBHOOK_URL,
          'Monitoreo de IAs',
          'unknown',
          'operational',
          'El bot ha sido desplegado exitosamente y acaba de establecer su línea base. Te avisaré cuando algún servicio se caiga.',
          false
        );
      }
      await env.IA_STATUS_KV.put(kvKey, JSON.stringify(currentStates));
    }
  },
  
  // Manejador fetch para recibir peticiones HTTP y Discord Interactions
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();

    // 1. Integración Nativa con Discord Slash Commands
    if (request.method === 'POST') {
      if (!env.DISCORD_PUBLIC_KEY) {
        return new Response('Falta configurar DISCORD_PUBLIC_KEY', { status: 500 });
      }

      const isValidRequest = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
      if (!isValidRequest) {
        return new Response('Firma inválida', { status: 401 });
      }

      const interaction = JSON.parse(await request.text());

      // Verificación inicial de Discord
      if (interaction.type === InteractionType.PING) {
        return Response.json({ type: InteractionResponseType.PONG });
      }

      // Comando ejecutado
      if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = interaction.data.name;
        
        if (commandName === 'status') {
          // Extraer la opción si el usuario especificó algún servicio
          let targetServiceName = 'all';
          if (interaction.data.options && interaction.data.options.length > 0) {
            targetServiceName = interaction.data.options[0].value;
          }

          // Ejecutamos en segundo plano para no bloquear la respuesta de 3s
          ctx.waitUntil((async () => {
            if (!env.DISCORD_WEBHOOK_URL) return;

            let targetServices = SERVICES;
            if (targetServiceName === 'openai') {
              targetServices = SERVICES.filter(s => s.name === 'OpenAI');
            } else if (targetServiceName === 'claude') {
              targetServices = SERVICES.filter(s => s.name === 'Claude (Anthropic)');
            }

            for (const service of targetServices) {
              const info = await service.checkStatus(env);
              await sendDiscordWebhook(
                env.DISCORD_WEBHOOK_URL, 
                service.name, 
                'unknown', 
                info.status, 
                info.description, 
                true
              );
            }
          })());

          // Respuesta rápida de Discord
          return Response.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `🔄 Solicitaste el estado de ${targetServiceName}. Enviando reporte al canal de alertas...`
            }
          });
        }
      }
    }

    // 2. Comandos Manuales vía HTTP (Por si no usan Slash Commands o para Pruebas)
    if (path.startsWith('/status/')) {
      const command = path.replace('/status/', '');
      
      let targetServices = SERVICES;
      if (command === 'openai' || command === 'chatgpt') {
        targetServices = SERVICES.filter(s => s.name === 'OpenAI');
      } else if (command === 'claude') {
        targetServices = SERVICES.filter(s => s.name === 'Claude (Anthropic)');
      } else if (command !== 'all') {
        return new Response('Comando no reconocido. Usa /status/openai, /status/claude o /status/all', { status: 404 });
      }

      if (!env.DISCORD_WEBHOOK_URL) {
        return new Response('Error: DISCORD_WEBHOOK_URL no está configurado.', { status: 500 });
      }

      const results = [];
      for (const service of targetServices) {
        const info = await service.checkStatus(env);
        await sendDiscordWebhook(
          env.DISCORD_WEBHOOK_URL, 
          service.name, 
          'unknown', 
          info.status, 
          info.description, 
          true // isManual = true
        );
        results.push(`${service.name}: ${info.status}`);
      }

      return new Response(`Comando manual ejecutado. Resultados enviados a Discord: \n${results.join('\n')}`);
    }

    return new Response('Worker de monitoreo activo.\n\nComandos HTTP manuales disponibles:\n- /status/openai\n- /status/claude\n- /status/all');
  }
};
