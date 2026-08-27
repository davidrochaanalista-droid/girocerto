// Motor de despacho real (dispatch-engine/) — sessão de go-to-market,
// 15/08/2026. Diferente de despacho.test.js (que só testa o schema/RLS com
// tentativas_despacho simuladas manualmente), este arquivo SOBE o serviço de
// verdade como subprocesso e dirige um cenário real de ponta a ponta: pedido
// pronto -> LISTEN/NOTIFY -> oferta criada -> aceite via RLS (mesma escrita
// que app-entregador.html faz) -> rota atribuída -> confirmar retirada ->
// confirmar entrega -> rota concluída + entregador liberado. Também cobre
// failover por recusa, failover por timeout, e ausência de candidatos.
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { env, newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup, criarEntregador } = require('./lib/helpers');

const PORT = 3012;
const HEALTH_URL = `http://localhost:${PORT}/health`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function esperarServicoSubir(tentativas = 20) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch (e) {
      // ainda não subiu, tenta de novo
    }
    await sleep(500);
  }
  return false;
}

function subirDispatchEngine() {
  const cwd = path.join(__dirname, '..', 'dispatch-engine');
  const child = spawn('node', ['index.js'], {
    cwd,
    env: {
      ...process.env,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      DATABASE_URL: env.DATABASE_URL,
      PORT: String(PORT),
      HABILITAR_ENDPOINTS_TESTE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // acumula stdout E stderr (além de continuar espelhando no console, como
  // já fazia) — dá pros testes de repique um jeito de contar quantas vezes
  // enviarPushBuzinaEntregador() rodou, sem precisar mockar Firebase. Conta
  // as duas linhas que a função já loga: sucesso vai pro stdout
  // (console.log), falha vai pro stderr (console.error) — as duas provam
  // que a função FOI CHAMADA, que é o que importa pra medir repique. Sem
  // capturar o stderr também, um ambiente local sem credencial FCM válida
  // (ou com token de teste inválido, como este arquivo usa) faz todo push
  // cair no console.error e a contagem fica sempre zero — achado ao rodar
  // de verdade nesta sessão.
  child.logBuffer = '';
  child.stdout.on('data', (d) => {
    child.logBuffer += d.toString();
    process.stdout.write(`[dispatch-engine] ${d}`);
  });
  child.stderr.on('data', (d) => {
    child.logBuffer += d.toString();
    process.stderr.write(`[dispatch-engine:err] ${d}`);
  });
  return child;
}

function contarPushes(child) {
  return (child.logBuffer.match(/\[push\] (buzina enviada ao entregador|falha ao notificar entregador)/g) || []).length;
}

// achado 24/08/2026: o tenant deste teste agora é is_teste=true, e a trigger
// notificar_pedido_pronto()/notificar_resposta_despacho() não dispara
// pg_notify pra tenant de teste (pra não fazer o motor de PRODUÇÃO no Railway
// reagir a pedido de teste, disputando a mesma tentativa_despacho com o
// dispatch-engine que ESTE teste sobe como subprocesso — era exatamente a
// causa das falhas achadas em 24/08/2026). Sem o NOTIFY real, o subprocesso
// não seria avisado sozinho — essas 2 funções chamam os endpoints internos
// (só existem com HABILITAR_ENDPOINTS_TESTE=true) que chamam a MESMA função
// que o listener chamaria.
async function despacharDireto(pedidoId) {
  const res = await fetch(`http://localhost:${PORT}/interno/despachar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pedidoId }),
  });
  if (!res.ok) throw new Error(`despacharDireto(${pedidoId}): HTTP ${res.status}`);
}

async function responderDespachoDireto(tentativaId) {
  const res = await fetch(`http://localhost:${PORT}/interno/resposta-despacho`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tentativaId }),
  });
  if (!res.ok) throw new Error(`responderDespachoDireto(${tentativaId}): HTTP ${res.status}`);
}

async function run() {
  const r = makeReporter('despacho_motor');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];
  let child;

  try {
    console.log('\n=== Subindo dispatch-engine/ como processo real ===');
    child = subirDispatchEngine();
    const subiu = await esperarServicoSubir();
    r.check('dispatch-engine sobe e responde /health dentro de 10s', subiu);
    if (!subiu) return r.summary();

    console.log('\n=== SETUP: loja com localização + 2 entregadores dentro do raio + 1 fora ===');
    const tenantId = crypto.randomUUID();
    tenantIds.push(tenantId);
    await pg.query(`insert into tenants (id, nome, lat, lng, is_teste) values ($1,'Loja Motor Real',-23.5613,-46.6565,true)`, [tenantId]);

    const u1 = await createAuthUser('motor.perto1');
    const u2 = await createAuthUser('motor.perto2');
    const u3 = await createAuthUser('motor.longe');
    authUserIds.push(u1.id, u2.id, u3.id);

    // item 52: status/lat/lng são da PESSOA agora — entregadorXId continua sendo o
    // vínculo (FK usada por rotas_entrega/tentativas_despacho), pessoaXId é novo.
    const { pessoaId: pessoa1Id, entregadorId: entregador1Id } = await criarEntregador(pg, tenantId, u1.id, { nome: 'Perto 1', status: 'disponivel', lat: -23.5635, lng: -46.6560 });
    const { pessoaId: pessoa2Id, entregadorId: entregador2Id } = await criarEntregador(pg, tenantId, u2.id, { nome: 'Perto 2', status: 'disponivel', lat: -23.5600, lng: -46.6540 });
    await criarEntregador(pg, tenantId, u3.id, { nome: 'Longe', status: 'disponivel', lat: -23.7000, lng: -46.9000 });
    const sess1 = await signInAs(u1.email);

    console.log('\n=== Ciclo completo: pronto -> oferta -> aceite -> retirada -> entrega -> conclusão ===');

    // ACHADO ultrareview (revisão pós-fix): o teste original só conferia o
    // RESULTADO da oferta via query direta — nunca confirmava que o Realtime
    // de verdade ENTREGA o evento que dispara mostrarOferta() no client (o
    // achado #1 original era exatamente sobre um caminho que "funcionava"
    // sob teste mas quebrava na prática — mesma categoria de risco).
    // Assina o canal real ANTES de marcar o pedido como pronto, do mesmo
    // jeito que iniciarEscutaDeOfertas() faz em app-entregador.html.
    let eventoRealtimeRecebido = null;
    const canalOferta = sess1
      .channel('teste-ofertas-despacho')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'tentativas_despacho', filter: `entregador_id=eq.${entregador1Id}` },
        (payload) => { eventoRealtimeRecebido = payload.new; }
      )
      .subscribe();
    await sleep(1500); // espera a subscription estabilizar antes de disparar o evento

    const { rows: pRows } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Motor Real, 1','em_preparo',40) returning id`, [tenantId]);
    const pedidoId = pRows[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedidoId]);
    await despacharDireto(pedidoId);
    await sleep(1500); // dá tempo do Realtime (websocket) e do push fire-and-forget chegarem

    const { rows: tent1 } = await pg.query(`select * from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1)`, [pedidoId]);
    r.check('oferta real criada pro entregador mais perto (não o de fora do raio)', tent1.length === 1 && tent1[0].entregador_id === entregador1Id, tent1);
    r.check(
      'ACHADO CORRIGIDO (revisão): o INSERT da oferta chega via Realtime de verdade (WebSocket), não só existe na tabela — é o evento que dispara mostrarOferta() no client real',
      eventoRealtimeRecebido && eventoRealtimeRecebido.id === tent1[0].id,
      { eventoRealtimeRecebido, tent1_id: tent1[0] && tent1[0].id }
    );
    await sess1.removeChannel(canalOferta);

    // ACHADO ultrareview (2ª rodada): mostrarOferta() em app-entregador.html
    // lê a rota ANTES de aceitar, pra mostrar endereço/valor no modal — a RLS
    // original só liberava rotas_entrega depois que entregador_id já estava
    // preenchido (ou seja, nunca, nesse momento). Reproduz aqui a MESMA
    // query que o modal real faz.
    const { data: rotaParaModal, error: eLeituraModal } = await sess1
      .from('rotas_entrega')
      .select('*, pedidos(*)')
      .eq('id', tent1[0].rota_id)
      .single();
    r.check('ACHADO CORRIGIDO: entregador consegue ler a rota da oferta ANTES de aceitar (mesma query do modal real)', !eLeituraModal && rotaParaModal && rotaParaModal.pedidos && rotaParaModal.pedidos.length === 1, { eLeituraModal, rotaParaModal });

    const { error: eAceite } = await sess1.from('tentativas_despacho').update({ resultado: 'aceito', respondido_em: new Date().toISOString() }).eq('id', tent1[0].id);
    r.check('aceite via RLS (mesma escrita que a UI faz) é aceito', !eAceite, eAceite);
    await responderDespachoDireto(tent1[0].id);
    await sleep(500);

    const { rows: pedidoRota } = await pg.query(`select rota_id from pedidos where id = $1`, [pedidoId]);
    const rotaId = pedidoRota[0].rota_id;
    const { rows: rotaCheck1 } = await pg.query(`select status, entregador_id from rotas_entrega where id = $1`, [rotaId]);
    r.check('motor real atribuiu a rota ao entregador que aceitou', rotaCheck1[0].status === 'a_caminho_da_loja' && rotaCheck1[0].entregador_id === entregador1Id, rotaCheck1[0]);

    // ACHADO ultrareview: confirmarRetirada() agora usa a RPC atômica
    // confirmar_retirada_rota() em vez de 2 updates separados (mesma classe
    // de corrida que pausar_entregador()/retomar_entregador() evitam).
    const { error: eConfirmaRetirada } = await sess1.rpc('confirmar_retirada_rota', { p_rota_id: rotaId });
    const { rows: rotaCheck2 } = await pg.query(`select status, iniciada_em from rotas_entrega where id = $1`, [rotaId]);
    const { rows: entregadorEmRota } = await pg.query(`select status from pessoas_entregadoras where id = $1`, [pessoa1Id]);
    r.check('confirmar_retirada_rota() via RPC popula iniciada_em e status=em_rota atomicamente', !eConfirmaRetirada && rotaCheck2[0].status === 'em_entrega' && rotaCheck2[0].iniciada_em !== null && entregadorEmRota[0].status === 'em_rota', { eConfirmaRetirada, rotaCheck2: rotaCheck2[0], entregadorEmRota: entregadorEmRota[0] });

    await sess1.from('pedidos').update({ status: 'entregue', entregue_em: new Date().toISOString() }).eq('id', pedidoId);
    const { rows: rotaCheck3 } = await pg.query(`select status from rotas_entrega where id = $1`, [rotaId]);
    const { rows: entregadorCheck } = await pg.query(`select status from pessoas_entregadoras where id = $1`, [pessoa1Id]);
    r.check('rota concluída e entregador liberado ao final do ciclo real', rotaCheck3[0].status === 'concluida' && entregadorCheck[0].status === 'disponivel', { rotaCheck3, entregadorCheck });

    console.log('\n=== Failover real: recusa explícita ===');
    const { rows: pRows2 } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Motor Real, 2','em_preparo',20) returning id`, [tenantId]);
    const pedido2Id = pRows2[0].id;
    await pg.query(`update pessoas_entregadoras set status='disponivel' where id in (select pessoa_id from entregadores where tenant_id = $1)`, [tenantId]);
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedido2Id]);
    await despacharDireto(pedido2Id);
    const { rows: tent2a } = await pg.query(`select * from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1)`, [pedido2Id]);
    await sess1.from('tentativas_despacho').update({ resultado: 'recusado', respondido_em: new Date().toISOString() }).eq('id', tent2a[0].id);
    await responderDespachoDireto(tent2a[0].id);
    await sleep(500);
    const { rows: tent2b } = await pg.query(`select * from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1) order by notificado_em`, [pedido2Id]);
    r.check('recusa real aciona failover pro outro candidato dentro do raio', tent2b.length === 2 && tent2b[1].entregador_id === entregador2Id, tent2b);

    console.log('\n=== ACHADO ultrareview: entregador com oferta pendente não recebe uma 2ª oferta simultânea ===');
    // neste ponto entregador2 ainda tem a tentativa do pedido2 em aberto
    // (resultado null, ninguém respondeu) — status continua 'disponivel'
    // (só muda no aceite), mas buscarProximoCandidato agora tem que excluir
    // quem já tem QUALQUER tentativa pendente, não só nessa rota.
    const { rows: pRows3despacho } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Motor Real, 3-Dup','em_preparo',25) returning id`, [tenantId]);
    const pedido3despachoId = pRows3despacho[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedido3despachoId]);
    await despacharDireto(pedido3despachoId);
    const { rows: tent3despacho } = await pg.query(`select * from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1)`, [pedido3despachoId]);
    r.check(
      'ACHADO CORRIGIDO: nova oferta NÃO vai pro entregador que já tem tentativa pendente em outra rota (só o entregador livre)',
      tent3despacho.length === 1 && tent3despacho[0].entregador_id === entregador1Id,
      tent3despacho
    );
    // limpa o estado pendente antes de seguir pro resto do teste (via
    // service role direto — não é assertion, só arrumar a casa)
    await pg.query(`delete from tentativas_despacho where rota_id in (select rota_id from pedidos where id in ($1, $2))`, [pedido2Id, pedido3despachoId]);
    await pg.query(`update pedidos set status = 'cancelado' where id in ($1, $2)`, [pedido2Id, pedido3despachoId]);
    await pg.query(`update pessoas_entregadoras set status = 'disponivel' where id in (select pessoa_id from entregadores where tenant_id = $1)`, [tenantId]);

    console.log('\n=== Fix do achado item 10: pausar em rota não deixa o motor oferecer 2ª entrega ===');
    // simula entregador1 no meio de uma entrega (em_rota), sem usar RPC pra
    // forçar esse estado direto (o teste quer validar o comportamento a
    // partir desse estado real, não como ele foi alcançado)
    await pg.query(`update pessoas_entregadoras set status = 'em_rota', status_antes_pausa = null where id = $1`, [pessoa1Id]);

    const { error: ePausar } = await sess1.rpc('pausar_entregador');
    r.check('pausar_entregador() via RLS não dá erro', !ePausar, ePausar);
    const { rows: pausadoCheck } = await pg.query(`select status, status_antes_pausa from pessoas_entregadoras where id = $1`, [pessoa1Id]);
    r.check('pausar preserva em_rota em status_antes_pausa, status vira pausado', pausadoCheck[0].status === 'pausado' && pausadoCheck[0].status_antes_pausa === 'em_rota', pausadoCheck[0]);

    // novo pedido pronto pro mesmo tenant, enquanto entregador1 está pausado
    // (em_rota antes) e entregador2 está ocupado numa tentativa pendente de
    // outro teste — deixa só entregador1 "existir" no tenant pra esse cenário
    const { rows: pRowsPausa } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Motor Real, Pausa','em_preparo',18) returning id`, [tenantId]);
    const pedidoPausaId = pRowsPausa[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedidoPausaId]);
    await despacharDireto(pedidoPausaId);

    const { rows: tentPausa } = await pg.query(`select * from tentativas_despacho where entregador_id = $1 and rota_id = (select rota_id from pedidos where id = $2)`, [entregador1Id, pedidoPausaId]);
    r.check('motor NÃO oferece tentativa_despacho pro entregador pausado (mesmo com pedido pronto no tenant)', tentPausa.length === 0, tentPausa);

    const { error: eRetomar } = await sess1.rpc('retomar_entregador');
    r.check('retomar_entregador() via RLS não dá erro', !eRetomar);
    const { rows: retomadoCheck } = await pg.query(`select status, status_antes_pausa from pessoas_entregadoras where id = $1`, [pessoa1Id]);
    r.check('retomar volta pro status de ANTES da pausa (em_rota), não sempre disponivel, e limpa status_antes_pausa', retomadoCheck[0].status === 'em_rota' && retomadoCheck[0].status_antes_pausa === null, retomadoCheck[0]);

    // limpeza pro resto do teste não herdar esse estado
    await pg.query(`update pessoas_entregadoras set status = 'disponivel' where id = $1`, [pessoa1Id]);
    await pg.query(`delete from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1)`, [pedidoPausaId]);
    await pg.query(`delete from pedidos where id = $1`, [pedidoPausaId]);

    console.log('\n=== SETUP: tenant dedicado pra repique de push (timing agressivo, isolado do resto) ===');
    const tenantRepiqueId = crypto.randomUUID();
    tenantIds.push(tenantRepiqueId);
    await pg.query(
      `insert into tenants (id, nome, lat, lng, is_teste, segundos_repique_notificacao, segundos_timeout_despacho) values ($1,'Loja Motor Repique',-23.5613,-46.6565,true,1,8)`,
      [tenantRepiqueId]
    );
    const uR1 = await createAuthUser('motor.repique1');
    const uR2 = await createAuthUser('motor.repique2');
    authUserIds.push(uR1.id, uR2.id);
    // item 54 (Fase 2, achado desta rodada de correção da suíte): freelance
    // aceita até 3 rotas simultâneas agora — o resto deste teste depende de
    // R1 ficar indisponível pro resto do arquivo assim que aceita 1 rota e
    // nunca a finaliza (nunca finalizava antes de propósito, só pra forçar
    // as ofertas seguintes pro R2). Sem isso, R1 continuaria elegível
    // (1 rota ativa < 3 de teto freelance) e roubaria as ofertas que os
    // testes abaixo esperam que caiam no R2. R1 fixo com limite=1 restaura
    // o comportamento "ocupado = indisponível" que o resto do arquivo
    // pressupõe, sem mexer no motor de despacho.
    const { entregadorId: entregadorR1Id } = await criarEntregador(
      pg, tenantRepiqueId, uR1.id,
      { nome: 'Repique 1', status: 'disponivel', lat: -23.5635, lng: -46.6560, push_token: 'token-teste-repique-1', push_plataforma: 'android' },
      { tipo_vinculo: 'fixo', limite_rotas_simultaneas: 1 }
    );
    const { entregadorId: entregadorR2Id } = await criarEntregador(pg, tenantRepiqueId, uR2.id, {
      nome: 'Repique 2', status: 'disponivel', lat: -23.5600, lng: -46.6540, push_token: 'token-teste-repique-2', push_plataforma: 'android',
    });

    console.log('\n=== Repique real: dispara mais de uma vez enquanto a oferta está pendente ===');
    const { rows: pRowsRepique } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Repique, 1','em_preparo',30) returning id`, [tenantRepiqueId]);
    const pedidoRepiqueId = pRowsRepique[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedidoRepiqueId]);
    await despacharDireto(pedidoRepiqueId);
    await sleep(500); // dá tempo do push inicial (fire-and-forget) ser logado antes de medir a linha de base
    const pushesLogoApos = contarPushes(child);
    await sleep(4000); // com segundos_repique_notificacao=1, dá pra ver uns 4 repiques nessa janela
    const pushesDepoisDeEsperar = contarPushes(child);
    r.check(
      'repique real dispara mais de uma vez enquanto a tentativa continua pendente (não é só o push único inicial)',
      pushesDepoisDeEsperar - pushesLogoApos >= 3,
      { pushesLogoApos, pushesDepoisDeEsperar }
    );

    console.log('\n=== Repique cancela ao aceitar (não continua repicando depois de aceito) ===');
    const { rows: tentRepique } = await pg.query(`select * from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1) and resultado is null`, [pedidoRepiqueId]);
    r.check('oferta de repique foi pro entregador mais perto', tentRepique.length === 1 && tentRepique[0].entregador_id === entregadorR1Id, tentRepique);
    const sessR1 = await signInAs(uR1.email);
    await sessR1.from('tentativas_despacho').update({ resultado: 'aceito', respondido_em: new Date().toISOString() }).eq('id', tentRepique[0].id);
    await responderDespachoDireto(tentRepique[0].id);
    await sleep(500);
    const pushesLogoAposAceite = contarPushes(child);
    await sleep(3000); // 3x o intervalo de repique — se não tivesse cancelado, teria crescido de novo
    const pushesAposAceiteEspera = contarPushes(child);
    r.check(
      'repique PARA de disparar assim que a oferta é aceita (contagem de push não cresce mais depois do aceite)',
      pushesAposAceiteEspera === pushesLogoAposAceite,
      { pushesLogoAposAceite, pushesAposAceiteEspera }
    );

    console.log('\n=== Repique cancela por timeout (não continua repicando depois de expirar) ===');
    await pg.query(`update tenants set segundos_timeout_despacho = 2 where id = $1`, [tenantRepiqueId]);
    const { rows: pRowsRepiqueTimeout } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Repique, 2','em_preparo',22) returning id`, [tenantRepiqueId]);
    const pedidoRepiqueTimeoutId = pRowsRepiqueTimeout[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedidoRepiqueTimeoutId]);
    await despacharDireto(pedidoRepiqueTimeoutId);
    await sleep(3500); // > que os 2s do timeout, dá tempo do failover (sem candidato livre) limpar o estado
    const pushesLogoAposTimeout = contarPushes(child);
    await sleep(3000);
    const pushesAposTimeoutEspera = contarPushes(child);
    r.check(
      'repique PARA de disparar depois que a tentativa expira por timeout (contagem de push não cresce mais)',
      pushesAposTimeoutEspera === pushesLogoAposTimeout,
      { pushesLogoAposTimeout, pushesAposTimeoutEspera }
    );
    const { rows: tentRepiqueTimeout } = await pg.query(`select resultado from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1)`, [pedidoRepiqueTimeoutId]);
    r.check('tentativa de repique realmente expirou como sem_resposta (não ficou pendente pra sempre)', tentRepiqueTimeout.length === 1 && tentRepiqueTimeout[0].resultado === 'sem_resposta', tentRepiqueTimeout);
    await pg.query(`update tenants set segundos_timeout_despacho = 8 where id = $1`, [tenantRepiqueId]);

    console.log('\n=== Fallback de polling (client): a mesma query que app-entregador.html faz encontra a oferta pendente via RLS ===');
    // Não dá pra reproduzir "tela bloqueada degradando o WebSocket" sem um
    // dispositivo real — isso continua exigindo teste manual (mesma
    // limitação já registrada pra outros mecanismos de Realtime no
    // CLAUDE.md). O que dá pra garantir aqui é que a QUERY que
    // iniciarEscutaDeOfertas() roda no polling (tentativas_despacho onde
    // entregador_id = eu, resultado is null, mais recente primeiro) realmente
    // retorna a oferta pendente pela sessão do próprio entregador (RLS) —
    // é a parte que quebraria silenciosamente se a policy não cobrisse esse
    // caminho de leitura.
    const { rows: pRowsPolling } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Repique Polling, 1','em_preparo',28) returning id`, [tenantRepiqueId]);
    const pedidoPollingId = pRowsPolling[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedidoPollingId]);
    await despacharDireto(pedidoPollingId);
    await sleep(500);
    const sessR2 = await signInAs(uR2.email);
    const { data: pendentesPoll, error: ePoll } = await sessR2
      .from('tentativas_despacho')
      .select('*')
      .eq('entregador_id', entregadorR2Id)
      .is('resultado', null)
      .order('notificado_em', { ascending: false })
      .limit(1);
    r.check(
      'query de polling do client (mesma de iniciarEscutaDeOfertas) encontra a oferta pendente via RLS do próprio entregador',
      !ePoll && pendentesPoll && pendentesPoll.length === 1,
      { ePoll, pendentesPoll }
    );
    await sessR2.from('tentativas_despacho').update({ resultado: 'recusado', respondido_em: new Date().toISOString() }).eq('id', pendentesPoll[0].id);
    await responderDespachoDireto(pendentesPoll[0].id);
    await sleep(500);

    console.log('\n=== Reconciliação de startup: repique sobrevive a um restart no meio da janela (fix desta sessão) ===');
    await pg.query(`update tenants set segundos_timeout_despacho = 30 where id = $1`, [tenantRepiqueId]);
    const { rows: pRowsResiliente } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Repique Resiliente, 1','em_preparo',26) returning id`, [tenantRepiqueId]);
    const pedidoResilienteId = pRowsResiliente[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedidoResilienteId]);
    await despacharDireto(pedidoResilienteId);
    await sleep(500); // deixa a tentativa/push inicial se estabelecerem antes de derrubar o processo

    console.log('\n=== Reconciliação de startup: derruba e sobe de novo com pedido órfão ===');
    child.kill();
    await sleep(500);
    const { rows: pRows3 } = await pg.query(`insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Motor Real, 3','pronto',15) returning id`, [tenantId]);
    const pedido3Id = pRows3[0].id;
    await pg.query(`update pessoas_entregadoras set status='disponivel' where id in (select pessoa_id from entregadores where tenant_id = $1)`, [tenantId]);

    child = subirDispatchEngine();
    const subiu2 = await esperarServicoSubir();
    r.check('serviço sobe de novo depois de derrubado', subiu2);
    await sleep(2000);
    const { rows: pedido3Check } = await pg.query(`select rota_id from pedidos where id = $1`, [pedido3Id]);
    r.check('reconciliação de startup despacha pedido que ficou órfão com o serviço fora do ar', pedido3Check[0].rota_id !== null, pedido3Check[0]);

    const { rows: tentResilienteAntes } = await pg.query(`select resultado from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1)`, [pedidoResilienteId]);
    r.check('tentativa que sobreviveu ao restart ainda está pendente (não expirou nem foi perdida)', tentResilienteAntes.length === 1 && tentResilienteAntes[0].resultado === null, tentResilienteAntes);

    const pushesResilienteT1 = contarPushes(child);
    await sleep(2500); // com repique de 1s, dá tempo de ver o repique disparar de novo NO PROCESSO REINICIADO
    const pushesResilienteT2 = contarPushes(child);
    r.check(
      'FIX desta sessão: reconciliarNaSubida() reagenda o REPIQUE (não só o timeout) — push continua repicando na tentativa que sobreviveu ao restart',
      pushesResilienteT2 > pushesResilienteT1,
      { pushesResilienteT1, pushesResilienteT2 }
    );

    console.log('\n=== Item 36 (25/08/2026): busca expandida além do raio normal + km adicional no repasse ===');
    const tenantKmId = crypto.randomUUID();
    tenantIds.push(tenantKmId);
    await pg.query(
      `insert into tenants (id, nome, lat, lng, is_teste, raio_chamada_motoboy_km, raio_chamada_maximo_km, tarifa_minima, valor_por_km_adicional, tempo_espera_tolerado_min, valor_por_minuto_espera_excedente)
       values ($1,'Loja Km Adicional',-23.5613,-46.6565,true,1.5,5.0,10.00,2.00,999,0.50)`,
      [tenantKmId]
    );
    const uKm1 = await createAuthUser('motor.expandido');
    authUserIds.push(uKm1.id);
    // ~2,5km do tenant (fora do raio normal de 1,5km, dentro do teto de 5km)
    // item 52: tipo_vinculo é do VÍNCULO agora, status/lat/lng são da pessoa.
    // Sem turno de propósito: esse entregador já tem vínculo direto com
    // tenantKmId (1ª branch de buscar_candidatos_despacho, sem exigir turno
    // ativo) — abrir um turno aqui só o deixaria elegível pro pool freelance
    // ABERTO (2ª branch, item 52) de QUALQUER outro tenant pelo resto do
    // arquivo, o que vazou pro teste "MuitoLonge" abaixo (achado desta
    // rodada de correção da suíte).
    const { entregadorId: entregadorKmId } = await criarEntregador(
      pg, tenantKmId, uKm1.id,
      { nome: 'Expandido', status: 'disponivel', lat: -23.5388, lng: -46.6565 },
      { tipo_vinculo: 'freelance' }
    );
    const sessKm1 = await signInAs(uKm1.email);

    const { rows: pedidoKmRows } = await pg.query(
      `insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Km Adicional, 1','em_preparo',30) returning id`,
      [tenantKmId]
    );
    const pedidoKmId = pedidoKmRows[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedidoKmId]);
    await despacharDireto(pedidoKmId);
    await sleep(1000);

    const { rows: tentKm } = await pg.query(
      `select id, entregador_id, distancia_km from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1)`,
      [pedidoKmId]
    );
    r.check(
      'item 36: ninguém dentro do raio normal (1,5km) — motor busca de novo e chama o entregador a ~2,5km (dentro do teto de 5km)',
      tentKm.length === 1 && tentKm[0].entregador_id === entregadorKmId && Math.abs(Number(tentKm[0].distancia_km) - 2.502) < 0.05,
      tentKm
    );

    await sessKm1.from('tentativas_despacho').update({ resultado: 'aceito', respondido_em: new Date().toISOString() }).eq('id', tentKm[0].id);
    await responderDespachoDireto(tentKm[0].id);
    await sleep(500);

    const { rows: rotaKmCheck } = await pg.query(
      `select id, distancia_chamada_km from rotas_entrega where id = (select rota_id from pedidos where id = $1)`,
      [pedidoKmId]
    );
    const rotaKmId = rotaKmCheck[0].id;
    r.check(
      'item 36: distancia_chamada_km copiada da tentativa aceita pra rotas_entrega',
      Math.abs(Number(rotaKmCheck[0].distancia_chamada_km) - 2.502) < 0.05,
      rotaKmCheck[0]
    );

    await sessKm1.rpc('confirmar_chegada_loja', { p_rota_id: rotaKmId });
    await sessKm1.rpc('confirmar_retirada_rota', { p_rota_id: rotaKmId });
    await sessKm1.from('pedidos').update({ status: 'entregue', entregue_em: new Date().toISOString() }).eq('id', pedidoKmId);

    const { rows: repasseKm } = await pg.query(`select valor from repasses where pedido_id = $1`, [pedidoKmId]);
    // esperado: tarifa_minima (10) + km adicional ((2,502-1,5)*2,00=2,004) = 12,00 (1 pedido na rota, sem divisão)
    r.check(
      'item 36: repasse inclui km adicional pela distância de chamada além do raio normal (tarifa_minima + (distancia-raio_normal)*valor_por_km_adicional)',
      repasseKm.length === 1 && Math.abs(Number(repasseKm[0].valor) - 12.0) < 0.05,
      repasseKm
    );

    console.log('\n=== Item 36: entregador fora até do raio expandido — motor desiste (sem entregador disponível) ===');
    const tenantForaId = crypto.randomUUID();
    tenantIds.push(tenantForaId);
    await pg.query(
      `insert into tenants (id, nome, lat, lng, is_teste, raio_chamada_motoboy_km, raio_chamada_maximo_km) values ($1,'Loja Fora do Teto',-23.5613,-46.6565,true,1.5,5.0)`,
      [tenantForaId]
    );
    const uForaLonge = await createAuthUser('motor.foradoteto');
    authUserIds.push(uForaLonge.id);
    // ~11km do tenant — além até do teto expandido de 5km
    await criarEntregador(pg, tenantForaId, uForaLonge.id, { nome: 'MuitoLonge', status: 'disponivel', lat: -23.4613, lng: -46.6565 });
    const { rows: pedidoForaRows } = await pg.query(
      `insert into pedidos (tenant_id, endereco, status, valor_pedido) values ($1,'Rua Fora do Teto, 1','em_preparo',30) returning id`,
      [tenantForaId]
    );
    const pedidoForaId = pedidoForaRows[0].id;
    await pg.query(`update pedidos set status = 'pronto' where id = $1`, [pedidoForaId]);
    await despacharDireto(pedidoForaId);
    await sleep(1000);
    const { rows: tentFora } = await pg.query(
      `select id from tentativas_despacho where rota_id = (select rota_id from pedidos where id = $1)`,
      [pedidoForaId]
    );
    r.check('item 36: entregador além do raio expandido (~11km > teto de 5km) não recebe oferta', tentFora.length === 0, tentFora);

    return r.summary();
  } finally {
    if (child) child.kill();
    await cleanup(pg, tenantIds, authUserIds);
    await pg.end();
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
