'use strict';

/**
 * Worker simples de notificações. Roda em cron curto (ex: a cada 15s)
 * consumindo a fila `notificacao` (ver migration 003) e despachando
 * pro canal correto. A integração real com WhatsApp Cloud API fica
 * isolada em `enviarWhatsapp()` — troque pelo provider que preferir
 * (Cloud API oficial, Twilio, Z-API etc.) sem tocar no resto do worker.
 *
 * FIX aplicado nesta cópia (integração GiroCerto, 22/08/2026):
 * `buscarContato()` selecionava `telefone, whatsapp` — nenhuma das 3
 * tabelas (usuarios/estabelecimentos/entregadores) tem uma coluna
 * `whatsapp` separada, essa query quebraria com "column does not exist".
 * Corrigido pra usar só `telefone` (o número já cadastrado é o mesmo
 * usado pro WhatsApp, não precisa de campo duplicado).
 */
function createNotificationWorker(supabase, { enviarWhatsapp, enviarPush, enviarPushVoz } = {}) {
  const templates = {
    pedido_novo: () => 'Novo pedido chegou na sua banca! Confira e confirme o Pix. 🧺',
    pagamento_confirmado: () => 'Pagamento confirmado pelo cliente.',
    pronto_coleta: () =>
      'Seu pedido está pronto! O entregador vai buscar em breve. 🛵',
    // Correção (22/08/2026): sem tratamento Sr./Sra. — só buzina + primeiro
    // nome, sem honorífico.
    saiu_entrega: (payload) =>
      `Olá, ${payload?.nomeCliente || ''}! Seu pedido está a caminho. 🛵`,
    proximidade_chegada: (payload) =>
      `${payload?.nomeCliente || ''}, seu pedido está chegando! Vá até a portaria ou o portão, por favor. 📦`,
    entregue: () => 'Pedido entregue! Bom apetite 🥬',
    grupo_cancelado: () =>
      'Seu pedido foi cancelado — algum feirante não confirmou o pagamento a tempo. Nenhuma cobrança foi feita pela plataforma.',
  };

  /** Busca telefone do destinatário conforme o tipo (consumidor/feirante/entregador). */
  async function buscarContato(destinatarioTipo, destinatarioId) {
    const tabela = {
      consumidor: 'usuarios',
      feirante: 'estabelecimentos',
      entregador: 'entregadores',
    }[destinatarioTipo];

    const { data, error } = await supabase
      .from(tabela)
      .select('telefone')
      .eq('id', destinatarioId)
      .single();

    if (error) return null;
    return data.telefone || null;
  }

  async function processarLote(limite = 20) {
    const { data: pendentes, error } = await supabase
      .from('notificacao')
      .select('*')
      .eq('status', 'pendente')
      .order('created_at', { ascending: true })
      .limit(limite);

    if (error) throw error;

    let enviados = 0;
    let falhas = 0;

    for (const notif of pendentes || []) {
      try {
        // eventos direcionados ao consumidor com nome/tratamento formal
        // precisam do nome e gênero antes de montar a mensagem
        let payloadEnriquecido = notif.payload;
        if (notif.destinatario_tipo === 'consumidor' && notif.payload?.pedido_grupo_id) {
          const { data: consumidor } = await supabase
            .from('usuarios')
            .select('nome')
            .eq('id', notif.destinatario_id)
            .single();
          payloadEnriquecido = {
            ...notif.payload,
            nomeCliente: consumidor?.nome?.split(' ')[0] || '', // só o primeiro nome
          };
        }

        const mensagem = templates[notif.evento]
          ? templates[notif.evento](payloadEnriquecido)
          : `Atualização do seu pedido: ${notif.evento}`;

        if (notif.canal === 'push_voz' && enviarPushVoz) {
          // canal com áudio anexado — toca automaticamente mesmo com
          // celular bloqueado, exige app nativo e token registrado
          const { data: usuario } = await supabase
            .from('usuarios')
            .select('push_token, push_plataforma')
            .eq('id', notif.destinatario_id)
            .single();

          const { data: audio } = await supabase
            .from('notificacao_audio')
            .select('*')
            .eq('evento', notif.evento)
            .single();

          if (!usuario?.push_token || !audio) {
            throw new Error('sem push_token ou áudio cadastrado — não deveria ter escolhido push_voz');
          }

          await enviarPushVoz(usuario.push_token, usuario.push_plataforma, notif.evento, {
            textoReferencia: mensagem, // texto visível personalizado; o SOM em si é o arquivo fixo (buzina + voz genérica)
          });
        } else {
          const contato = await buscarContato(notif.destinatario_tipo, notif.destinatario_id);
          if (!contato) throw new Error('contato não encontrado');

          if (notif.canal === 'whatsapp' && enviarWhatsapp) {
            await enviarWhatsapp(contato, mensagem);
          } else if (notif.canal === 'push' && enviarPush) {
            await enviarPush(notif.destinatario_id, mensagem);
          }
        }

        await supabase
          .from('notificacao')
          .update({ status: 'enviado', enviado_em: new Date().toISOString() })
          .eq('id', notif.id);

        enviados++;
      } catch (err) {
        console.error(`[notificacao ${notif.id}] falha ao enviar:`, err.message);
        await supabase.from('notificacao').update({ status: 'falhou' }).eq('id', notif.id);
        falhas++;
      }
    }

    return { enviados, falhas, total: (pendentes || []).length };
  }

  return { processarLote };
}

/**
 * PUSH COM VOZ (canal 'push_voz') — a única forma real de tocar áudio
 * automaticamente com o celular bloqueado. Funciona porque o sistema
 * operacional (Android/iOS) toca o som ANEXADO à notificação
 * automaticamente ao receber, sem precisar abrir o app nem desbloquear
 * a tela — é o mesmo mecanismo que Uber/99 usam pro "seu motorista chegou".
 *
 * WhatsApp NÃO suporta isso — toda mensagem do WhatsApp Business toca
 * o som padrão do WhatsApp, sem exceção. Por isso esse canal só
 * funciona pra quem tem o app nativo do GiroCerto instalado
 * (ver push_token em `usuarios`, migration 009); quem não tem, cai
 * automaticamente pro WhatsApp de texto normal — o worker já resolve
 * isso via `escolher_canal_notificacao()` no banco.
 *
 * Requer:
 * - App nativo (Android/iOS) registrando o device pra push (FCM/APNs)
 * - Áudios curtos pré-gravados (não é TTS em tempo real — frases fixas,
 *   gravadas uma vez, hospedadas em CDN — ver tabela notificacao_audio)
 * - Android: canal de notificação configurado com som customizado
 * - iOS: arquivo de som embutido no bundle do app (limite ~30s,
 *   formato .caf/.aiff/.wav) — não dá pra tocar áudio remoto
 *   dinâmico como som do sistema, por isso os áudios ficam fixos
 */
async function enviarPushVoz(pushToken, plataforma, evento, audioInfo) {
  const payload = {
    token: pushToken,
    notification: {
      title: 'GiroCerto',
      body: audioInfo.textoReferencia,
    },
    android: {
      priority: 'high',
      notification: {
        channel_id: 'girocerto_voz', // precisa existir no app, configurado com som customizado
        sound: `${evento}.mp3`, // arquivo precisa estar em res/raw no app Android
      },
    },
    apns: {
      payload: {
        aps: {
          sound: `${evento}.caf`, // arquivo precisa estar embutido no bundle iOS
          'content-available': 1,
        },
      },
    },
  };

  const resp = await fetch('https://fcm.googleapis.com/v1/projects/SEU_PROJETO/messages:send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FCM_SERVER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: payload }),
  });

  if (!resp.ok) {
    throw new Error(`FCM respondeu ${resp.status}: ${await resp.text()}`);
  }
}

/**
 * Exemplo de integração real com WhatsApp Cloud API (Meta).
 * Preencha WHATSAPP_TOKEN e WHATSAPP_PHONE_ID nas variáveis de ambiente.
 */
async function enviarWhatsappCloudAPI(numero, mensagem) {
  const resp = await fetch(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: numero,
        type: 'text',
        text: { body: mensagem },
      }),
    }
  );

  if (!resp.ok) {
    throw new Error(`WhatsApp API respondeu ${resp.status}: ${await resp.text()}`);
  }
}

/**
 * Envia uma NOTA DE VOZ (mensagem de áudio) pelo WhatsApp — funciona
 * hoje, sem precisar de app nativo. É a via prática pra ter voz
 * personalizada (com nome do cliente) antes de investir em app próprio.
 * O áudio precisa estar hospedado numa URL pública (upload no Supabase
 * Storage, S3, etc.) — o WhatsApp Cloud API busca o arquivo por URL.
 */
async function enviarWhatsappAudio(numero, urlAudio) {
  const resp = await fetch(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: numero,
        type: 'audio',
        audio: { link: urlAudio },
      }),
    }
  );

  if (!resp.ok) {
    throw new Error(`WhatsApp API (áudio) respondeu ${resp.status}: ${await resp.text()}`);
  }
}

module.exports = { createNotificationWorker, enviarWhatsappCloudAPI, enviarPushVoz, enviarWhatsappAudio };
