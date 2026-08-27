// Segurança: reconfirmação estática dos 3 achados do ultrareview (XSS,
// reatribuição de rota_id, UPDATE de alertas_seguranca), máquina de estados
// completa de alertas_seguranca (desvio_rota e sos_manual, até acionado_190 e
// até falso_alarme), e fluxo real de pausa/retomada de turno.
//
// entregadores.bloqueado_ate (bloqueio de descanso obrigatório, seção 19):
// achado numa rodada anterior (registrado em CLAUDE.md) que não tinha NENHUM
// enforcement no banco — só client-side em app-entregador.html:iniciarTurno().
// CORRIGIDO na sessão de resolução de pendências (15/08/2026): policy
// dedicada de INSERT em turnos rejeita quando bloqueado_ate está no futuro.
// Testes abaixo cobrem o bloqueio real, que UPDATE de turno existente não é
// afetado, e que entregadores sem bloqueio (ou já expirado) continuam
// funcionando normalmente.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup, criarEntregador } = require('./lib/helpers');

function escapeHtmlRef(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function run() {
  const r = makeReporter('seguranca');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    console.log('\n=== Reconfirmação estática: XSS (escapeHtml aplicado nos 6 pontos + comportamento correto) ===');
    {
      const painelPath = path.join(__dirname, '..', 'mockups', 'painel-loja.html');
      const entregadorPath = path.join(__dirname, '..', 'mockups', 'app-entregador.html');
      const painel = fs.readFileSync(painelPath, 'utf8');
      const entregador = fs.readFileSync(entregadorPath, 'utf8');

      r.check('painel-loja.html define function escapeHtml', /function escapeHtml\(str\)/.test(painel));
      r.check('app-entregador.html define function escapeHtml', /function escapeHtml\(str\)/.test(entregador));

      const pontosPainel = [
        'escapeHtml(legendaAlerta(a))',
        'escapeHtml(a.entregadores && a.entregadores.pessoas_entregadoras ? a.entregadores.pessoas_entregadoras.nome',
        "escapeHtml(p.cliente_nome || 'Cliente não identificado')",
        'escapeHtml(p.endereco)',
        'escapeHtml(r.entregadores && r.entregadores.pessoas_entregadoras ? r.entregadores.pessoas_entregadoras.nome',
        'escapeHtml(e.nome)',
      ];
      for (const trecho of pontosPainel) {
        r.check(`painel-loja.html contém "${trecho}"`, painel.includes(trecho));
      }
      r.check('app-entregador.html: stop-addr usa escapeHtml(p.endereco)', entregador.includes('escapeHtml(p.endereco)'));
      r.check('app-entregador.html: onclick inline foi substituído por data-* (não tem mais onclick="abrirEntrega(...")', !entregador.includes('onclick="abrirEntrega('));
      r.check('app-entregador.html: usa addEventListener delegado nos botões de parada', entregador.includes("addEventListener('click'"));

      const payload = `<script>alert(1)</script>"'&`;
      const escapado = escapeHtmlRef(payload);
      r.check(
        'escapeHtml (reimplementação idêntica) neutraliza <script>, aspas e & de um payload adversarial',
        !escapado.includes('<script>') && escapado.includes('&lt;script&gt;') && escapado.includes('&quot;') && escapado.includes('&#39;') && escapado.includes('&amp;'),
        escapado
      );
    }

    const donoUser = await createAuthUser('dono.seguranca');
    authUserIds.push(donoUser.id);
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja Seguranca')`, [tenantId]);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono','dono')`, [tenantId, donoUser.id]);
    tenantIds.push(tenantId);
    const sessDono = await signInAs(donoUser.email);

    const eUser = await createAuthUser('entregador.seguranca');
    authUserIds.push(eUser.id);
    const { entregadorId } = await criarEntregador(pg, tenantId, eUser.id, { nome: 'Entregador Seg', status: 'em_rota' });
    const sessEntregador = await signInAs(eUser.email);
    const { rows: rotaRows } = await pg.query(
      `insert into rotas_entrega (tenant_id, entregador_id, status) values ($1,$2,'em_entrega') returning id`,
      [tenantId, entregadorId]
    );
    const rotaId = rotaRows[0].id;

    console.log('\n=== Reconfirmação: WITH CHECK bloqueia reatribuição de rota_id em pedidos (2ª rodada do ultrareview) ===');
    {
      const { rows: pedidoRows } = await pg.query(
        `insert into pedidos (tenant_id, endereco, status, rota_id, valor_pedido) values ($1,'Rua Reconf','a_caminho',$2,10) returning id`,
        [tenantId, rotaId]
      );
      const pedidoId = pedidoRows[0].id;
      const { rows: outraRotaRows } = await pg.query(`insert into rotas_entrega (tenant_id, status) values ($1,'planejada') returning id`, [crypto.randomUUID() && tenantId]);
      const outraRotaId = outraRotaRows[0].id;

      const { error, data } = await sessEntregador.from('pedidos').update({ status: 'entregue', rota_id: outraRotaId }).eq('id', pedidoId).select('id');
      const { data: after } = await admin.from('pedidos').select('status, rota_id').eq('id', pedidoId).single();
      r.check('reatribuição de rota_id junto com status=entregue continua bloqueada', (!data || data.length === 0) && after.rota_id === rotaId, after);

      const { error: eOk } = await sessEntregador.from('pedidos').update({ status: 'entregue' }).eq('id', pedidoId);
      const { data: afterOk } = await admin.from('pedidos').select('status').eq('id', pedidoId).single();
      r.check('confirmação legítima (sem trocar rota_id) continua funcionando', !eOk && afterOk.status === 'entregue', afterOk);
    }

    console.log('\n=== Reconfirmação: loja consegue UPDATE em alertas_seguranca (1ª rodada do ultrareview) ===');
    {
      const { rows: alertaRows } = await pg.query(
        `insert into alertas_seguranca (entregador_id, rota_id, tipo) values ($1,$2,'motoboy_parado') returning id`,
        [entregadorId, rotaId]
      );
      const { error } = await sessDono.from('alertas_seguranca').update({ status: 'confirmado_ok', resolvido_em: new Date().toISOString() }).eq('id', alertaRows[0].id);
      const { data: after } = await admin.from('alertas_seguranca').select('status').eq('id', alertaRows[0].id).single();
      r.check('loja resolve alerta do próprio entregador (fix segue funcionando)', !error && after.status === 'confirmado_ok', after);
    }

    console.log('\n=== Máquina de estados completa: desvio_rota até acionado_190 ===');
    {
      const { rows } = await pg.query(
        `insert into alertas_seguranca (entregador_id, rota_id, tipo, distancia_desvio_km) values ($1,$2,'desvio_rota', 4.2) returning id`,
        [entregadorId, rotaId]
      );
      const alertaId = rows[0].id;
      const passos = ['escalado_loja', 'acionado_190'];
      let ok = true;
      for (const status of passos) {
        const { error } = await sessDono.from('alertas_seguranca').update({ status }).eq('id', alertaId);
        if (error) ok = false;
      }
      const { data: final } = await admin.from('alertas_seguranca').select('status, tipo, distancia_desvio_km').eq('id', alertaId).single();
      r.check('desvio_rota percorre aguardando_confirmacao -> escalado_loja -> acionado_190', ok && final.status === 'acionado_190' && final.tipo === 'desvio_rota', final);
    }

    console.log('\n=== Máquina de estados completa: sos_manual até falso_alarme ===');
    {
      const { rows } = await pg.query(
        `insert into alertas_seguranca (entregador_id, rota_id, tipo) values ($1,$2,'sos_manual') returning id`,
        [entregadorId, rotaId]
      );
      const alertaId = rows[0].id;
      const { error } = await sessDono.from('alertas_seguranca').update({ status: 'falso_alarme', resolvido_em: new Date().toISOString() }).eq('id', alertaId);
      const { data: final } = await admin.from('alertas_seguranca').select('status, tipo').eq('id', alertaId).single();
      r.check('sos_manual percorre aguardando_confirmacao -> falso_alarme', !error && final.status === 'falso_alarme' && final.tipo === 'sos_manual', final);
    }

    console.log('\n=== CORRIGIDO: bloqueado_ate agora é enforced no banco, não só client-side ===');
    {
      const bloqUser = await createAuthUser('bloqueado.seguranca');
      authUserIds.push(bloqUser.id);
      const amanha = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const { pessoaId: bloqPessoaId } = await criarEntregador(pg, tenantId, bloqUser.id, { nome: 'Bloqueado', status: 'offline', bloqueado_ate: amanha });
      const sessBloq = await signInAs(bloqUser.email);
      const { error, data } = await sessBloq.from('turnos').insert({ pessoa_id: bloqPessoaId }).select('id');
      r.check(
        'insert direto em turnos via PostgREST (fora da UI) É bloqueado quando bloqueado_ate está no futuro — policy dedicada de INSERT em turnos',
        (!data || data.length === 0),
        { error, data }
      );

      // confirma que o bloqueio não vaza pra UPDATE (pausar/finalizar um turno já em
      // andamento não deveria travar por bloqueado_ate futuro, só abrir turno NOVO)
      const { rows: turnoAtivoRows } = await pg.query(
        `insert into turnos (pessoa_id, status) values ($1,'ativo') returning id`, [bloqPessoaId]
      );
      const { error: eUpdate } = await sessBloq.from('turnos').update({ status: 'finalizado', finalizado_em: new Date().toISOString() }).eq('id', turnoAtivoRows[0].id);
      const { data: checkUpdate } = await admin.from('turnos').select('status').eq('id', turnoAtivoRows[0].id).single();
      r.check(
        'UPDATE em turno já existente NÃO é bloqueado por bloqueado_ate futuro (só INSERT de turno novo deveria travar)',
        !eUpdate && checkUpdate.status === 'finalizado',
        checkUpdate
      );
    }

    console.log('\n=== Confirmação: entregador SEM bloqueio continua iniciando turno normalmente ===');
    {
      const livreUser = await createAuthUser('livre.seguranca');
      authUserIds.push(livreUser.id);
      const ontem = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      // bloqueado_ate NO PASSADO — bloqueio já expirou
      const { pessoaId: livrePessoaId } = await criarEntregador(pg, tenantId, livreUser.id, { nome: 'Livre', status: 'offline', bloqueado_ate: ontem });
      const sessLivre = await signInAs(livreUser.email);
      const { error, data } = await sessLivre.from('turnos').insert({ pessoa_id: livrePessoaId }).select('id');
      r.check('entregador com bloqueado_ate no PASSADO (bloqueio já expirado) consegue iniciar turno normalmente', !error && data && data.length === 1, { error, data });

      const semBloqueioUser = await createAuthUser('sembloqueio.seguranca');
      authUserIds.push(semBloqueioUser.id);
      // bloqueado_ate NULL
      const { pessoaId: semBloqueioPessoaId } = await criarEntregador(pg, tenantId, semBloqueioUser.id, { nome: 'Sem Bloqueio', status: 'offline' });
      const sessSemBloqueio = await signInAs(semBloqueioUser.email);
      const { error: e2, data: d2 } = await sessSemBloqueio.from('turnos').insert({ pessoa_id: semBloqueioPessoaId }).select('id');
      r.check('entregador com bloqueado_ate NULL (nunca foi bloqueado) consegue iniciar turno normalmente', !e2 && d2 && d2.length === 1, { e2, d2 });
    }

    console.log('\n=== Fluxo de pausa e retomada — via RPC real (achado ultrareview 2ª rodada) ===');
    // ACHADO: esse teste antes usava .update() direto em entregadores.status,
    // bypassando pausar_entregador()/retomar_entregador() — as RPCs que
    // clicarPausar()/clicarContinuar() realmente chamam em produção (ver
    // mockups/app-entregador.html). Passava mesmo que a RPC estivesse quebrada.
    {
      const pausaUser = await createAuthUser('pausa.seguranca');
      authUserIds.push(pausaUser.id);
      const { pessoaId: pausaPessoaId } = await criarEntregador(pg, tenantId, pausaUser.id, { nome: 'Pausa Teste', status: 'disponivel' });
      const { rows: turnoRows } = await pg.query(`insert into turnos (pessoa_id, status) values ($1,'ativo') returning id`, [pausaPessoaId]);
      const turnoId = turnoRows[0].id;
      const sessPausa = await signInAs(pausaUser.email);

      // clicarPausar() de verdade: rpc('pausar_entregador') + update de teve_pausa
      const { error: ePausar } = await sessPausa.rpc('pausar_entregador');
      await sessPausa.from('turnos').update({ teve_pausa: true }).eq('id', turnoId);
      const { data: pausado } = await admin.from('pessoas_entregadoras').select('status, status_antes_pausa').eq('id', pausaPessoaId).single();
      const { data: turnoPausado } = await admin.from('turnos').select('teve_pausa').eq('id', turnoId).single();
      r.check(
        'pausar_entregador() via RLS grava status=pausado, status_antes_pausa=disponivel (estado anterior), E turnos.teve_pausa=true',
        !ePausar && pausado.status === 'pausado' && pausado.status_antes_pausa === 'disponivel' && turnoPausado.teve_pausa === true,
        { ePausar, pausado, turnoPausado }
      );

      // clicarContinuar() de verdade: rpc('retomar_entregador')
      const { error: eRetomar } = await sessPausa.rpc('retomar_entregador');
      const { data: retomado } = await admin.from('pessoas_entregadoras').select('status, status_antes_pausa').eq('id', pausaPessoaId).single();
      r.check('retomar_entregador() volta status=disponivel (era esse antes) e limpa status_antes_pausa', !eRetomar && retomado.status === 'disponivel' && retomado.status_antes_pausa === null, { eRetomar, retomado });

      // cenário do achado original: pausar em em_rota (não disponivel) deve
      // preservar em_rota, não sempre disponivel
      await pg.query(`update pessoas_entregadoras set status = 'em_rota' where id = $1`, [pausaPessoaId]);
      await sessPausa.rpc('pausar_entregador');
      await sessPausa.rpc('retomar_entregador');
      const { data: retomadoEmRota } = await admin.from('pessoas_entregadoras').select('status').eq('id', pausaPessoaId).single();
      r.check('pausar/retomar em em_rota preserva em_rota (não reseta pra disponivel)', retomadoEmRota.status === 'em_rota', retomadoEmRota);
    }

    console.log('\n=== bloqueado_ate: os 2 bypasses achados no ultrareview agora são bloqueados ===');
    {
      const bypassUser = await createAuthUser('bypass.bloqueio');
      authUserIds.push(bypassUser.id);
      const futuro = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
      const { pessoaId: bypassPessoaId } = await criarEntregador(pg, tenantId, bypassUser.id, { nome: 'Bypass Teste', status: 'offline', bloqueado_ate: futuro });
      const sessBypass = await signInAs(bypassUser.email);

      // achado #1: limpar o próprio bloqueado_ate via update direto
      await sessBypass.from('pessoas_entregadoras').update({ bloqueado_ate: null }).eq('id', bypassPessoaId);
      const { rows: checkBypass1 } = await pg.query(`select bloqueado_ate from pessoas_entregadoras where id = $1`, [bypassPessoaId]);
      r.check('ACHADO CORRIGIDO: entregador NÃO consegue limpar o próprio bloqueado_ate via update direto (trigger reverte)', checkBypass1[0].bloqueado_ate !== null, checkBypass1[0]);

      // achado #2: reviver um turno finalizado pra 'ativo' via update direto
      const { rows: tRows } = await pg.query(
        `insert into turnos (pessoa_id, status, finalizado_em) values ($1,'finalizado', now()) returning id`,
        [bypassPessoaId]
      );
      const { error: eReativa } = await sessBypass.from('turnos').update({ status: 'ativo' }).eq('id', tRows[0].id);
      const { rows: checkBypass2 } = await pg.query(`select status from turnos where id = $1`, [tRows[0].id]);
      r.check('ACHADO CORRIGIDO: entregador bloqueado NÃO consegue reviver turno finalizado pra ativo via update direto', !!eReativa && checkBypass2[0].status === 'finalizado', { eReativa: eReativa && eReativa.message, checkBypass2: checkBypass2[0] });

      // confirma que o trigger não atrapalha updates legítimos de OUTROS campos
      const { error: eLegitimo } = await sessBypass.from('pessoas_entregadoras').update({ lat: -23.5, lng: -46.6 }).eq('id', bypassPessoaId);
      const { rows: checkLegitimo } = await pg.query(`select lat, lng, bloqueado_ate from pessoas_entregadoras where id = $1`, [bypassPessoaId]);
      r.check('update de campo NÃO relacionado (lat/lng) continua funcionando normalmente mesmo bloqueado', !eLegitimo && checkLegitimo[0].lat === -23.5 && checkLegitimo[0].bloqueado_ate !== null, checkLegitimo[0]);
    }

    console.log('\n=== config_fadiga_do_meu_tenant() — achado da revisão do ultrareview: RPC nunca era testada via .rpc() ===');
    // achado (auditoria de "caminho errado" pedida depois do achado #1 da 2ª
    // rodada de ultrareview): essa RPC é chamada por app-entregador.html
    // (carregarEntregador()) mas nunca tinha sido exercitada via .rpc() em
    // lugar nenhum da suíte. Usa valores DE PROPÓSITO diferentes do fallback
    // hardcoded do client (8.0/8.0) — se a RPC quebrasse e o client caísse
    // silenciosamente no fallback, um teste com valores default (8/8) não
    // pegaria a diferença.
    {
      const fadigaTenantId = crypto.randomUUID();
      tenantIds.push(fadigaTenantId);
      await pg.query(
        `insert into tenants (id, nome, horas_alerta_fadiga, horas_descanso_obrigatorio) values ($1,'Loja Fadiga Custom',5.5,10.0)`,
        [fadigaTenantId]
      );
      const fadigaUser = await createAuthUser('fadiga.rpc');
      authUserIds.push(fadigaUser.id);
      await criarEntregador(pg, fadigaTenantId, fadigaUser.id, { nome: 'Entregador Fadiga', status: 'disponivel' });
      const sessFadiga = await signInAs(fadigaUser.email);
      const { data: fadiga, error: eFadiga } = await sessFadiga.rpc('config_fadiga_do_meu_tenant');
      r.check(
        'config_fadiga_do_meu_tenant() via RLS devolve os valores REAIS do tenant (5.5/10.0), não o fallback hardcoded do client (8/8)',
        !eFadiga && fadiga && fadiga[0] && Number(fadiga[0].horas_alerta_fadiga) === 5.5 && Number(fadiga[0].horas_descanso_obrigatorio) === 10.0,
        { eFadiga, fadiga }
      );
    }

    return r.summary();
  } finally {
    await cleanup(pg, tenantIds, authUserIds);
    await pg.end();
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
