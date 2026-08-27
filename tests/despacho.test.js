// Despacho e rotas: tentativas_despacho (3 resultados), rota com múltiplos
// pedidos/ordem_na_rota, todos os status de rotas_entrega, retry de
// codigo_retirada sob concorrência real (reconfirmação pós-ultrareview).
//
// PENDÊNCIA documentada: o FAILOVER AUTOMÁTICO completo (chamar entregador 1,
// timeout/recusa, chamar o próximo disponível, até esgotar) não existe como
// código em lugar nenhum — não há trigger nem função no schema que orquestre
// isso, é responsabilidade do "motor de despacho automático" citado no
// README como dependência de um backend que ainda não foi construído. O que
// testamos aqui é a mecânica da tabela (aceita os 3 resultados, RLS de
// leitura/escrita corretas) simulando manualmente a sequência de tentativas
// que o motor faria — não é o motor rodando de verdade.
//
// Também: rotas_entrega não tem NENHUMA policy de INSERT nem UPDATE pra loja
// (só SELECT) — criação/edição de rota é 100% via service role hoje,
// consistente com "não existe fluxo de criação de rota em nenhum mockup
// ainda" (CLAUDE.md). Não é um bug novo, é o mesmo estado documentado.
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup, criarEntregador } = require('./lib/helpers');

async function run() {
  const r = makeReporter('despacho');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const donoUser = await createAuthUser('dono.despacho');
    authUserIds.push(donoUser.id);
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja Despacho')`, [tenantId]);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono','dono')`, [tenantId, donoUser.id]);
    tenantIds.push(tenantId);
    const sessDono = await signInAs(donoUser.email);

    const entregadores = [];
    for (const nome of ['E1', 'E2', 'E3']) {
      const u = await createAuthUser(`${nome.toLowerCase()}.despacho`);
      authUserIds.push(u.id);
      const { entregadorId } = await criarEntregador(pg, tenantId, u.id, { nome, status: 'disponivel' });
      entregadores.push({ nome, id: entregadorId, authId: u.id, email: u.email });
    }

    console.log('\n=== tentativas_despacho: failover simulado (recusado -> sem_resposta -> aceito) ===');
    {
      const { rows: rotaRows } = await pg.query(
        `insert into rotas_entrega (tenant_id, status) values ($1,'planejada') returning id`, [tenantId]
      );
      const rotaId = rotaRows[0].id;

      const sequencia = [
        { entregador: entregadores[0], resultado: 'recusado' },
        { entregador: entregadores[1], resultado: 'sem_resposta' },
        { entregador: entregadores[2], resultado: 'aceito' },
      ];
      let todasOk = true;
      for (const passo of sequencia) {
        const { error } = await admin.from('tentativas_despacho').insert({
          rota_id: rotaId, entregador_id: passo.entregador.id, resultado: passo.resultado,
          respondido_em: new Date().toISOString(),
        });
        if (error) todasOk = false;
      }
      r.check('tentativas_despacho aceita os 3 resultados (recusado, sem_resposta, aceito) simulando failover manual', todasOk);

      const { data: vistoLoja, error: eLoja } = await sessDono.from('tentativas_despacho').select('id, resultado').eq('rota_id', rotaId);
      r.check('loja vê as 3 tentativas de despacho da própria rota', !eLoja && vistoLoja.length === 3, { eLoja, count: vistoLoja && vistoLoja.length });

      const sessE1 = await signInAs(entregadores[0].email);
      const { data: vistoE1 } = await sessE1.from('tentativas_despacho').select('id').eq('rota_id', rotaId);
      r.check('entregador só vê a PRÓPRIA tentativa de despacho, não as dos outros', vistoE1 && vistoE1.length === 1, vistoE1);

      // entregador consegue responder (update) a própria tentativa via RLS "for all"
      const { error: eResp } = await sessE1.from('tentativas_despacho')
        .update({ resultado: 'recusado', respondido_em: new Date().toISOString() })
        .eq('id', vistoE1[0].id);
      r.check('entregador consegue responder (UPDATE) a própria tentativa via RLS', !eResp, eResp);
    }

    console.log('\n=== Rota com múltiplos pedidos e ordem_na_rota variando ===');
    {
      const { rows: rotaRows } = await pg.query(
        `insert into rotas_entrega (tenant_id, entregador_id, status) values ($1,$2,'a_caminho_da_loja') returning id`,
        [tenantId, entregadores[2].id]
      );
      const rotaId = rotaRows[0].id;
      const ids = [];
      for (let i = 1; i <= 4; i++) {
        const { data } = await sessDono.from('pedidos').insert({
          tenant_id: tenantId, endereco: `Parada ${i}`, valor_pedido: 10 + i, rota_id: rotaId, ordem_na_rota: i,
        }).select('id, ordem_na_rota').single();
        ids.push(data);
      }
      const ordens = ids.map((p) => p.ordem_na_rota).sort((a, b) => a - b);
      r.check('4 pedidos numa rota com ordem_na_rota 1..4 salvos corretamente', JSON.stringify(ordens) === JSON.stringify([1, 2, 3, 4]), ordens);
    }

    console.log('\n=== Todos os valores de rotas_entrega.status, incluindo cancelada ===');
    {
      for (const status of ['planejada', 'a_caminho_da_loja', 'em_entrega', 'concluida', 'cancelada']) {
        const { error } = await pg.query(
          `insert into rotas_entrega (tenant_id, entregador_id, status) values ($1,$2,$3)`,
          [tenantId, entregadores[0].id, status]
        ).then(() => ({ error: null })).catch((e) => ({ error: e }));
        r.check(`rotas_entrega.status='${status}' aceito pelo CHECK constraint`, !error, error && error.message);
      }
    }

    console.log('\n=== codigo_retirada sob concorrência real (reconfirmação pós-ultrareview) ===');
    {
      const jobs = [];
      for (let i = 0; i < 20; i++) {
        jobs.push(pg.query(`insert into rotas_entrega (tenant_id, entregador_id, status) values ($1,$2,'planejada') returning codigo_retirada`, [tenantId, entregadores[i % 3].id]));
      }
      const results = await Promise.allSettled(jobs);
      const codigos = results.filter((x) => x.status === 'fulfilled').map((x) => x.value.rows[0].codigo_retirada);
      const distintos = new Set(codigos);
      r.check(`20 rotas concorrentes criadas sem colisão de codigo_retirada (${codigos.length} códigos, todos distintos)`, codigos.length === distintos.size && codigos.length === 20, { codigos: codigos.length, distintos: distintos.size });
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
