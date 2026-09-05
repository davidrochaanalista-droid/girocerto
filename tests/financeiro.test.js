// Financeiro: repasses (ambos frequencia_repasse), entregador tipo_vinculo
// fixo (diária/mensal), e verificação estrutural das colunas usadas pelos
// cálculos de espera excedente e km adicional.
//
// PENDÊNCIA documentada (não testada por depender de lógica inexistente):
// nenhuma função/trigger no schema multiplica tempo_espera_min excedente por
// valor_por_minuto_espera_excedente, nem km rodado acima de km_minimo_incluso
// por valor_por_km_adicional, pra chegar num valor_entrega final. Essas são
// só colunas de configuração (tenants) e dado bruto (pedidos.tempo_espera_min)
// — o cálculo em si é responsabilidade do motor de despacho/repasse, que
// ainda não existe (README confirma: "repasse automatizado via Pix" depende
// de backend futuro). Testamos que as colunas armazenam e recuperam os
// valores corretos, não o cálculo — não existe código de cálculo pra testar.
//
// repasses não tem NENHUMA policy de INSERT client-side (só SELECT pro
// próprio entregador) — geração de repasse é 100% backend/service role,
// consistente com o padrão já visto em tentativas_contato/aprovação.
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup, criarEntregador, abrirTurno } = require('./lib/helpers');

async function run() {
  const r = makeReporter('financeiro');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const tenantId = crypto.randomUUID();
    await pg.query(
      `insert into tenants (id, nome, tempo_espera_tolerado_min, valor_por_minuto_espera_excedente, km_minimo_incluso, valor_por_km_adicional, tarifa_minima)
       values ($1,'Loja Financeiro',10,0.50,2.00,2.00,10.00)`,
      [tenantId]
    );
    tenantIds.push(tenantId);

    console.log('\n=== repasses em ambos frequencia_repasse (por_entrega, fim_de_turno) — via service role ===');
    for (const freq of ['por_entrega', 'fim_de_turno']) {
      const u = await createAuthUser(`entregador.${freq}`);
      authUserIds.push(u.id);
      const { pessoaId, entregadorId } = await criarEntregador(pg, tenantId, u.id, { nome: 'Entregador Repasse', status: 'disponivel' });
      const turnoId = await abrirTurno(pg, pessoaId, { status: 'ativo' });
      const { rows: pRows } = await pg.query(
        `insert into pedidos (tenant_id, endereco, valor_pedido, status) values ($1,'Rua Repasse',30,'entregue') returning id`,
        [tenantId]
      );
      const pedidoId = pRows[0].id;

      await pg.query(`update tenants set frequencia_repasse = $1 where id = $2`, [freq, tenantId]);

      const { error, data } = await admin.from('repasses').insert({
        entregador_id: entregadorId, pedido_id: pedidoId, turno_id: turnoId, valor: 8.00, status: 'pendente',
      }).select('id, status').single();
      r.check(`repasse criado com tenant.frequencia_repasse='${freq}' (branching real fica pro motor de repasse, não existe ainda)`, !error && data, error);

      const sess = await signInAs(u.email);
      const { data: proprio, error: eProprio } = await sess.from('repasses').select('id').eq('id', data.id);
      r.check('entregador vê o próprio repasse via RLS', !eProprio && proprio.length === 1, { eProprio, proprio });

      const { error: eInsertCliente } = await sess.from('repasses').insert({
        entregador_id: entregadorId, pedido_id: pedidoId, turno_id: turnoId, valor: 999, status: 'pendente',
      });
      r.check('entregador NÃO consegue inserir repasse via client (sem policy de insert — só backend/service role)', !!eInsertCliente, eInsertCliente);
    }

    console.log('\n=== entregador tipo_vinculo=fixo (diária e mensal) — estrutural, valor_fixo independente de entregas ===');
    for (const periodicidade of ['diaria', 'mensal']) {
      const u = await createAuthUser(`fixo.${periodicidade}`);
      authUserIds.push(u.id);
      // item 52: tipo_vinculo/valor_fixo/periodicidade_fixo são do VÍNCULO agora, não da pessoa
      const { error, data } = await (async () => {
        try {
          const { entregadorId: vinculoId } = await criarEntregador(
            pg, tenantId, u.id,
            { nome: 'Entregador Fixo', status: 'disponivel' },
            { tipo_vinculo: 'fixo', valor_fixo: 150.00, periodicidade_fixo: periodicidade }
          );
          const { rows } = await pg.query(
            'select tipo_vinculo, valor_fixo, periodicidade_fixo from entregadores where id = $1', [vinculoId]
          );
          return { data: rows[0], error: null };
        } catch (e) { return { error: e, data: null }; }
      })();
      r.check(
        `tipo_vinculo='fixo' periodicidade='${periodicidade}' com valor_fixo=150.00 salva certo (pagamento "independente de volume" é lógica de motor de repasse, não existe ainda — não testável)`,
        !error && data && data.tipo_vinculo === 'fixo' && Number(data.valor_fixo) === 150 && data.periodicidade_fixo === periodicidade,
        error || data
      );
    }

    console.log('\n=== Colunas de espera excedente e km adicional — storage correto (cálculo é pendência) ===');
    {
      const { rows } = await pg.query(`select tempo_espera_tolerado_min, valor_por_minuto_espera_excedente, km_minimo_incluso, valor_por_km_adicional from tenants where id = $1`, [tenantId]);
      const cfg = rows[0];
      r.check(
        'config de tarifação do tenant (tolerância de espera + valor/min excedente + km mínimo + valor/km adicional) armazenada e lida corretamente',
        Number(cfg.tempo_espera_tolerado_min) === 10 && Number(cfg.valor_por_minuto_espera_excedente) === 0.5 &&
        Number(cfg.km_minimo_incluso) === 2 && Number(cfg.valor_por_km_adicional) === 2,
        cfg
      );

      const { rows: pedidoRows } = await pg.query(
        `insert into pedidos (tenant_id, endereco, valor_pedido, tempo_espera_min) values ($1,'Rua Espera',20, 25) returning tempo_espera_min`,
        [tenantId]
      );
      r.check(
        'pedidos.tempo_espera_min (25min, > tolerância de 10min) grava certo — nenhuma função calcula o valor cobrado sobre o excedente, isso é pendência (não existe motor de repasse)',
        Number(pedidoRows[0].tempo_espera_min) === 25,
        pedidoRows[0]
      );
    }

    console.log('\n=== item 104 (04/09/2026): freelance multi-loja vê repasses de TODAS as lojas ===');
    {
      const tenant2Id = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome) values ($1,'Loja Financeiro 2')`, [tenant2Id]);
      tenantIds.push(tenant2Id);

      const u = await createAuthUser('freelance.multiloja');
      authUserIds.push(u.id);
      // vínculo 1: criarEntregador() já cria a pessoa + o 1º vínculo.
      const { pessoaId, entregadorId: vinculo1Id } = await criarEntregador(
        pg, tenantId, u.id, { nome: 'Freelance Multi-loja', status: 'disponivel' }, { tipo_vinculo: 'freelance' }
      );
      // vínculo 2: MESMA pessoa, loja diferente — insert direto (criarEntregador()
      // sempre cria uma pessoa nova, não serve pra "adicionar 2º vínculo").
      const { rows: [vinculo2] } = await pg.query(
        `insert into entregadores (tenant_id, pessoa_id, tipo_vinculo) values ($1,$2,'freelance') returning id`,
        [tenant2Id, pessoaId]
      );
      const vinculo2Id = vinculo2.id;

      const { rows: [pedido1] } = await pg.query(
        `insert into pedidos (tenant_id, endereco, valor_pedido, status) values ($1,'Rua Loja 1',25,'entregue') returning id`, [tenantId]
      );
      const { rows: [pedido2] } = await pg.query(
        `insert into pedidos (tenant_id, endereco, valor_pedido, status) values ($1,'Rua Loja 2',25,'entregue') returning id`, [tenant2Id]
      );

      const { error: e1 } = await admin.from('repasses').insert({
        entregador_id: vinculo1Id, pedido_id: pedido1.id, valor: 12.00, status: 'pendente',
      });
      const { error: e2 } = await admin.from('repasses').insert({
        entregador_id: vinculo2Id, pedido_id: pedido2.id, valor: 9.00, status: 'pendente',
      });
      r.check('repasses criados nas duas lojas (service role)', !e1 && !e2, { e1, e2 });

      // item 104: a query real do app (carregarSaque(), app-entregador.html)
      // não filtra mais por um entregador_id só — RLS (meus_entregador_ids())
      // já escopa pra TODOS os vínculos da mesma pessoa. Mesma query aqui.
      const sess = await signInAs(u.email);
      const { data: repassesAgregados, error: eAgregado } = await sess
        .from('repasses').select('valor, entregador_id').order('criado_em', { ascending: false });
      const totalAgregado = (repassesAgregados || []).reduce((s, x) => s + Number(x.valor), 0);
      r.check(
        'freelance vê repasses das 2 lojas na MESMA consulta (sem .eq(entregador_id) — antes só via a loja mais recente)',
        !eAgregado && repassesAgregados && repassesAgregados.length === 2 && totalAgregado === 21,
        { eAgregado, repassesAgregados, totalAgregado }
      );

      // isolamento: outro entregador não vê nada disso.
      const outro = await createAuthUser('outro.multiloja');
      authUserIds.push(outro.id);
      await criarEntregador(pg, tenantId, outro.id, { nome: 'Outro Entregador', status: 'disponivel' });
      const sessOutro = await signInAs(outro.email);
      const { data: repassesOutro } = await sessOutro.from('repasses').select('id');
      r.check('outro entregador (sem relação com os 2 vínculos) não vê nenhum desses repasses', (repassesOutro || []).length === 0, repassesOutro);
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
