// Worker de produção do motor de despacho da feira (item 62, 28/08/2026).
//
// Antes desta sessão, `src/index.js` (router Express de exemplo, nunca
// montado em nenhum processo) era a única "integração" existente — ou
// seja, despacharPedido() e os 3 crons (fecharRotasExpiradas,
// expirar_pedidos_pendentes, processarLote) nunca rodavam sozinhos em
// produção, só quando chamados manualmente via script de teste (ver
// CLAUDE.md, achado do item 24/26). Este arquivo é a integração REAL —
// mesma arquitetura já validada em `dispatch-engine/index.js` (LISTEN/
// NOTIFY do Postgres + reconciliação de startup/reconexão + crons via
// setInterval), sem reexpor os ~20 endpoints HTTP não-autenticados de
// `src/index.js` (checkout, avaliação, aceitar rota, etc. — decisão
// explícita: escopo deste serviço é só despacho+timeout, não API pública).
//
// Escuta o canal `pedido_grupo_pronto` (trigger notificar_pedido_grupo_pronto()
// em db/schema.sql, adicionada nesta sessão — mesmo princípio de
// notificar_pedido_pronto() do lado restaurante, incluindo a exclusão de
// dado de teste via estabelecimentos.is_teste).

require('dotenv').config();
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const { createRouteManager } = require('./src/routeManager');
const { createNotificationWorker, enviarWhatsappCloudAPI, enviarPushVoz } = require('./src/notifications');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3001;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) {
  console.error('Faltam variáveis de ambiente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const routeManager = createRouteManager(supabase);
const notificationWorker = createNotificationWorker(supabase, {
  enviarWhatsapp: enviarWhatsappCloudAPI,
  enviarPushVoz,
});

// achado real (testando este worker pela 1ª vez, item 62, 28/08/2026):
// chamar routeManager.despacharPedido() DUAS VEZES pro mesmo pedidoGrupoId
// já dispatchado duplica as paradas da rota (2 -> 4) — inserir_grupo_em_
// rota_atomico() já é idempotente no banco (`on conflict do nothing`), mas
// salvarSequencia() reescreve a sequência inteira a cada chamada sem checar
// se o grupo já está nela, então a 2ª chamada insere os stops de novo.
// Isso nunca apareceu antes porque despacharPedido() nunca rodava sozinho
// em produção (só via script de teste manual, 1 chamada por vez) — este
// worker é a 1ª coisa que pode chamá-lo 2x pro mesmo pedido de verdade
// (ex: NOTIFY duplicado, mesmo padrão já achado uma vez do lado
// restaurante — ver comentário em iniciarListener). Corrigir a causa raiz
// dentro de routeManager.js exigiria repensar salvarSequencia/
// encontrarMelhorInsercao com o mesmo cuidado que levou várias rodadas de
// ultrareview do lado restaurante — fora do escopo desta sessão. Blindado
// aqui, na borda: nenhuma chamada a despacharPedido() acontece sem antes
// confirmar que o grupo ainda não foi comitado numa rota nem tem proposta
// pendente — mesma checagem usada em despacharGruposOrfaos(), reaproveitada
// aqui pro caminho de NOTIFY direto. `pedidosDespachando` fecha a janela
// de corrida ENTRE a checagem e o despacho de verdade (2 chamadas quase
// simultâneas pro mesmo grupo, mesmo princípio do `rotasProcessando` do
// dispatch-engine).
const pedidosDespachando = new Set();

async function jaFoiTratado(pedidoGrupoId) {
  const [{ data: comitado }, { data: pendente }] = await Promise.all([
    supabase.from('entrega_rota_grupo').select('pedido_grupo_id').eq('pedido_grupo_id', pedidoGrupoId).maybeSingle(),
    supabase.from('proposta_consolidacao').select('id').eq('pedido_grupo_id', pedidoGrupoId).eq('status', 'pendente').maybeSingle(),
  ]);
  return !!comitado || !!pendente;
}

async function despacharComLog(pedidoGrupoId) {
  if (pedidosDespachando.has(pedidoGrupoId)) {
    console.log(`[despacho-feira] pedido_grupo ${pedidoGrupoId}: já tem um despacho em andamento — ignorando chamada concorrente`);
    return;
  }
  pedidosDespachando.add(pedidoGrupoId);
  try {
    if (await jaFoiTratado(pedidoGrupoId)) {
      console.log(`[despacho-feira] pedido_grupo ${pedidoGrupoId}: já comitado numa rota ou com proposta pendente — ignorando (provável NOTIFY duplicado)`);
      return;
    }
    const resultado = await routeManager.despacharPedido(pedidoGrupoId);
    console.log(`[despacho-feira] pedido_grupo ${pedidoGrupoId} -> ${resultado.acao}`);
  } catch (e) {
    console.error(`[despacho-feira] falha ao despachar pedido_grupo ${pedidoGrupoId}:`, e.message);
  } finally {
    pedidosDespachando.delete(pedidoGrupoId);
  }
}

// Rede de segurança (mesmo princípio de despacharPedidosOrfaos() no
// dispatch-engine, ver item 62): pega pedido_grupo pronto_para_coleta que
// nunca foi comitado numa rota (entrega_rota_grupo, unique por
// pedido_grupo_id) NEM tem proposta_consolidacao pendente aguardando
// resposta do entregador (não quero criar uma 2ª proposta duplicada
// enquanto a 1ª ainda está em aberto). Chamada na subida, após cada
// reconexão do listener, e num poll periódico — fecha a janela de
// qualquer NOTIFY perdido (rede/reconexão), mesmo achado do item 61/62 do
// lado restaurante.
async function despacharGruposOrfaos() {
  const { data: grupos, error } = await supabase
    .from('pedido_grupo')
    .select('id')
    .eq('status', 'pronto_para_coleta');
  if (error) {
    console.error('[reconciliação-feira] falha ao buscar pedido_grupo pronto:', error.message);
    return;
  }
  if (!grupos || grupos.length === 0) return;

  const ids = grupos.map((g) => g.id);
  const [{ data: comitados }, { data: pendentes }] = await Promise.all([
    supabase.from('entrega_rota_grupo').select('pedido_grupo_id').in('pedido_grupo_id', ids),
    supabase.from('proposta_consolidacao').select('pedido_grupo_id').eq('status', 'pendente').in('pedido_grupo_id', ids),
  ]);
  const jaTratados = new Set([
    ...(comitados || []).map((c) => c.pedido_grupo_id),
    ...(pendentes || []).map((p) => p.pedido_grupo_id),
  ]);

  for (const g of grupos) {
    if (jaTratados.has(g.id)) continue;
    console.log(`[reconciliação-feira] pedido_grupo ${g.id} pronto sem rota nem proposta pendente — despachando agora`);
    await despacharComLog(g.id);
  }
}

// ------------------------------------------------------------
// LISTEN/NOTIFY com reconexão — mesma estrutura de dispatch-engine/index.js,
// já corrigida desde o início pro achado do item 62 (reconexão sem
// .catch() podia derrubar o processo inteiro numa queda de rede/DNS real).
// ------------------------------------------------------------
let reconectando = false;
let jaConectouAntes = false;

async function iniciarListener() {
  const listener = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const agendarReconexao = (motivo) => {
    if (reconectando) return;
    reconectando = true;
    console.warn(`[listener-feira] ${motivo} — reconectando em 5s`);
    setTimeout(async () => {
      reconectando = false;
      try {
        await iniciarListener();
      } catch (e) {
        agendarReconexao(`falha ao reconectar: ${e.message}`);
      }
    }, 5000);
  };

  listener.on('error', (e) => agendarReconexao(`erro na conexão: ${e.message}`));
  listener.on('end', () => agendarReconexao('conexão encerrada'));

  await listener.connect();
  await listener.query('LISTEN pedido_grupo_pronto');

  if (jaConectouAntes) {
    despacharGruposOrfaos().catch((e) => console.error('[reconciliação-feira] falha na varredura pós-reconexão:', e.message));
  }
  jaConectouAntes = true;

  listener.on('notification', (msg) => {
    if (msg.channel === 'pedido_grupo_pronto') {
      despacharComLog(msg.payload);
    }
  });

  console.log('[listener-feira] conectado — escutando pedido_grupo_pronto');
}

async function main() {
  await despacharGruposOrfaos();
  await iniciarListener();

  // rede de segurança final — ver comentário em despacharGruposOrfaos()
  setInterval(() => {
    despacharGruposOrfaos().catch((e) => console.error('[reconciliação-feira] falha no poll periódico:', e.message));
  }, 60 * 1000);

  // Os 3 crons já previstos (comentário no fim de src/index.js), nunca
  // conectados a lugar nenhum antes desta sessão.
  setInterval(() => {
    routeManager.fecharRotasExpiradas()
      .then((fechadas) => {
        if (fechadas.length) console.log(`[cron-feira] ${fechadas.length} rota(s) fechada(s) por tempo de montagem esgotado`);
      })
      .catch((e) => console.error('[cron-feira] falha em fecharRotasExpiradas:', e.message));
  }, 30 * 1000);

  setInterval(() => {
    supabase.rpc('expirar_pedidos_pendentes')
      .then(({ data, error }) => {
        if (error) return console.error('[cron-feira] falha em expirar_pedidos_pendentes:', error.message);
        if (data && data.length) console.log(`[cron-feira] expirar_pedidos_pendentes: ${data.length} pedido_grupo(s) processado(s)`);
      });
  }, 60 * 1000);

  setInterval(() => {
    notificationWorker.processarLote()
      .then((r) => {
        if (r.total) console.log(`[cron-feira] processarLote: ${r.enviados} enviado(s), ${r.falhas} falha(s) de ${r.total}`);
      })
      .catch((e) => console.error('[cron-feira] falha em processarLote:', e.message));
  }, 15 * 1000);

  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Mesmo princípio do dispatch-engine (ver comentário lá): NOTIFY nunca
  // dispara pra estabelecimento de teste, então um teste que sobe este
  // worker como subprocesso precisa de um jeito de chamar a mesma função
  // que o listener chamaria, sem depender de pg_notify. Só existe com
  // HABILITAR_ENDPOINTS_TESTE=true — nunca setado em produção.
  if (process.env.HABILITAR_ENDPOINTS_TESTE === 'true') {
    app.use(express.json());
    app.post('/interno/despachar', async (req, res) => {
      // passa por despacharComLog() (não chama routeManager.despacharPedido()
      // direto) — assim o teste exercita a MESMA blindagem contra despacho
      // duplicado que o caminho de NOTIFY real usa (ver comentário em
      // despacharComLog). Resposta não devolve o resultado do despacho em si
      // (ele é assíncrono e pode ser pulado por já ter sido tratado) — o
      // teste confirma o efeito consultando o banco depois.
      despacharComLog(req.body.pedidoGrupoId);
      res.json({ ok: true, agendado: true });
    });
  }

  app.listen(PORT, () => console.log(`[http] healthcheck em http://localhost:${PORT}/health`));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[fatal]', e);
    process.exit(1);
  });
}

module.exports = { despacharComLog, despacharGruposOrfaos };
