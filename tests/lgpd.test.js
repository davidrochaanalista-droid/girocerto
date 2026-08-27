// LGPD: dados_anonimizados_em.
//
// PENDÊNCIA documentada: não existe NENHUMA função/trigger no schema que
// implemente a anonimização em si (nular cpf/rg_numero/endereco/fotos ao
// marcar dados_anonimizados_em). É só uma coluna timestamp — quem vai fazer
// o "apagar CPF/RG/endereço/fotos mas manter repasses/entregas íntegros" é
// um job/endpoint de um backend que ainda não existe. Simular essa lógica
// dentro do teste seria fabricar uma feature que o produto não tem — em vez
// disso, este teste PROVA que marcar dados_anonimizados_em hoje NÃO aciona
// nenhuma anonimização automática (a coluna é puramente decorativa por
// enquanto), o que é exatamente a limitação que precisa ficar documentada.
const crypto = require('crypto');
const { newPgClient, createAuthUser, makeReporter, cleanup, criarEntregador } = require('./lib/helpers');

async function run() {
  const r = makeReporter('lgpd');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja LGPD')`, [tenantId]);
    tenantIds.push(tenantId);

    const u = await createAuthUser('entregador.lgpd');
    authUserIds.push(u.id);
    // item 52: cpf/rg_numero/endereco/cnh_foto_url/dados_anonimizados_em são da PESSOA agora, não do vínculo
    const { pessoaId, entregadorId } = await criarEntregador(pg, tenantId, u.id, {
      nome: 'Entregador LGPD', status: 'offline', cpf: '12345678900', rg_numero: '98765432',
      endereco: 'Rua Original, 100', cnh_foto_url: 'https://exemplo/cnh.jpg',
    });

    console.log('\n=== Pedido de exclusão: marcar dados_anonimizados_em ===');
    {
      const { rows } = await pg.query(
        `update pessoas_entregadoras set dados_anonimizados_em = now() where id = $1 returning dados_anonimizados_em, cpf, rg_numero, endereco, cnh_foto_url`,
        [pessoaId]
      );
      const depois = rows[0];
      r.check('dados_anonimizados_em é gravado com sucesso quando marcado manualmente', depois.dados_anonimizados_em !== null, depois);
      r.check(
        'PENDÊNCIA CONFIRMADA: marcar dados_anonimizados_em NÃO aciona nenhuma anonimização automática — cpf/rg_numero/endereco/cnh_foto_url continuam intactos (não existe trigger/função que apague isso; é responsabilidade de um backend/job que ainda não existe)',
        depois.cpf === '12345678900' && depois.rg_numero === '98765432' && depois.endereco === 'Rua Original, 100' && depois.cnh_foto_url === 'https://exemplo/cnh.jpg',
        depois
      );
    }

    console.log('\n=== repasses/entregas continuam íntegros após o "pedido de exclusão" (mesmo sem anonimização real, a FK não quebra) ===');
    {
      const { rows: pRows } = await pg.query(`insert into pedidos (tenant_id, endereco, valor_pedido, status) values ($1,'Rua Pedido LGPD',20,'entregue') returning id`, [tenantId]);
      const { rows: repasseRows } = await pg.query(
        `insert into repasses (entregador_id, pedido_id, valor, status) values ($1,$2,8.00,'pago') returning id`,
        [entregadorId, pRows[0].id]
      );
      const { rows: check } = await pg.query(`select id from repasses where id = $1`, [repasseRows[0].id]);
      r.check('repasse do entregador "anonimizado" continua existindo e íntegro (FK on delete cascade não é acionada por dados_anonimizados_em, só por delete de verdade)', check.length === 1, check);
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
