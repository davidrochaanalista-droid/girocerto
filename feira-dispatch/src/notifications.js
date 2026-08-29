'use strict';

const admin = require('firebase-admin');

/**
 * Inicialização lazy do firebase-admin — só na primeira chamada que
 * precisar mandar push de verdade, não no require() do módulo (evita
 * quebrar em ambiente/teste que não tem FIREBASE_SERVICE_ACCOUNT_JSON
 * configurado e nunca chama nenhuma função de push).
 *
 * FIREBASE_SERVICE_ACCOUNT_JSON: o JSON inteiro da service account
 * (Firebase Console > Project Settings > Service Accounts > Generate
 * new private key), como STRING numa única variável de ambiente — não
 * confundir com google-services.json, que é a config do app Android
 * (client-side, vai commitado no repo) e não tem nada a ver com essa var.
 */
function appFirebase() {
  if (!admin.apps.length) {
    const credencial = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(credencial) });
  }
  return admin;
}

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

  // FIX (planejamento FCM, 22/08/2026): a chamada antiga usava fetch()
  // manual com um bearer estático (FCM_SERVER_TOKEN) contra o endpoint
  // v1 — o v1 exige token OAuth2 de uma service account, não um server
  // key fixo (modelo legado, hoje incompatível com esse endpoint).
  // firebase-admin resolve o OAuth2 sozinho por trás de .send().
  await appFirebase().messaging().send(payload);
}

/**
 * PUSH SÓ COM BUZINA pro ENTREGADOR — nova oferta de restaurante, nova
 * oferta de feira, ou parada nova proposta numa rota já aceita. Som
 * FIXO (buzina_bi_bi.mp3), nunca passa pelo pipeline de mistura
 * buzina+voz (ttsGenerator.js/ElevenLabs) que é exclusivo do canal do
 * CONSUMIDOR (enviarPushVoz acima) — o entregador ouve sempre o mesmo
 * som, independente do evento, por isso essa função não recebe `evento`
 * nem `audioInfo` nenhum.
 *
 * Só Android por enquanto (decisão explícita, 22/08/2026) — o projeto
 * nunca teve suporte iOS (só @capacitor/android instalado); sem bloco
 * `apns`, sem arquivo .caf. Adicionar iOS aqui fica pra quando/se decidir
 * suportar a plataforma de verdade.
 *
 * Chamada direto do código de despacho (dispatch-engine/index.js e
 * feira-dispatch/src/routeManager.js), fora da fila `notificacao` — ou
 * seja, sem retry automático se o envio falhar (decisão explícita,
 * 22/08/2026: aceitável nesta fase porque o push é só um AVISO, a oferta
 * de verdade já está gravada no banco e chega pro app via Realtime/
 * polling de qualquer forma — falha de push nunca bloqueia o despacho
 * em si, só logada).
 */
async function enviarPushBuzinaEntregador(pushToken, plataforma) {
  if (plataforma !== 'android') return; // sem suporte iOS ainda

  await appFirebase().messaging().send({
    token: pushToken,
    notification: {
      title: 'GiroCerto',
      body: 'Nova entrega disponível',
    },
    android: {
      priority: 'high',
      notification: {
        channel_id: 'girocerto_buzina_entregador_v2', // precisa existir no app, som customizado (v2: 25/08/2026, trocado pra volume de alarme — ver MainActivity.java)
        sound: 'buzina_bi_bi', // res/raw/buzina_bi_bi.mp3 — sem extensão no payload FCM
      },
    },
  });
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

module.exports = {
  createNotificationWorker,
  enviarWhatsappCloudAPI,
  enviarPushVoz,
  enviarWhatsappAudio,
  // achado real (item 62, 28/08/2026, testando o worker novo de ponta a
  // ponta pela 1ª vez): faltava aqui — routeManager.js importa
  // `enviarPushBuzinaEntregador` deste módulo (`require('./notifications')`),
  // mas ela nunca tinha sido exportada. Como a chamada é fire-and-forget
  // (try/catch só loga, nunca bloqueia o despacho — ver notificarEntregadorPush
  // em routeManager.js), o erro "enviarPushBuzinaEntregador is not a
  // function" ficava sempre escondido no log — o push de oferta pro
  // entregador da feira nunca funcionou, silenciosamente, desde que essa
  // cópia do módulo foi integrada (22/08/2026).
  enviarPushBuzinaEntregador,
};
