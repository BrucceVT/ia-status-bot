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

interface ComponentStatus {
  name: string;
  status: string;
  isCore: boolean;
}

interface ServiceInfo {
  name: string;
  status: ServiceStatus;
  description: string;
  affectedComponents: ComponentStatus[];
}

interface ServiceConfig {
  name: string;
  checkStatus: (env: Env) => Promise<ServiceInfo>;
}

// Check Atlassian Statuspage format focusing on core components
async function checkAtlassianStatus(
  name: string,
  url: string,
  coreComponentNames: string[]
): Promise<ServiceInfo> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { 
        name, 
        status: 'unknown', 
        description: `HTTP Error ${response.status}`, 
        affectedComponents: [] 
      };
    }
    const data: any = await response.json();
    const components: any[] = data.components || [];
    
    const affectedComponents: ComponentStatus[] = [];
    let coreStatus: ServiceStatus = 'operational';

    const mapComponentStatus = (status: string): ServiceStatus => {
      switch (status) {
        case 'operational':
          return 'operational';
        case 'degraded_performance':
          return 'degraded';
        case 'partial_outage':
          return 'degraded';
        case 'major_outage':
          return 'down';
        case 'under_maintenance':
          return 'maintenance';
        default:
          return 'unknown';
      }
    };

    for (const comp of components) {
      const compName = comp.name || '';
      const compStatus = comp.status || 'operational';
      
      const isCore = coreComponentNames.some(coreName => 
        compName.toLowerCase() === coreName.toLowerCase()
      );

      if (compStatus !== 'operational') {
        affectedComponents.push({
          name: compName,
          status: compStatus,
          isCore
        });

        if (isCore) {
          const compMappedStatus = mapComponentStatus(compStatus);
          
          if (compMappedStatus === 'down') {
            coreStatus = 'down';
          } else if (compMappedStatus === 'degraded' && coreStatus !== 'down') {
            coreStatus = 'degraded';
          } else if (compMappedStatus === 'maintenance' && coreStatus !== 'down' && coreStatus !== 'degraded') {
            coreStatus = 'maintenance';
          }
        }
      }
    }

    let description = '';
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
    } else {
      description = data.status?.description || 'All systems operational';
    }

    return { 
      name, 
      status: coreStatus, 
      description, 
      affectedComponents 
    };
  } catch (error: any) {
    return { name, status: 'unknown', description: error.message, affectedComponents: [] };
  }
}

// Configuración de los servicios a monitorear
const SERVICES: ServiceConfig[] = [
  {
    name: 'OpenAI',
    checkStatus: () => checkAtlassianStatus('OpenAI', 'https://status.openai.com/api/v2/summary.json', [
      'Responses',
      'App',
      'Conversations',
      'Login'
    ]),
  },
  {
    name: 'Claude (Anthropic)',
    checkStatus: () => checkAtlassianStatus('Claude', 'https://status.claude.com/api/v2/summary.json', [
      'claude.ai',
      'Claude API (api.anthropic.com)'
    ]),
  }
];

function getUsabilityExplanation(compStatus: string): string {
  switch (compStatus) {
    case 'degraded_performance':
    case 'partial_outage':
      return `Esta herramienta presenta fallas o lentitud pero está **Utilizable**.`;
    case 'major_outage':
      return `Esta herramienta **NO está disponible** temporalmente.`;
    case 'under_maintenance':
      return `Esta herramienta está en **Mantenimiento**.`;
    default:
      return `Esta herramienta presenta un estado inestable.`;
  }
}

function getCoreUsabilityExplanation(compStatus: string, compName: string): string {
  switch (compStatus) {
    case 'degraded_performance':
    case 'partial_outage':
      return `El acceso o uso de **${compName}** está inestable o lento temporalmente.`;
    case 'major_outage':
      return `El acceso o uso de **${compName}** **NO está disponible** (Caída total).`;
    case 'under_maintenance':
      return `**${compName}** se encuentra en mantenimiento programado.`;
    default:
      return `Estado inestable para **${compName}**.`;
  }
}

async function sendDiscordWebhook(
  url: string, 
  serviceName: string, 
  oldStatus: ServiceStatus, 
  newStatus: ServiceStatus, 
  description: string, 
  affectedComponents: ComponentStatus[],
  isManual: boolean = false
) {
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

  let descText = isManual 
    ? `**Estado del Servicio Principal:** ${newStatus.toUpperCase()}\n\n**Detalles:** ${description}`
    : `El estado del servicio principal ha cambiado de **${oldStatus}** a **${newStatus}**.\n\n**Detalles:** ${description}`;

  // Agregar detalle de componentes afectados si existen
  if (affectedComponents && affectedComponents.length > 0) {
    const coreAffections = affectedComponents.filter(c => c.isCore);
    const secondaryAffections = affectedComponents.filter(c => !c.isCore);

    if (coreAffections.length > 0) {
      descText += `\n\n**🔴 Componentes Principales Afectados (Servicio Interrumpido/Degradado):**\n`;
      for (const comp of coreAffections) {
        const expl = getCoreUsabilityExplanation(comp.status, comp.name);
        descText += `• **${comp.name}** (\`${comp.status.replace(/_/g, ' ')}\`):\n  └> ${expl}\n`;
      }
    }

    if (secondaryAffections.length > 0) {
      const mainIA = serviceName === 'OpenAI' ? 'ChatGPT y la API principal' : 'Claude (Chat y API)';
      descText += `\n\n**⚠️ Servicios Secundarios con Falla** *(El servicio principal de ${mainIA} sigue operativo):*\n`;
      for (const comp of secondaryAffections) {
        const expl = getUsabilityExplanation(comp.status);
        descText += `• **${comp.name}** (\`${comp.status.replace(/_/g, ' ')}\`):\n  └> ${expl}\n`;
      }
    }
  }

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
        await sendDiscordWebhook(
          env.DISCORD_WEBHOOK_URL, 
          service.name, 
          oldStatus, 
          info.status, 
          info.description, 
          info.affectedComponents, 
          false
        );
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
          'El bot ha sido desplegado exitosamente y acaba de establecer su línea base. Te avisaré cuando algún servicio principal se caiga.',
          [],
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
                info.affectedComponents, 
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

    // Solo respondemos un 200 genérico si entran por el navegador
    return new Response('IA Status Bot: Worker de monitoreo activo y operando de forma segura.');
  }
};
