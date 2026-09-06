// Repasse automático de Pix (itens 109-116) — confirmação de chave,
// seleção de quem pagar (freelance por entrega + fixo por periodicidade
// individual), e as travas de segurança: sem chave+tipo confirmados não
// entra no lote; tentativa recente (10min) não é reprocessada; RPCs de
// motor são bloqueadas pra qualquer client.
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, criarEntregador, cleanup } = require('./lib/helpers');

async function run() {
  const r = { pass: 0, fail: 0, failures: [], area: 'repasses_automaticos' };
  function check(label, cond, extra) {
    if (cond) { r.pass++; console.log('  PASS -', label); }
    else { r.fail++; r.failures.push(label); console.log('  FAIL -', label, JSON.stringify(extra)); }
  }

  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja Teste Repasses Automaticos')`, [tenantId]);
    tenantIds.push(tenantId);

    console.log('\n=== confirmação de chave Pix: sem tipo, RPC rejeita ===');
    {
      const u = await createAuthUser('semtipo.repasses');
      authUserIds.push(u.id);
      await criarEntregador(pg, tenantId, u.id, { nome: 'Sem Tipo', status: 'disponivel' }, { tipo_vinculo: 'freelance' });
      const sess = await signInAs(u.email);
      const { error: eTipoInvalido } = await sess.rpc('confirmar_chave_pix', { p_nova_chave: 'x@teste.com', p_tipo: 'bitcoin' });
      check('tipo inválido é rejeitado pela RPC', !!eTipoInvalido, eTipoInvalido);
      const { error: eSemTipo } = await sess.rpc('confirmar_chave_pix', { p_nova_chave: 'x@teste.com' });
      check('confirmar sem tipo funciona (mantém tipo anterior, null na 1ª vez)', !eSemTipo, eSemTipo);
      const { rows } = await pg.query(`select chave_pix_tipo from pessoas_entregadoras where auth_user_id = $1`, [u.id]);
      check('sem tipo informado, chave_pix_tipo continua null', rows[0].chave_pix_tipo === null, rows[0]);
    }

    console.log('\n=== freelance: só entra na seleção com chave E TIPO confirmados (item 116) ===');
    {
      const u = await createAuthUser('freelance.repasses');
      authUserIds.push(u.id);
      const { pessoaId, entregadorId } = await criarEntregador(pg, tenantId, u.id, { nome: 'Freelance Repasses', status: 'disponivel' }, { tipo_vinculo: 'freelance' });
      const { rows: [pedido] } = await pg.query(
        `insert into pedidos (tenant_id, endereco, valor_pedido, status) values ($1,'Rua Repasses',30,'entregue') returning id`, [tenantId]
      );
      await admin.from('repasses').insert({ entregador_id: entregadorId, pedido_id: pedido.id, valor: 15.00, status: 'pendente' });

      const sess = await signInAs(u.email);
      const { data: antesConfirmar } = await pg.query(`select * from repasses_freelance_prontos_para_pagar() where pessoa_id = $1`, [pessoaId]).then(x => ({ data: x.rows }));
      check('sem confirmar nada, não aparece na seleção', antesConfirmar.length === 0, antesConfirmar);

      await pg.query(`update pessoas_entregadoras set chave_pix = 'freelance@teste.com', chave_pix_confirmada_em = now() where id = $1`, [pessoaId]);
      const { rows: apenasChaveConfirmada } = await pg.query(`select * from repasses_freelance_prontos_para_pagar() where pessoa_id = $1`, [pessoaId]);
      check('achado do item 116: chave confirmada MAS sem tipo declarado ainda NÃO entra na seleção', apenasChaveConfirmada.length === 0, apenasChaveConfirmada);

      const { error: eConfirmarComTipo } = await sess.rpc('confirmar_chave_pix', { p_nova_chave: 'freelance@teste.com', p_tipo: 'email' });
      check('confirmar com tipo funciona', !eConfirmarComTipo, eConfirmarComTipo);
      const { rows: comTipo } = await pg.query(`select chave_pix, chave_pix_tipo, valor_total, repasse_ids from repasses_freelance_prontos_para_pagar() where pessoa_id = $1`, [pessoaId]);
      check('com chave+tipo confirmados, entra na seleção com o tipo certo', comTipo.length === 1 && comTipo[0].chave_pix_tipo === 'email' && Number(comTipo[0].valor_total) === 15, comTipo);

      console.log('\n  --- trava de tentativa recente (10min), item 116 ---');
      await pg.query(`select marcar_tentativa_repasses($1)`, [comTipo[0].repasse_ids]);
      const { rows: aposTentativa } = await pg.query(`select * from repasses_freelance_prontos_para_pagar() where pessoa_id = $1`, [pessoaId]);
      check('logo após marcar tentativa, some da seleção por 10min (evita reenvio duplicado)', aposTentativa.length === 0, aposTentativa);

      await pg.query(`update repasses set tentativa_transferencia_em = now() - interval '11 minutes' where id = any($1)`, [comTipo[0].repasse_ids]);
      const { rows: aposJanela } = await pg.query(`select * from repasses_freelance_prontos_para_pagar() where pessoa_id = $1`, [pessoaId]);
      check('depois de passar os 10min, volta a aparecer na seleção', aposJanela.length === 1, aposJanela);

      await pg.query(`select marcar_repasses_pagos($1, 'TESTE-TXID')`, [comTipo[0].repasse_ids]);
      const { rows: aposPago } = await pg.query(`select * from repasses_freelance_prontos_para_pagar() where pessoa_id = $1`, [pessoaId]);
      check('depois de pago, nunca mais aparece na seleção (idempotência real)', aposPago.length === 0, aposPago);
    }

    console.log('\n=== fixo: periodicidade individual + gerar_pagamentos_fixos_do_dia() idempotente ===');
    {
      const u = await createAuthUser('fixo.repasses');
      authUserIds.push(u.id);
      const hoje = new Date();
      const { pessoaId, entregadorId } = await criarEntregador(
        pg, tenantId, u.id, { nome: 'Fixo Repasses', status: 'disponivel' },
        { tipo_vinculo: 'fixo', valor_fixo: 180.00, periodicidade_pagamento_fixo: 'mensal', dia_mes_pagamento_fixo_1: hoje.getDate() }
      );
      const sess = await signInAs(u.email);
      const { error: eConfirmar } = await sess.rpc('confirmar_chave_pix', { p_nova_chave: 'fixo@teste.com', p_tipo: 'email' });
      check('fixo confirma chave+tipo', !eConfirmar, eConfirmar);

      await pg.query(`select gerar_pagamentos_fixos_do_dia()`);
      const { rows: gerado1 } = await pg.query(`select id, status from pagamentos_fixos where entregador_id = $1`, [entregadorId]);
      check('gerar_pagamentos_fixos_do_dia() cria a linha pendente hoje', gerado1.length === 1 && gerado1[0].status === 'pendente', gerado1);

      await pg.query(`select gerar_pagamentos_fixos_do_dia()`);
      const { rows: gerado2 } = await pg.query(`select count(*)::int as n from pagamentos_fixos where entregador_id = $1`, [entregadorId]);
      check('chamar de novo (simula restart) não duplica — unique(entregador_id, referencia_data)', gerado2[0].n === 1, gerado2);

      const { rows: prontos } = await pg.query(`select * from pagamentos_fixos_prontos_para_pagar() where pagamento_id = $1`, [gerado1[0].id]);
      check('pagamento fixo aparece pronto pra pagar com chave+tipo certos', prontos.length === 1 && prontos[0].chave_pix_tipo === 'email', prontos);
    }

    console.log('\n=== isolamento: RPCs de motor bloqueadas pra qualquer client autenticado ===');
    {
      const u = await createAuthUser('isolamento.repasses');
      authUserIds.push(u.id);
      const sess = await signInAs(u.email);
      const chamadas = [
        ['repasses_freelance_prontos_para_pagar', {}],
        ['pagamentos_fixos_prontos_para_pagar', {}],
        ['gerar_pagamentos_fixos_do_dia', {}],
        ['marcar_tentativa_repasses', { p_repasse_ids: [] }],
        ['marcar_tentativa_pagamento_fixo', { p_pagamento_id: crypto.randomUUID() }],
        ['credenciais_pix_do_tenant', { p_tenant_id: crypto.randomUUID() }],
      ];
      for (const [fn, params] of chamadas) {
        const { error } = await sess.rpc(fn, params);
        check(`${fn}() bloqueada por permissão pra client autenticado comum`, !!error && /permission denied/i.test(error.message), error);
      }
    }

    return r;
  } finally {
    await cleanup(pg, tenantIds, authUserIds);
    await pg.end();
    console.log(`\n=== [repasses_automaticos] RESULTADO: ${r.pass} passou, ${r.fail} falhou ===`);
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
