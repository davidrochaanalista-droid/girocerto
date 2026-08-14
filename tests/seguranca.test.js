// Segurança: reconfirmação estática dos 3 achados do ultrareview (XSS,
// reatribuição de rota_id, UPDATE de alertas_seguranca), máquina de estados
// completa de alertas_seguranca (desvio_rota e sos_manual, até acionado_190 e
// até falso_alarme), e fluxo real de pausa/retomada de turno.
//
// ACHADO NOVO nesta rodada (não pego pelos 2 ultrareviews anteriores):
// entregadores.bloqueado_ate (bloqueio de descanso obrigatório, seção 19) não
// tem NENHUM enforcement no banco — nem CHECK constraint nem trigger. A única
// checagem existe em app-entregador.html:iniciarTurno() (client-side, "if
// (entregador.bloqueado_ate && new Date(...) > new Date())"). Um INSERT
// direto em turnos via PostgREST (fora da UI) para um entregador bloqueado
// passa sem erro nenhum — RLS só verifica entregador_id = auth.uid(), não
// bloqueado_ate. Teste abaixo prova isso.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup } = require('./lib/helpers');

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
        'escapeHtml(a.entregadores ? a.entregadores.nome',
        "escapeHtml(p.cliente_nome || 'Cliente não identificado')",
        'escapeHtml(p.endereco)',
        'escapeHtml(r.entregadores ? r.entregadores.nome',
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
    const { rows: eRows } = await pg.query(
      `insert into entregadores (tenant_id, auth_user_id, nome, status) values ($1,$2,'Entregador Seg','em_rota') returning id`,
      [tenantId, eUser.id]
    );
    const entregadorId = eRows[0].id;
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

    console.log('\n=== ACHADO NOVO: bloqueado_ate NÃO é enforced no banco (só client-side) ===');
    {
      const bloqUser = await createAuthUser('bloqueado.seguranca');
      authUserIds.push(bloqUser.id);
      const amanha = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const { rows } = await pg.query(
        `insert into entregadores (tenant_id, auth_user_id, nome, status, bloqueado_ate) values ($1,$2,'Bloqueado','offline',$3) returning id`,
        [tenantId, bloqUser.id, amanha]
      );
      const bloqEntregadorId = rows[0].id;
      const sessBloq = await signInAs(bloqUser.email);
      const { error, data } = await sessBloq.from('turnos').insert({ entregador_id: bloqEntregadorId }).select('id');
      r.check(
        'ACHADO: insert direto em turnos via RLS NÃO é bloqueado mesmo com bloqueado_ate no futuro (enforcement só existe em iniciarTurno() no app-entregador.html, bypassável por request direto ao PostgREST)',
        !error && data && data.length === 1,
        { error, data }
      );
    }

    console.log('\n=== Fluxo de pausa e retomada (corrigido no ultrareview) — teste real ===');
    {
      const pausaUser = await createAuthUser('pausa.seguranca');
      authUserIds.push(pausaUser.id);
      const { rows } = await pg.query(
        `insert into entregadores (tenant_id, auth_user_id, nome, status) values ($1,$2,'Pausa Teste','disponivel') returning id`,
        [tenantId, pausaUser.id]
      );
      const pausaEntregadorId = rows[0].id;
      const { rows: turnoRows } = await pg.query(`insert into turnos (entregador_id, status) values ($1,'ativo') returning id`, [pausaEntregadorId]);
      const turnoId = turnoRows[0].id;
      const sessPausa = await signInAs(pausaUser.email);

      // clicarPausar()
      await sessPausa.from('entregadores').update({ status: 'pausado' }).eq('id', pausaEntregadorId);
      await sessPausa.from('turnos').update({ teve_pausa: true }).eq('id', turnoId);
      const { data: pausado } = await admin.from('entregadores').select('status').eq('id', pausaEntregadorId).single();
      const { data: turnoPausado } = await admin.from('turnos').select('teve_pausa').eq('id', turnoId).single();
      r.check('pausar grava entregadores.status=pausado E turnos.teve_pausa=true', pausado.status === 'pausado' && turnoPausado.teve_pausa === true, { pausado, turnoPausado });

      // clicarContinuar()
      await sessPausa.from('entregadores').update({ status: 'disponivel' }).eq('id', pausaEntregadorId);
      const { data: retomado } = await admin.from('entregadores').select('status').eq('id', pausaEntregadorId).single();
      r.check('"Continuar" retoma entregadores.status=disponivel', retomado.status === 'disponivel', retomado);
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
