// Feira: fluxo de pedido_grupo/pedido via RLS real (feirante autenticado,
// não service role) — cobertura nova (05-06/09/2026), criada depois de um
// bug real ser encontrado num teste em escala de 100 entregadores/67
// lojas/18 feirantes: nenhum teste automatizado passava por esse fluxo
// antes disso, então o bug nunca tinha sido pego.
//
// Tabelas de feira NÃO são cobertas pelo cleanup() padrão de
// tests/lib/helpers.js (esse é escopado por tenant_id de restaurante) —
// limpeza manual aqui, mesma ordem já usada quando resíduo de teste real
// foi limpo em produção (item 71): pedido_item/pedido_nota -> pedido ->
// pedido_grupo -> feirante_participacao -> feira_ocorrencia -> feira ->
// produtos -> estabelecimentos -> auth.users.
const crypto = require('crypto');
const { newPgClient, createAuthUser, signInAs, admin, makeReporter } = require('./lib/helpers');

async function run() {
  const r = makeReporter('feira');
  const pg = newPgClient();
  await pg.connect();
  const authUserIds = [];
  const feiraNome = 'Feira Teste Automatizado ' + crypto.randomUUID().slice(0, 8);
  const bancaNome = 'Banca Teste Automatizado ' + crypto.randomUUID().slice(0, 8);

  try {
    const feiraId = crypto.randomUUID();
    await pg.query(`insert into feira (id, nome) values ($1,$2)`, [feiraId, feiraNome]);
    const { rows: [ocorrencia] } = await pg.query(
      `insert into feira_ocorrencia (feira_id, dia_semana, endereco, latitude, longitude, horario_inicio, horario_fim)
       values ($1, extract(dow from now())::int, 'Rua Teste', -23.5, -46.6, '06:00', '20:00') returning id`,
      [feiraId]
    );

    const uFeirante = await createAuthUser('feirante.testeautomatizado');
    authUserIds.push(uFeirante.id);
    const { rows: [estab] } = await pg.query(
      `insert into estabelecimentos (auth_user_id, nome, tipo_negocio, chave_pix, is_teste)
       values ($1, $2, 'feirante', 'chave-feirante-teste@teste.com', true) returning id`,
      [uFeirante.id, bancaNome]
    );
    await pg.query(
      `insert into feirante_participacao (estabelecimento_id, feira_ocorrencia_id, ativo) values ($1,$2,true)`,
      [estab.id, ocorrencia.id]
    );
    const { rows: [produto] } = await pg.query(
      `insert into produtos (estabelecimento_id, nome, preco, peso_kg) values ($1,'Tomate',5.00,1.0) returning id`,
      [estab.id]
    );

    const sessFeirante = await signInAs(uFeirante.email);

    console.log('\n=== item 89: criar_pedido_manual_feirante() via RLS ===');
    const { data: pedidoGrupoId, error: eCriar } = await sessFeirante.rpc('criar_pedido_manual_feirante', {
      p_cliente_nome: 'Cliente Teste', p_cliente_telefone: '11999998888',
      p_endereco_entrega: 'Rua do Cliente, 123', p_latitude_entrega: -23.5, p_longitude_entrega: -46.6,
      p_taxa_entrega: 5.00, p_itens: [{ produto_id: produto.id, quantidade: 2 }],
    });
    r.check('feirante cria pedido manual via RPC (RLS real)', !eCriar && pedidoGrupoId, eCriar);

    const { rows: [pedidoRow] } = await pg.query(`select id from pedido where pedido_grupo_id = $1`, [pedidoGrupoId]);
    r.check('pedido criado dentro do grupo', !!pedidoRow, pedidoRow);

    console.log('\n=== ITEM 114 (06/09/2026) — FIX: checar_liberacao_grupo() liberava só via service role, nunca via RLS real do feirante ===');
    {
      const { error: eConfirmar } = await sessFeirante
        .from('pedido')
        .update({ status_pagamento: 'confirmado', confirmado_em: new Date().toISOString() })
        .eq('id', pedidoRow.id);
      r.check('feirante confirma pagamento via RLS (update direto em pedido)', !eConfirmar, eConfirmar);

      const { rows: [grupoFinal] } = await pg.query(`select status from pedido_grupo where id = $1`, [pedidoGrupoId]);
      r.check(
        'ACHADO CORRIGIDO (item 114): pedido_grupo vira pronto_para_coleta de verdade — antes, checar_liberacao_grupo() sem SECURITY DEFINER fazia o UPDATE interno rodar com o privilégio do feirante (sem policy de UPDATE em pedido_grupo), bloqueado em silêncio pela RLS, 0 linhas afetadas, sem erro nenhum',
        grupoFinal && grupoFinal.status === 'pronto_para_coleta',
        grupoFinal
      );
    }

    console.log('\n=== cancelar_pedido_grupo_pelo_feirante() ===');
    {
      const feiraId2 = crypto.randomUUID();
      await pg.query(`insert into feira (id, nome) values ($1,$2)`, [feiraId2, feiraNome + ' 2']);
      const { rows: [ocorrencia2] } = await pg.query(
        `insert into feira_ocorrencia (feira_id, dia_semana, endereco, latitude, longitude, horario_inicio, horario_fim)
         values ($1, extract(dow from now())::int, 'Rua Teste 2', -23.5, -46.6, '06:00', '20:00') returning id`,
        [feiraId2]
      );
      await pg.query(
        `insert into feirante_participacao (estabelecimento_id, feira_ocorrencia_id, ativo) values ($1,$2,true)`,
        [estab.id, ocorrencia2.id]
      );
      const { data: pedidoGrupoId2, error: eCriar2 } = await sessFeirante.rpc('criar_pedido_manual_feirante', {
        p_cliente_nome: 'Cliente Teste 2', p_cliente_telefone: '11999997777',
        p_endereco_entrega: 'Rua do Cliente 2, 456', p_latitude_entrega: -23.5, p_longitude_entrega: -46.6,
        p_taxa_entrega: 5.00, p_itens: [{ produto_id: produto.id, quantidade: 1 }],
      });
      r.check('setup do 2º pedido pra teste de cancelamento', !eCriar2, eCriar2);

      const { error: eCancelar } = await sessFeirante.rpc('cancelar_pedido_grupo_pelo_feirante', { p_pedido_grupo_id: pedidoGrupoId2 });
      r.check('feirante cancela o próprio pedido via RPC', !eCancelar, eCancelar);

      const { rows: [grupoCancelado] } = await pg.query(`select status from pedido_grupo where id = $1`, [pedidoGrupoId2]);
      r.check('status vira cancelado', grupoCancelado.status === 'cancelado', grupoCancelado);

      const { error: eCancelarDeNovo } = await sessFeirante.rpc('cancelar_pedido_grupo_pelo_feirante', { p_pedido_grupo_id: pedidoGrupoId2 });
      r.check('cancelar 2x o mesmo pedido é rejeitado (já cancelado)', !!eCancelarDeNovo, eCancelarDeNovo);
    }

    return r.summary();
  } finally {
    await pg.query(`delete from pedido_item where pedido_id in (select id from pedido where pedido_grupo_id in (select id from pedido_grupo where feira_ocorrencia_id in (select id from feira_ocorrencia where feira_id in (select id from feira where nome like $1))))`, [feiraNome + '%']).catch(() => {});
    await pg.query(`delete from pedido_nota where pedido_id in (select id from pedido where pedido_grupo_id in (select id from pedido_grupo where feira_ocorrencia_id in (select id from feira_ocorrencia where feira_id in (select id from feira where nome like $1))))`, [feiraNome + '%']).catch(() => {});
    await pg.query(`delete from pedido where pedido_grupo_id in (select id from pedido_grupo where feira_ocorrencia_id in (select id from feira_ocorrencia where feira_id in (select id from feira where nome like $1)))`, [feiraNome + '%']).catch(() => {});
    await pg.query(`delete from pedido_grupo where feira_ocorrencia_id in (select id from feira_ocorrencia where feira_id in (select id from feira where nome like $1))`, [feiraNome + '%']).catch(() => {});
    await pg.query(`delete from feirante_participacao where feira_ocorrencia_id in (select id from feira_ocorrencia where feira_id in (select id from feira where nome like $1))`, [feiraNome + '%']).catch(() => {});
    await pg.query(`delete from feira_ocorrencia where feira_id in (select id from feira where nome like $1)`, [feiraNome + '%']).catch(() => {});
    await pg.query(`delete from feira where nome like $1`, [feiraNome + '%']).catch(() => {});
    await pg.query(`delete from produtos where estabelecimento_id in (select id from estabelecimentos where nome = $1)`, [bancaNome]).catch(() => {});
    await pg.query(`delete from estabelecimentos where nome = $1`, [bancaNome]).catch(() => {});
    for (const uid of authUserIds) {
      await admin.auth.admin.deleteUser(uid).catch(() => {});
    }
    await pg.end();
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
