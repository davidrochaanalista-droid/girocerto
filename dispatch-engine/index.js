// Motor de despacho do GiroCerto (sessão de go-to-market, 15/08/2026).
//
// Arquitetura (decidida e testada antes de codar, ver CLAUDE.md): backend
// Node separado (não lógica só em Postgres) porque o repique/timeout
// parametrizados por tenant precisam de timing preciso que pg_cron não
// garante nessa granularidade. LISTEN/NOTIFY testado e confirmado confiável
// contra a conexão DIRETA do Supabase hospedado (não o pooler transacional
// — pgbouncer em modo transaction reciclaria a conexão que fica escutando).
// Usa a service_role key (bypassa RLS) — é o próprio schema que já
// documentava essa expectativa antes de existir código nenhum aqui.
//
// Escopo v1, conforme combinado: 1 pedido por rota (sem agrupamento ainda),
// falha manual explícita quando os candidatos se esgotam (não inventa
// retry-pra-sempre nem escalonamento automático que não foi pedido).
//
// Revisado numa 2ª rodada de /ultrareview (mesma sessão) — várias corridas
// (race conditions) reais foram achadas e corrigidas aqui: criação
// duplicada de rota, dupla atribuição de rota no aceite, timeout
// sobrescrevendo uma resposta real, mesmo entregador recebendo 2 ofertas
// simultâneas, reconexão duplicada do listener, vazamento de memória em
// rotas esgotadas/abandonadas, e reconciliação que não reconstruía o
// histórico de failover. Todas as correções usam UPDATE...WHERE com
// checagem de linhas afetadas em vez de SELECT-depois-UPDATE (que não é
// atômico) — é o mesmo padrão que passou a ser usado no lado do Postgres
// nesta sessão (pausar_entregador()/retomar_entregador()/
// confirmar_retirada_rota()).
//
// Limitação conhecida: estado de failover (quem já foi tentado por rota) e
// os timers de timeout vivem em memória do processo — não sobrevivem a um
// restart. A reconciliação de startup (abaixo) cobre o caso comum (pedidos
// prontos sem rota, tentativas expiradas sem resposta, histórico de quem já
// recusou por rota), mas um restart no meio de uma janela de repique perde
// o timer específico daquela tentativa (ela só é pega na próxima
// reconciliação, que roda 1x na subida). Pra um piloto de 2-3 lojas isso é
// aceitável; documentado, não escondido.

require('dotenv').config();
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const firebaseAdmin = require('firebase-admin');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) {
  console.error('Faltam variáveis de ambiente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Push nativo pro entregador — cópia própria da mesma função de
// feira-dispatch/src/notifications.js (planejamento FCM, 22/08/2026),
// duplicada de propósito: os dois são processos Node separados, sem
// pacote compartilhado, mesmo princípio já usado pra entrega_rota/
// rota_parada (zero risco de acoplar os dois domínios pesa mais que
// evitar a duplicação). Som FIXO (buzina_bi_bi), nunca o pipeline de
// mistura buzina+voz do consumidor. Só Android por enquanto — projeto
// nunca teve suporte iOS. Fire-and-forget: falha de push é só logada,
// nunca bloqueia o despacho em si (a oferta real já está gravada em
// tentativas_despacho, chega pro app via Realtime/polling de qualquer
// forma).
function appFirebase() {
  if (!firebaseAdmin.apps.length) {
    const credencial = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(credencial) });
  }
  return firebaseAdmin;
}

async function enviarPushBuzinaEntregador(pushToken, plataforma, tag) {
  if (plataforma !== 'android' || !pushToken) return;
  try {
    await appFirebase().messaging().send({
      token: pushToken,
      notification: { title: 'GiroCerto', body: 'Nova entrega disponível' },
      android: {
        priority: 'high',
        // achado real (25/08/2026, teste em aparelho físico): sem "tag",
        // cada disparo do repique cria uma notificação NOVA em vez de
        // substituir a anterior — o Android empilha e toca cada som de
        // 20s em sequência, então mesmo depois do repique parar de
        // verdade no backend, o aparelho continuava "tocando" por um bom
        // tempo só terminando a fila. "tag" = id da tentativa faz cada
        // repique da MESMA oferta substituir o anterior (mesmo
        // comportamento de sempre do Android pra tag repetida), sem fila.
        notification: { channel_id: 'girocerto_buzina_entregador_v2', sound: 'buzina_bi_bi', tag },
      },
    });
    console.log('[push] buzina enviada ao entregador');
  } catch (err) {
    console.error('[push] falha ao notificar entregador (não bloqueia o despacho):', err.message);
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// rota_id -> Set<entregador_id> já tentados nessa rota (failover não repete candidato)
const tentadosPorRota = new Map();
// rota_id -> Timeout do setTimeout de timeout pendente
const timersPorRota = new Map();
// rota_id -> Interval do setInterval de repique (re-envio do push a cada
// tenants.segundos_repique_notificacao, até aceitar/recusar/expirar)
const repiquesPorRota = new Map();
// rota_id -> presente enquanto uma execução de tentarDespachar está no
// trecho "achar candidato -> criar tentativa -> agendar push/timers" pra
// essa rota. Ver comentário em tentarDespachar sobre por que isso existe.
const rotasProcessando = new Set();

function limparEstadoDaRota(rotaId) {
  tentadosPorRota.delete(rotaId);
  const timer = timersPorRota.get(rotaId);
  if (timer) {
    clearTimeout(timer);
    timersPorRota.delete(rotaId);
  }
  const repique = repiquesPorRota.get(rotaId);
  if (repique) {
    clearInterval(repique);
    repiquesPorRota.delete(rotaId);
  }
}

// repete o mesmo push (mesmo "toque calmo") a cada segundosRepique, até a
// tentativa resolver (aceito/recusado, ver tratarRespostaDespacho) ou o
// timeout vencer (ver agendarTimeout) — os dois jeitos "normais" de uma
// tentativa terminar, cada um já limpa o interval explicitamente.
//
// achado real (25/08/2026, testando em aparelho físico): esses dois
// caminhos dependem do NOTIFY do Postgres pra avisar este processo — e
// tenant de teste (is_teste=true) nunca dispara esse NOTIFY de propósito
// (item 26), então testar manualmente pelo app real (não pelo endpoint de
// teste) deixava o repique preso pra sempre, mesmo já aceito/recusado.
// Autocorreção: a cada disparo, confere direto no banco se a tentativa
// ainda está pendente ANTES de mandar o push — se já foi resolvida (por
// qualquer caminho, NOTIFY perdido ou não), para sozinho aqui, sem
// precisar do NOTIFY pra limpar. Cobre não só o gap de teste, mas
// qualquer NOTIFY perdido de verdade (rede, reconexão) em produção
// também — rede de segurança, não só conveniência de teste.
function agendarRepique(rotaId, pushToken, plataforma, segundosRepique, tentativaId) {
  if (!segundosRepique || segundosRepique <= 0) return;
  const interval = setInterval(async () => {
    if (tentativaId) {
      const { data: tentativa, error } = await admin
        .from('tentativas_despacho')
        .select('resultado')
        .eq('id', tentativaId)
        .single();
      // erro de rede/conexão: falha aberta, manda o push mesmo assim — não
      // quero um blip de rede parando um repique que ainda é legítimo.
      // Só para quando a consulta FUNCIONOU e confirmou que já resolveu.
      if (!error && (!tentativa || tentativa.resultado)) {
        console.log(`[despacho] repique da tentativa ${tentativaId} parado — já resolvida (achado que o NOTIFY não avisou, ex: tenant de teste)`);
        clearInterval(interval);
        repiquesPorRota.delete(rotaId);
        return;
      }
    }
    enviarPushBuzinaEntregador(pushToken, plataforma, tentativaId);
  }, segundosRepique * 1000);
  repiquesPorRota.set(rotaId, interval);
}

async function buscarConfigTenant(tenantId) {
  const { data, error } = await admin
    .from('tenants')
    .select('raio_chamada_motoboy_km, raio_chamada_maximo_km, segundos_repique_notificacao, segundos_timeout_despacho, lat, lng')
    .eq('id', tenantId)
    .single();
  if (error) throw new Error(`buscarConfigTenant(${tenantId}): ${error.message}`);
  return data;
}

// achado ultrareview: antes só filtrava por status='disponivel', mas um
// entregador com uma tentativa aberta (resultado ainda null) em OUTRA rota
// continua com status='disponivel' até responder — podia ser ofertado duas
// vezes ao mesmo tempo. Exclui quem tem qualquer tentativa pendente, não só
// quem já foi tentado NESSA rota especificamente.
// item 36 (25/08/2026): busca expandida — se ninguém dentro do raio normal
// (raioKm = raio_chamada_motoboy_km), tenta de novo até raioMaximoKm
// (raio_chamada_maximo_km) antes de desistir. Quem vem de fora do raio
// normal recebe km adicional (ver gerar_repasse_ao_entregar() em
// db/schema.sql) — por isso o candidato retornado carrega .distancia
// mesmo quando achado na primeira passada (mais barato reaproveitar o
// valor já calculado do que o trigger recalcular sem essa informação).
// item 52 (27/08/2026), correção do usuário: freelance pega rota de
// QUALQUER loja (não só de uma com vínculo pré-existente), desde que tenha
// turno ativo + esteja disponível — só fixo fica preso à própria loja.
// buscar_candidatos_despacho() (db/schema.sql) já une os dois grupos
// (vínculo direto + pool aberto) e devolve `precisa_criar_vinculo` pro 2º
// grupo — o vínculo só é criado de fato pra quem VENCE a escolha (evita
// criar linha em entregadores pra candidato que nem foi chamado).
async function resolverVinculoCandidato(candidato, tenantId) {
  if (!candidato.precisa_criar_vinculo) return candidato.entregador_id;
  const { data: entregadorId, error } = await admin.rpc('get_or_criar_vinculo_freelance', {
    p_pessoa_id: candidato.pessoa_id, p_tenant_id: tenantId,
  });
  if (error) throw new Error(`resolverVinculoCandidato: ${error.message}`);
  return entregadorId;
}

async function buscarProximoCandidato(tenantId, rotaId, tenantLat, tenantLng, raioKm, raioMaximoKm, candidatosExcluidos = new Set()) {
  const jaTentados = tentadosPorRota.get(rotaId) || new Set();

  const { data: candidatosData, error: erroCandidatos } = await admin.rpc('buscar_candidatos_despacho', { p_tenant_id: tenantId });
  if (erroCandidatos) throw new Error(`buscarProximoCandidato (candidatos): ${erroCandidatos.message}`);

  // candidato do pool aberto ainda não tem entregador_id (vínculo só é
  // criado pro vencedor) — usa pessoa_id como chave de exclusão de
  // "já tentado" até esse ponto, já que entregador_id vem null pra eles.
  // candidatosExcluidos: quem já perdeu a corrida de reivindicar a
  // tentativa NESTA chamada de tentarDespachar (ver retry em
  // tentarDespachar) — sempre chave por entregador_id, já resolvido.
  let elegiveis = (candidatosData || []).filter((c) => {
    const chave = c.entregador_id || `pessoa:${c.pessoa_id}`;
    return !jaTentados.has(chave) && !candidatosExcluidos.has(c.entregador_id) && !candidatosExcluidos.has(chave);
  });

  let vencedor = null;
  if (tenantLat != null && tenantLng != null) {
    elegiveis = elegiveis
      .map((c) => ({
        ...c,
        distancia: c.lat != null && c.lng != null ? haversineKm(tenantLat, tenantLng, c.lat, c.lng) : Infinity,
      }))
      .sort((a, b) => a.distancia - b.distancia);

    const dentroDoRaioNormal = elegiveis.filter((c) => c.distancia <= raioKm);
    if (dentroDoRaioNormal.length > 0) {
      vencedor = dentroDoRaioNormal[0];
    } else {
      const dentroDoRaioExpandido = elegiveis.filter((c) => c.distancia <= raioMaximoKm);
      if (dentroDoRaioExpandido.length > 0) {
        console.log(`[despacho] rota ${rotaId}: ninguém dentro de ${raioKm}km, chamando de fora do raio normal (${dentroDoRaioExpandido[0].distancia.toFixed(2)}km, dentro do teto de ${raioMaximoKm}km) — vai gerar km adicional`);
        vencedor = dentroDoRaioExpandido[0];
      }
    }
  } else {
    // sem lat/lng do tenant: sem geofiltro (loja ainda não definiu
    // localização em painel-loja.html) — pega qualquer disponível.
    vencedor = elegiveis[0] || null;
  }

  if (!vencedor) return null;

  const entregadorId = await resolverVinculoCandidato(vencedor, tenantId);
  return { ...vencedor, id: entregadorId };
}

async function tentarDespachar(pedidoId) {
  const { data: pedido, error: ePedido } = await admin.from('pedidos').select('*').eq('id', pedidoId).single();
  if (ePedido || !pedido) {
    console.error('[despacho] pedido não encontrado', pedidoId, ePedido && ePedido.message);
    return;
  }
  if (pedido.status !== 'pronto') {
    return; // já mudou de status entre o NOTIFY e agora (ou reconciliação duplicada) — ignora
  }

  const config = await buscarConfigTenant(pedido.tenant_id);
  let rotaId = pedido.rota_id;

  if (!rotaId) {
    const { data: rota, error: eRota } = await admin
      .from('rotas_entrega')
      .insert({ tenant_id: pedido.tenant_id, status: 'planejada' })
      .select('id')
      .single();
    if (eRota) {
      console.error('[despacho] falha ao criar rota', eRota.message);
      return;
    }

    // achado ultrareview: duas invocações concorrentes de tentarDespachar pro
    // MESMO pedido (ex: NOTIFY duplicado por causa da reconexão dupla que
    // também foi corrigida nesta rodada, ou uma corrida genuína) podiam ler
    // pedido.rota_id como null e cada uma criar sua própria rota. O UPDATE
    // abaixo só afeta a linha se rota_id AINDA estiver null — atômico, não
    // corrida SELECT-depois-UPDATE. Quem perde a corrida descarta a rota que
    // acabou de criar e usa a que realmente venceu.
    const { data: claim, error: eClaim } = await admin
      .from('pedidos')
      .update({ rota_id: rota.id, ordem_na_rota: 1 })
      .eq('id', pedidoId)
      .is('rota_id', null)
      .select('rota_id');
    if (eClaim) {
      console.error('[despacho] falha ao reivindicar pedido pra rota', eClaim.message);
      return;
    }
    if (!claim || claim.length === 0) {
      console.log(`[despacho] pedido ${pedidoId}: perdeu a corrida de criação de rota — descartando rota órfã ${rota.id}`);
      await admin.from('rotas_entrega').delete().eq('id', rota.id);
      const { data: pedidoAtualizado } = await admin.from('pedidos').select('rota_id').eq('id', pedidoId).single();
      rotaId = pedidoAtualizado && pedidoAtualizado.rota_id;
      if (!rotaId) {
        console.error('[despacho] corrida na criação de rota sem vencedor identificável pro pedido', pedidoId);
        return;
      }
    } else {
      rotaId = rota.id;
    }
  }

  // achado ao vivo (25/08/2026, testando o repique): a proteção acima só
  // cobre a CRIAÇÃO da rota — duas invocações concorrentes de
  // tentarDespachar (NOTIFY duplicado ou corrida genuína, mesmo cenário já
  // documentado acima) convergiam pro mesmo rotaId e cada uma seguia
  // sozinha, criando sua PRÓPRIA tentativa/push/timers pra ele. Os Maps
  // (timersPorRota, repiquesPorRota) só guardam o último registrado — o
  // timer/interval da outra invocação fica órfão, nunca é limpo. Pra um
  // setTimeout isso é inofensivo (dispara uma vez e não faz nada, porque
  // resultado já não é mais null); pra um setInterval de repique é grave —
  // fica repicando push pra sempre, sem jeito de parar a não ser reiniciar
  // o processo (reproduzido ao vivo: 67 pushes num pedido de teste em
  // ~15s). Lock simples por rotaId fecha essa janela.
  if (rotasProcessando.has(rotaId)) {
    console.log(`[despacho] pedido ${pedidoId} (rota ${rotaId}): já tem um tentarDespachar em andamento pra essa rota — ignorando invocação concorrente`);
    return;
  }
  rotasProcessando.add(rotaId);
  try {
    // achado real (teste de carga simultâneo, 27/08/2026, item 52): o lock
    // `rotasProcessando` só protege duas chamadas concorrentes pra MESMA
    // rota — não protege N pedidos DIFERENTES (rotas diferentes) que
    // buscam candidato ao mesmo tempo e escolhem o MESMO entregador antes
    // de qualquer um ter inserido sua tentativa (busca em
    // buscar_candidatos_despacho() e o INSERT abaixo não são atômicos
    // juntos). Reproduzido ao vivo: 6 pedidos simultâneos, 1 só
    // entregador recebendo as 6 ofertas. Corrigido com um índice único
    // parcial (`idx_tentativas_despacho_um_aberto_por_entregador`, db/schema.sql)
    // — no máximo 1 tentativa aberta por entregador no banco inteiro,
    // não só por rota — e retry aqui excluindo quem perdeu a corrida.
    let candidatosExcluidos = new Set();
    for (let tentativaNum = 0; tentativaNum < 10; tentativaNum++) {
      const candidato = await buscarProximoCandidato(pedido.tenant_id, rotaId, config.lat, config.lng, config.raio_chamada_motoboy_km, config.raio_chamada_maximo_km, candidatosExcluidos);
      if (!candidato) {
        console.log(
          `[despacho] pedido ${pedidoId} (rota ${rotaId}): sem entregador disponível (todos já tentados/ocupados ou fora do raio expandido de ${config.raio_chamada_maximo_km}km). Precisa de intervenção manual da loja.`
        );
        limparEstadoDaRota(rotaId); // achado ultrareview: sem isso, rota esgotada vazava Map pra sempre
        return;
      }

      const jaTentados = tentadosPorRota.get(rotaId) || new Set();
      jaTentados.add(candidato.id);
      tentadosPorRota.set(rotaId, jaTentados);

      const { data: tentativa, error: eTentativa } = await admin
        .from('tentativas_despacho')
        .insert({ rota_id: rotaId, entregador_id: candidato.id, distancia_km: Number.isFinite(candidato.distancia) ? candidato.distancia : null })
        .select('id')
        .single();
      if (eTentativa) {
        if (eTentativa.code === '23505') {
          // perdeu a corrida pra outro tentarDespachar concorrente que
          // pegou o MESMO entregador primeiro — exclui e tenta o próximo
          console.log(`[despacho] pedido ${pedidoId}: entregador ${candidato.id} já foi reivindicado por outra oferta concorrente — tentando próximo candidato`);
          candidatosExcluidos.add(candidato.id);
          continue;
        }
        console.error('[despacho] falha ao criar tentativa_despacho', eTentativa.message);
        return;
      }

      console.log(`[despacho] pedido ${pedidoId} -> oferecido ao entregador ${candidato.id} (tentativa ${tentativa.id})`);
      enviarPushBuzinaEntregador(candidato.push_token, candidato.push_plataforma, tentativa.id); // fire-and-forget, ver comentário na função
      agendarRepique(rotaId, candidato.push_token, candidato.push_plataforma, config.segundos_repique_notificacao, tentativa.id);
      agendarTimeout(tentativa.id, pedidoId, rotaId, config.segundos_timeout_despacho);
      return;
    }
    console.error(`[despacho] pedido ${pedidoId} (rota ${rotaId}): 10 tentativas de reivindicar candidato todas colidiram — desistindo, precisa de intervenção manual`);
  } finally {
    rotasProcessando.delete(rotaId);
  }
}

function agendarTimeout(tentativaId, pedidoId, rotaId, segundosTimeout) {
  const timer = setTimeout(async () => {
    try {
      // achado ultrareview: SELECT-depois-UPDATE não é atômico — se a
      // resposta real do entregador chegasse entre o SELECT e o UPDATE, o
      // timeout sobrescrevia 'recusado'/'aceito' de volta pra
      // 'sem_resposta'. Agora o UPDATE só afeta a linha se resultado AINDA
      // for null, e a checagem de linhas afetadas substitui o SELECT prévio.
      const { data: expirada, error } = await admin
        .from('tentativas_despacho')
        .update({ resultado: 'sem_resposta', respondido_em: new Date().toISOString() })
        .eq('id', tentativaId)
        .is('resultado', null)
        .select('id');
      if (error) {
        console.error('[despacho] erro ao expirar tentativa', tentativaId, error.message);
        return;
      }
      if (expirada && expirada.length > 0) {
        console.log(`[despacho] tentativa ${tentativaId} expirou sem resposta — tentando próximo candidato`);
        timersPorRota.delete(rotaId);
        const repique = repiquesPorRota.get(rotaId);
        if (repique) {
          clearInterval(repique);
          repiquesPorRota.delete(rotaId);
        }
        await tentarDespachar(pedidoId);
      }
      // 0 linhas afetadas: alguém respondeu de verdade bem nesse instante —
      // tratarRespostaDespacho (disparado pelo NOTIFY daquele UPDATE) cuida
      // do resto, esse timeout não tem mais nada a fazer.
    } catch (e) {
      console.error('[despacho] erro no timeout da tentativa', tentativaId, e.message);
    }
  }, segundosTimeout * 1000);
  timersPorRota.set(rotaId, timer);
}

async function tratarRespostaDespacho(tentativaId) {
  const { data: tentativa, error } = await admin.from('tentativas_despacho').select('*').eq('id', tentativaId).single();
  if (error || !tentativa || !tentativa.resultado) return;

  const timer = timersPorRota.get(tentativa.rota_id);
  if (timer) {
    clearTimeout(timer);
    timersPorRota.delete(tentativa.rota_id);
  }
  const repique = repiquesPorRota.get(tentativa.rota_id);
  if (repique) {
    clearInterval(repique);
    repiquesPorRota.delete(tentativa.rota_id);
  }

  if (tentativa.resultado === 'recusado') {
    console.log(`[despacho] entregador ${tentativa.entregador_id} recusou tentativa ${tentativaId} — tentando próximo`);
    const { data: pedidoRow } = await admin.from('pedidos').select('id').eq('rota_id', tentativa.rota_id).limit(1).single();
    if (pedidoRow) await tentarDespachar(pedidoRow.id);
    return;
  }

  if (tentativa.resultado === 'aceito') {
    // achado ultrareview: SELECT-depois-UPDATE aqui também não era atômico —
    // dois aceites concorrentes (NOTIFY duplicado, ou dois cliques) podiam
    // ambos ler entregador_id=null antes de qualquer UPDATE aplicar, e o
    // segundo UPDATE simplesmente sobrescrevia o primeiro sem erro. Agora só
    // atribui se AINDA estiver null, atomicamente, e confia na contagem de
    // linhas afetadas em vez de checar antes.
    const { data: atribuida, error: eAtribui } = await admin
      .from('rotas_entrega')
      .update({ entregador_id: tentativa.entregador_id, status: 'a_caminho_da_loja', distancia_chamada_km: tentativa.distancia_km })
      .eq('id', tentativa.rota_id)
      .is('entregador_id', null)
      .select('id');
    if (eAtribui) {
      console.error('[despacho] falha ao atribuir rota', eAtribui.message);
      return;
    }
    if (!atribuida || atribuida.length === 0) {
      console.log(`[despacho] tentativa ${tentativaId} aceita, mas rota ${tentativa.rota_id} já tinha entregador atribuído — late accept ignorado`);
      return;
    }
    // item 52: status é da pessoa agora, não do vínculo — resolve pessoa_id
    // primeiro (mesmo padrão de concluir_rota_ao_entregar() no schema).
    const { data: vinculoAtribuido } = await admin.from('entregadores').select('pessoa_id').eq('id', tentativa.entregador_id).single();
    if (vinculoAtribuido) {
      await admin.from('pessoas_entregadoras').update({ status: 'a_caminho_da_loja' }).eq('id', vinculoAtribuido.pessoa_id);
    }
    limparEstadoDaRota(tentativa.rota_id);
    console.log(`[despacho] rota ${tentativa.rota_id} atribuída ao entregador ${tentativa.entregador_id}`);
  }
  // 'sem_resposta' já foi tratado dentro do próprio setTimeout que o gerou —
  // essa notificação chega como eco de uma ação que este processo já sabia.
}

// ------------------------------------------------------------
// Reconciliação de startup: cobre o que pode ter ficado pra trás se o
// processo caiu/reiniciou (Railway redeploy, crash, etc) — timers em
// memória não sobrevivem, mas o estado real está todo no Postgres.
// ------------------------------------------------------------

// achado ultrareview: faltava reconstruir tentadosPorRota a partir do
// histórico real — sem isso, um restart no meio de um failover esquecia
// quem já tinha recusado/expirado naquela rota, e podia oferecer de novo
// pra alguém que já disse não.
async function reconstruirTentadosPorRota() {
  const { data: rotasAbertas, error } = await admin
    .from('rotas_entrega')
    .select('id, tentativas_despacho(entregador_id, resultado)')
    .eq('status', 'planejada');
  if (error) {
    console.error('[reconciliação] falha ao reconstruir histórico de failover:', error.message);
    return;
  }
  for (const rota of rotasAbertas || []) {
    const tentados = new Set(
      (rota.tentativas_despacho || []).filter((t) => t.resultado !== null).map((t) => t.entregador_id)
    );
    if (tentados.size > 0) {
      tentadosPorRota.set(rota.id, tentados);
      console.log(`[reconciliação] rota ${rota.id}: ${tentados.size} entregador(es) já tentado(s) antes do restart, excluído(s) do próximo failover`);
    }
  }
}

// achado real (teste de capacidade, item 61, 28/08/2026): 0,7% dos pedidos
// de um teste de carga sustentada ficaram 'pronto' sem NENHUMA tentativa —
// nenhum erro correspondente no log. Hipótese (consistente com o outro
// achado da mesma sessão: conexão pg direta de longa duração morre às
// vezes nesta máquina/rede): o listener de NOTIFY reconecta sozinho em
// falhas de conexão (agendarReconexao, ~5s), mas Postgres não enfileira
// NOTIFY pra sessão desconectada — um pedido que vira 'pronto' bem nessa
// janela de reconexão nunca dispara tentarDespachar, e antes desta função
// existir a única rede de segurança (a varredura abaixo) só rodava 1x, na
// subida do processo — não de novo depois de cada reconexão. Extraída pra
// reaproveitar tanto na subida quanto após reconectar e num poll periódico
// (chamadas em iniciarListener/main abaixo) — mesmo princípio defensivo já
// usado no autocorretor do repique (agendarRepique) e no expurgo.
async function despacharPedidosOrfaos() {
  const { data: pedidosPendentes, error } = await admin
    .from('pedidos')
    .select('id')
    .eq('status', 'pronto')
    .is('rota_id', null);
  if (error) {
    console.error('[reconciliação] falha ao buscar pedidos prontos sem rota:', error.message);
    return;
  }
  for (const p of pedidosPendentes || []) {
    console.log(`[reconciliação] pedido ${p.id} pronto sem rota — despachando agora`);
    await tentarDespachar(p.id);
  }
}

async function reconciliarNaSubida() {
  await reconstruirTentadosPorRota();
  await despacharPedidosOrfaos();

  const { data: tentativasAbertas } = await admin
    .from('tentativas_despacho')
    // item 52: push_token/push_plataforma moveram pra pessoas_entregadoras
    // — join encadeado via entregadores (vínculo) até a pessoa.
    .select('id, rota_id, notificado_em, entregadores(pessoas_entregadoras(push_token, push_plataforma)), rotas_entrega(tenant_id, pedidos(id))')
    .is('resultado', null);
  for (const t of tentativasAbertas || []) {
    const tenantId = t.rotas_entrega && t.rotas_entrega.tenant_id;
    if (!tenantId) continue;
    const config = await buscarConfigTenant(tenantId).catch(() => null);
    if (!config) continue;
    const expiraEm = new Date(t.notificado_em).getTime() + config.segundos_timeout_despacho * 1000;
    if (Date.now() >= expiraEm) {
      console.log(`[reconciliação] tentativa ${t.id} já devia ter expirado — forçando timeout/failover`);
      const { data: expirada } = await admin
        .from('tentativas_despacho')
        .update({ resultado: 'sem_resposta', respondido_em: new Date().toISOString() })
        .eq('id', t.id)
        .is('resultado', null)
        .select('id');
      if (expirada && expirada.length > 0) {
        const pedido = t.rotas_entrega.pedidos && t.rotas_entrega.pedidos[0];
        if (pedido) await tentarDespachar(pedido.id);
      }
    } else {
      // ainda dentro da janela — reagenda o timeout E o repique que se
      // perderam no restart (achado na revisão do repique, 25/08/2026: só
      // o timeout era reagendado aqui, então uma tentativa que sobrevivia a
      // um restart do processo parava de repicar push até expirar/resolver,
      // mesmo ainda dentro da janela). A cadência do repique reinicia a
      // partir de agora, não do instante exato em que pararia sem o
      // restart — sem histórico de "quantos repiques já rodaram" em
      // memória pra reconstruir isso com precisão, e não vale a pena
      // persistir só por causa desse caso raro (Railway redeploy).
      const pedido = t.rotas_entrega.pedidos && t.rotas_entrega.pedidos[0];
      if (pedido) {
        const restante = Math.max(1, Math.round((expiraEm - Date.now()) / 1000));
        agendarTimeout(t.id, pedido.id, t.rota_id, restante);
        const pessoaDaTentativa = t.entregadores && t.entregadores.pessoas_entregadoras;
        if (pessoaDaTentativa) {
          agendarRepique(t.rota_id, pessoaDaTentativa.push_token, pessoaDaTentativa.push_plataforma, config.segundos_repique_notificacao, t.id);
        }
      }
    }
  }
}

// ------------------------------------------------------------
// LISTEN/NOTIFY com reconexão — se a conexão cair (rede, restart do
// Supabase, etc), tenta de novo em vez de morrer em silêncio.
//
// achado ultrareview: node-postgres costuma emitir 'error' E 'end' pro
// MESMO desligamento de conexão — sem uma trava, os dois handlers
// agendavam reconexão em paralelo, e o processo acabava com dois clients
// escutando ao mesmo tempo (todo NOTIFY processado 2x, cada disconnect
// dobrando de novo). `reconectando` garante só uma reconexão agendada por
// vez.
//
// achado real (investigação do item 61, 28/08/2026, reproduzido ao vivo
// nesta máquina): uma queda de DNS/rede real (`getaddrinfo ENOTFOUND
// ...supabase.co`) durante uma tentativa de reconexão derrubava o
// processo INTEIRO — `iniciarListener()` é async e `await listener.connect()`
// pode rejeitar, mas a chamada de dentro do setTimeout de reconexão não
// tinha `.catch()`, então a rejeição virava unhandled rejection e matava o
// Node inteiro (comportamento padrão do Node moderno). Mais grave que "1
// NOTIFY perdido": explica melhor o achado do teste de capacidade (item
// 61) — se isso já tinha acontecido lá, o processo só voltou ao ar quando
// o Railway reiniciou (supervisor externo), e qualquer pedido que virasse
// 'pronto' bem nessa janela de downtime ficaria órfão exatamente como
// observado, sem log de erro correspondente (o log de antes do crash não
// menciona um pedido que só existiu depois). Corrigido envolvendo a
// chamada de reconexão em try/catch — falha ao reconectar agora agenda
// OUTRA tentativa em 5s (mesmo padrão), em vez de derrubar o processo.
// ------------------------------------------------------------
let reconectando = false;
let jaConectouAntes = false;

async function iniciarListener() {
  const listener = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const agendarReconexao = (motivo) => {
    if (reconectando) return;
    reconectando = true;
    console.warn(`[listener] ${motivo} — reconectando em 5s`);
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
  await listener.query('LISTEN pedido_pronto');
  await listener.query('LISTEN tentativa_despacho_respondida');

  // fecha a janela entre "conexão caiu" e "LISTEN religado" (ver comentário
  // em despacharPedidosOrfaos) — sem isso, só o poll periódico abaixo (main())
  // pegaria um pedido perdido nessa janela, com até 60s de atraso.
  if (jaConectouAntes) {
    despacharPedidosOrfaos().catch((e) => console.error('[reconciliação] falha na varredura pós-reconexão:', e.message));
  }
  jaConectouAntes = true;

  listener.on('notification', (msg) => {
    if (msg.channel === 'pedido_pronto') {
      tentarDespachar(msg.payload).catch((e) => console.error('[despacho] erro em tentarDespachar:', e.message));
    } else if (msg.channel === 'tentativa_despacho_respondida') {
      tratarRespostaDespacho(msg.payload).catch((e) => console.error('[despacho] erro em tratarRespostaDespacho:', e.message));
    }
  });

  console.log('[listener] conectado — escutando pedido_pronto e tentativa_despacho_respondida');
}

// Expurgo de localizacoes_entregador (26/08/2026, análise de mercado
// GiroCerto vs Mercado — item "agora" de segurança/LGPD): dado de
// geolocalização acumulava pra sempre, sem prazo de retenção — boa
// prática de mercado é ter expurgo automático definido, minimização de
// dados é exigência de LGPD, não só recomendação. 30 dias é margem
// suficiente pra qualquer investigação de desvio de rota/alerta antes de
// apagar. Roda dentro do próprio processo do dispatch-engine (já fica no
// ar 24/7) em vez de precisar de infra de cron nova — mesmo princípio já
// usado pros timers de repique/timeout por rota.
const DIAS_RETENCAO_LOCALIZACAO = 30;

async function expurgarLocalizacoesAntigas() {
  const limite = new Date(Date.now() - DIAS_RETENCAO_LOCALIZACAO * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await admin
    .from('localizacoes_entregador')
    .delete({ count: 'exact' })
    .lt('registrado_em', limite);
  if (error) {
    console.error('[expurgo] falha ao apagar localizacoes_entregador antigas:', error.message);
    return;
  }
  console.log(`[expurgo] localizacoes_entregador: ${count ?? 0} linha(s) com mais de ${DIAS_RETENCAO_LOCALIZACAO} dias apagada(s).`);
}

async function main() {
  await reconciliarNaSubida();
  await iniciarListener();

  await expurgarLocalizacoesAntigas();
  setInterval(expurgarLocalizacoesAntigas, 24 * 60 * 60 * 1000);

  // rede de segurança final (ver despacharPedidosOrfaos): cobre qualquer
  // NOTIFY perdido que a checagem pós-reconexão não pegou (ex: reconexão
  // que não passou pelos handlers 'error'/'end', ou perda sem desconexão
  // detectável). Custo de 1 SELECT vazio a cada 60s é desprezível.
  setInterval(() => {
    despacharPedidosOrfaos().catch((e) => console.error('[reconciliação] falha no poll periódico:', e.message));
  }, 60 * 1000);

  const app = express();
  app.get('/health', (req, res) => res.json({ status: 'ok', tentadosPorRota: tentadosPorRota.size, timersAtivos: timersPorRota.size }));

  // achado 24/08/2026: notificar_pedido_pronto()/notificar_resposta_despacho()
  // agora NÃO disparam pg_notify pra pedido/tentativa de tenant de teste (pra
  // não fazer o motor de PRODUÇÃO reagir a dado de teste — ver CLAUDE.md). Sem
  // NOTIFY, o próprio dispatch-engine que os testes sobem como subprocesso
  // (despacho_motor.test.js) também não seria avisado — esses 2 endpoints dão
  // aos testes um jeito de chamar a MESMA função que o listener chamaria, sem
  // depender de pg_notify (que vazaria pra produção também, já que NOTIFY é
  // broadcast pra qualquer sessão ouvindo o canal, não só quem disparou). Só
  // existem com HABILITAR_ENDPOINTS_TESTE=true — nunca setado em produção.
  if (process.env.HABILITAR_ENDPOINTS_TESTE === 'true') {
    app.use(express.json());
    app.post('/interno/despachar', async (req, res) => {
      try {
        await tentarDespachar(req.body.pedidoId);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
      }
    });
    app.post('/interno/resposta-despacho', async (req, res) => {
      try {
        await tratarRespostaDespacho(req.body.tentativaId);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
      }
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

module.exports = { tentarDespachar, tratarRespostaDespacho };
