// Avaliações e reputação: view selo_entrega_justa nos limites exatos (9 vs
// 10 avaliações no total_avaliacoes_30d, nota 3.9 vs 4.0 na média).
//
// ACHADO NOVO nesta rodada (não pego pelos ultrareviews anteriores, porque os
// testes de selo_entrega_justa da sessão original rodaram via conexão
// postgres/service role — que ignora RLS — não via sessão autenticada real de
// loja): a hipótese inicial era "avaliacoes_loja não tem policy de SELECT,
// então a view quebra pra loja" — TESTADO E REFUTADO: a view na verdade
// FUNCIONA para a loja, só que funciona demais. `create or replace view
// selo_entrega_justa` não declara `security_invoker = true` (padrão do
// Postgres 15+/Supabase é `false`), então a view roda com o privilégio de
// quem a CRIOU (o superusuário usado pra aplicar o schema, que tem BYPASSRLS)
// em vez do privilégio de quem consulta — o LEFT JOIN com avaliacoes_loja
// nunca é filtrado por RLS nenhuma. Resultado real, confirmado por teste:
// QUALQUER dono autenticado, de QUALQUER tenant, consegue consultar o selo
// (nome da loja, oferece_banheiro/abrigo_chuva, média, contagem, selo_ativo)
// de QUALQUER OUTRO tenant, só passando o tenant_id — e sem filtro nenhum, a
// view devolve todas as linhas da tabela `tenants` de uma vez. Não é dado
// supersensível (sem PII, sem financeiro — só nome da loja + agregado de
// nota), o que pode até ser intencional (um "selo" público faz sentido como
// vitrine, tipo emblema de confiança visível). Mas não há NADA no schema/
// README que declare essa exposição como intencional — é uma decisão de
// produto em aberto, não uma correção óbvia. Documentado como achado real,
// não corrigido nesta rodada (ver tests/COBERTURA.md).
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup } = require('./lib/helpers');

async function popularAvaliacoes(pg, tenantId, entregadorId, quantidade, nota) {
  for (let i = 0; i < quantidade; i++) {
    await pg.query(
      `insert into avaliacoes_loja (tenant_id, entregador_id, nota, criado_em) values ($1,$2,$3, now() - interval '1 day')`,
      [tenantId, entregadorId, nota]
    );
  }
}

async function run() {
  const r = makeReporter('reputacao');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    console.log('\n=== Borda de volume: 9 vs 10 avaliações (nota 5, infraestrutura completa) ===');
    {
      const tenant9 = crypto.randomUUID();
      const tenant10 = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome, oferece_banheiro, oferece_abrigo_chuva) values ($1,'Loja 9 Avaliações',true,true)`, [tenant9]);
      await pg.query(`insert into tenants (id, nome, oferece_banheiro, oferece_abrigo_chuva) values ($1,'Loja 10 Avaliações',true,true)`, [tenant10]);
      tenantIds.push(tenant9, tenant10);

      const u9 = await createAuthUser('entregador.9aval');
      const u10 = await createAuthUser('entregador.10aval');
      authUserIds.push(u9.id, u10.id);
      const { rows: e9 } = await pg.query(`insert into entregadores (tenant_id, auth_user_id, nome, status) values ($1,$2,'E9','disponivel') returning id`, [tenant9, u9.id]);
      const { rows: e10 } = await pg.query(`insert into entregadores (tenant_id, auth_user_id, nome, status) values ($1,$2,'E10','disponivel') returning id`, [tenant10, u10.id]);

      await popularAvaliacoes(pg, tenant9, e9[0].id, 9, 5);
      await popularAvaliacoes(pg, tenant10, e10[0].id, 10, 5);

      const { rows: selo9 } = await pg.query(`select * from selo_entrega_justa where tenant_id = $1`, [tenant9]);
      const { rows: selo10 } = await pg.query(`select * from selo_entrega_justa where tenant_id = $1`, [tenant10]);

      // count(*) via pg volta como bigint, o driver `pg` devolve string — Number() antes de comparar.
      r.check('9 avaliações (nota 5) NÃO ativa o selo (falta volume mínimo de 10)', selo9[0] && Number(selo9[0].total_avaliacoes_30d) === 9 && selo9[0].selo_ativo === false, selo9[0]);
      r.check('10 avaliações (nota 5) ATIVA o selo (bate o volume mínimo)', selo10[0] && Number(selo10[0].total_avaliacoes_30d) === 10 && selo10[0].selo_ativo === true, selo10[0]);
    }

    console.log('\n=== Borda de média: nota 3.9 vs 4.0, com 10 avaliações cada ===');
    {
      const tenantBaixa = crypto.randomUUID();
      const tenantAlta = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome, oferece_banheiro, oferece_abrigo_chuva) values ($1,'Loja Media 3.9',true,true)`, [tenantBaixa]);
      await pg.query(`insert into tenants (id, nome, oferece_banheiro, oferece_abrigo_chuva) values ($1,'Loja Media 4.0',true,true)`, [tenantAlta]);
      tenantIds.push(tenantBaixa, tenantAlta);

      const uB = await createAuthUser('entregador.media39');
      const uA = await createAuthUser('entregador.media40');
      authUserIds.push(uB.id, uA.id);
      const { rows: eB } = await pg.query(`insert into entregadores (tenant_id, auth_user_id, nome, status) values ($1,$2,'EB','disponivel') returning id`, [tenantBaixa, uB.id]);
      const { rows: eA } = await pg.query(`insert into entregadores (tenant_id, auth_user_id, nome, status) values ($1,$2,'EA','disponivel') returning id`, [tenantAlta, uA.id]);

      // 9 notas 4 + 1 nota 3 = média 3.9 (39/10)
      await popularAvaliacoes(pg, tenantBaixa, eB[0].id, 9, 4);
      await popularAvaliacoes(pg, tenantBaixa, eB[0].id, 1, 3);
      // 10 notas 4 = média exatamente 4.0
      await popularAvaliacoes(pg, tenantAlta, eA[0].id, 10, 4);

      const { rows: seloBaixa } = await pg.query(`select * from selo_entrega_justa where tenant_id = $1`, [tenantBaixa]);
      const { rows: seloAlta } = await pg.query(`select * from selo_entrega_justa where tenant_id = $1`, [tenantAlta]);

      r.check('média 3.90 (abaixo de 4.0) NÃO ativa o selo', seloBaixa[0] && Number(seloBaixa[0].media_avaliacao_motoboys) === 3.9 && seloBaixa[0].selo_ativo === false, seloBaixa[0]);
      r.check('média exatamente 4.00 ATIVA o selo (limite inclusivo, >=4.0)', seloAlta[0] && Number(seloAlta[0].media_avaliacao_motoboys) === 4 && seloAlta[0].selo_ativo === true, seloAlta[0]);
    }

    console.log('\n=== ACHADO NOVO (corrigido após rodar de verdade): selo_entrega_justa não escopa por tenant sob RLS ===');
    {
      const tenantId = crypto.randomUUID();
      const tenantAlheio = crypto.randomUUID();
      const donoUser = await createAuthUser('dono.selo');
      const donoAlheioUser = await createAuthUser('dono.selo.alheio');
      authUserIds.push(donoUser.id, donoAlheioUser.id);
      await pg.query(`insert into tenants (id, nome, oferece_banheiro, oferece_abrigo_chuva) values ($1,'Loja Selo RLS',true,true)`, [tenantId]);
      await pg.query(`insert into tenants (id, nome) values ($1, 'Loja De Outro Dono (Selo)')`, [tenantAlheio]);
      await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono','dono')`, [tenantId, donoUser.id]);
      await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Outro Dono','dono')`, [tenantAlheio, donoAlheioUser.id]);
      tenantIds.push(tenantId, tenantAlheio);

      const entregadorUser = await createAuthUser('entregador.selo');
      authUserIds.push(entregadorUser.id);
      const { rows: eRows } = await pg.query(`insert into entregadores (tenant_id, auth_user_id, nome, status) values ($1,$2,'Entregador Selo','disponivel') returning id`, [tenantId, entregadorUser.id]);
      const entregadorId = eRows[0].id;
      const sessEntregador = await signInAs(entregadorUser.email);

      // confirma que o INSERT via RLS do entregador funciona (a policy que existe está OK)
      let insertsOk = 0;
      for (let i = 0; i < 10; i++) {
        const { error } = await sessEntregador.from('avaliacoes_loja').insert({ tenant_id: tenantId, entregador_id: entregadorId, nota: 5 });
        if (!error) insertsOk++;
      }
      r.check('entregador consegue inserir 10 avaliações via RLS (policy de insert existe e funciona)', insertsOk === 10, insertsOk);

      const { rows: seloServiceRole } = await pg.query(`select * from selo_entrega_justa where tenant_id = $1`, [tenantId]);
      r.check('via conexão postgres/service role: 10 avaliações nota 5 -> selo ativo, como esperado', seloServiceRole[0] && seloServiceRole[0].selo_ativo === true && Number(seloServiceRole[0].total_avaliacoes_30d) === 10, seloServiceRole[0]);

      // hipótese original ("loja não consegue nem ver o próprio selo") foi TESTADA e REFUTADA — a view
      // funciona pro dono do próprio tenant. O achado real é o oposto: funciona pra QUALQUER dono, de
      // QUALQUER tenant, não só o seu — porque a view não declara security_invoker=true (Postgres 15+),
      // então roda com o privilégio de quem criou a view (bypassa RLS), não de quem consulta.
      const sessDono = await signInAs(donoUser.email);
      const { data: seloProprio, error: eSeloProprio } = await sessDono.from('selo_entrega_justa').select('*').eq('tenant_id', tenantId).single();
      r.check(
        'dono vê o selo do PRÓPRIO tenant corretamente (10 avaliações, ativo)',
        !eSeloProprio && seloProprio && Number(seloProprio.total_avaliacoes_30d) === 10 && seloProprio.selo_ativo === true,
        { eSeloProprio, seloProprio }
      );

      const sessDonoAlheio = await signInAs(donoAlheioUser.email);
      const { data: seloAlheio, error: eSeloAlheio } = await sessDonoAlheio.from('selo_entrega_justa').select('*').eq('tenant_id', tenantId).single();
      r.check(
        'ACHADO: dono de OUTRO tenant também vê o selo completo deste tenant (view não escopa por RLS — bypassa via privilégio do dono da view)',
        !eSeloAlheio && seloAlheio && Number(seloAlheio.total_avaliacoes_30d) === 10 && seloAlheio.selo_ativo === true,
        { eSeloAlheio, seloAlheio }
      );

      const { data: leituraDireta, error: eDireta } = await sessDonoAlheio.from('avaliacoes_loja').select('id').eq('tenant_id', tenantId);
      r.check(
        'em contraste: avaliacoes_loja (tabela base) SEM policy de SELECT continua corretamente invisível direto — o vazamento é só através da view, não da tabela',
        !eDireta && leituraDireta && leituraDireta.length === 0,
        { eDireta, count: leituraDireta && leituraDireta.length }
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
