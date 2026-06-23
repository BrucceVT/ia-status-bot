export interface Env {
  IA_STATUS_KV: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
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
    const description = data.status?.description || 'Unknown status';

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

async function sendDiscordWebhook(url: string, serviceName: string, oldStatus: ServiceStatus, newStatus: ServiceStatus, description: string) {
  let color = 0x808080; // gris por defecto
  let title = `⚠️ Cambio de estado en ${serviceName}`;
  
  if (newStatus === 'operational') {
    color = 0x00FF00; // verde
    title = `✅ ${serviceName} está nuevamente Operativo`;
  } else if (newStatus === 'down') {
    color = 0xFF0000; // rojo
    title = `🛑 ${serviceName} reporta una Caída`;
  } else if (newStatus === 'degraded') {
    color = 0xFFA500; // naranja
    title = `⚠️ ${serviceName} reporta Rendimiento Degradado`;
  } else if (newStatus === 'maintenance') {
    color = 0x0000FF; // azul
    title = `🔧 ${serviceName} está en Mantenimiento`;
  }

  const payload = {
    embeds: [
      {
        title: title,
        description: `El estado ha cambiado de **${oldStatus}** a **${newStatus}**.\n\n**Detalles:** ${description}`,
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
      
      // 3. Comparar y enviar alerta si cambió (ignoramos cambios a unknown para no enviar falsos positivos si hay un error de red temporal)
      if (info.status !== oldStatus && oldStatus !== 'unknown' && info.status !== 'unknown') {
        console.log(`Estado cambiado para ${service.name}: ${oldStatus} -> ${info.status}`);
        await sendDiscordWebhook(env.DISCORD_WEBHOOK_URL, service.name, oldStatus, info.status, info.description);
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
          'El bot ha sido desplegado exitosamente y acaba de establecer su línea base. Te avisaré cuando algún servicio se caiga.'
        );
      }
      await env.IA_STATUS_KV.put(kvKey, JSON.stringify(currentStates));
    }
  },
  
  // Manejador fetch solo para pruebas rápidas manuales
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response('Worker de monitoreo activo. Revisa los logs o ejecuta un cron test.');
  }
};
