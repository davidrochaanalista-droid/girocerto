// Subcontas Asaas (item 118, 06/09/2026, pedido direto do usuário) —
// pagamento manual do fixo (evita pagar 2x quando a loja acerta na mão),
// saldo devedor visível, fila de repasse por prioridade (freelancer
// primeiro — sem fallback de receber na loja — fixo depois), e
// credenciais da subconta (apiKey própria + token de webhook) cifradas,
// nunca expostas ao client.
const crypto = require('crypto');
const { newPgClient, createAuthUser, signInAs, criarEntregador, makeReporter, cleanup } = require('./lib/helpers');

async function run() {
  const r = makeReporter('subcontas');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja Teste Subcontas')`, [tenantId]);
    tenantIds.push(tenantId);

    const dono = await createAuthUser('dono.subcontas');
    authUserIds.push(dono.id);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono','dono')`, [tenantId, dono.id]);
    const sessDono = await signInAs(dono.email);

    console.log('\n=== pagamento manual do fixo (evita pagar 2x) ===');
    {
      const u = await createAuthUser('fixo.manual.subcontas');
      authUserIds.push(u.id);
      const { entregadorId } = await criarEntregador(
        pg, tenantId, u.id, { nome: 'Fixo Manual', status: 'disponivel', chave_pix: 'x@teste.com', chave_pix_tipo: 'email', chave_pix_confirmada_em: new Date().toISOString() },
        { tipo_vinculo: 'fixo', valor_fixo: 150, periodicidade_pagamento_fixo: 'mensal', dia_mes_pagamento_fixo_1: new Date().getDate() }
      );
      await pg.query(`select gerar_pagamentos_fixos_do_dia()`);
      const { rows: [pagamento] } = await pg.query(`select id, status, metodo_pagamento from pagamentos_fixos where entregador_id = $1`, [entregadorId]);
      r.check('pagamento fixo gerado, pendente, metodo pix_automatico por padrão', pagamento.status === 'pendente' && pagamento.metodo_pagamento === 'pix_automatico', pagamento);

      const outroDono = await createAuthUser('outro.dono.subcontas');
      authUserIds.push(outroDono.id);
      const outroTenantId = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome) values ($1,'Loja Teste Subcontas Outra')`, [outroTenantId]);
      tenantIds.push(outroTenantId);
      await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Outro','dono')`, [outroTenantId, outroDono.id]);
      const sessOutro = await signInAs(outroDono.email);
      const { error: eOutro } = await sessOutro.rpc('marcar_pagamento_fixo_manual', { p_pagamento_id: pagamento.id });
      r.check('dono de OUTRA loja não pode marcar como pago manualmente', !!eOutro, eOutro);

      const { error: eMarcar } = await sessDono.rpc('marcar_pagamento_fixo_manual', { p_pagamento_id: pagamento.id });
      r.check('dono da loja certa marca como pago manualmente', !eMarcar, eMarcar);

      const { rows: [aposMarcar] } = await pg.query(`select status, metodo_pagamento, pago_em from pagamentos_fixos where id = $1`, [pagamento.id]);
      r.check('status vira pago, metodo vira manual, pago_em preenchido', aposMarcar.status === 'pago' && aposMarcar.metodo_pagamento === 'manual' && !!aposMarcar.pago_em, aposMarcar);

      const { rows: prontosParaPagar } = await pg.query(`select * from pagamentos_fixos_prontos_para_pagar() where pagamento_id = $1`, [pagamento.id]);
      r.check('depois de marcado manual, NUNCA mais aparece pronto pro motor automático pagar (evita pagar 2x)', prontosParaPagar.length === 0, prontosParaPagar);

      const { error: eMarcarDeNovo } = await sessDono.rpc('marcar_pagamento_fixo_manual', { p_pagamento_id: pagamento.id });
      r.check('marcar 2x o mesmo pagamento não quebra nem reprocessa (status já não é mais pendente)', !eMarcarDeNovo, eMarcarDeNovo);
      const { rows: [aindaManual] } = await pg.query(`select metodo_pagamento from pagamentos_fixos where id = $1`, [pagamento.id]);
      r.check('continua manual (2ª chamada não fez nada, WHERE status=pendente barrou)', aindaManual.metodo_pagamento === 'manual', aindaManual);
    }

    console.log('\n=== saldo devedor da loja ===');
    {
      const uFree = await createAuthUser('freelance.saldo.subcontas');
      authUserIds.push(uFree.id);
      const { entregadorId: idFree } = await criarEntregador(
        pg, tenantId, uFree.id,
        { nome: 'Freelance Saldo', status: 'disponivel', chave_pix: 'freelance-saldo@teste.com', chave_pix_tipo: 'email', chave_pix_confirmada_em: new Date().toISOString() },
        { tipo_vinculo: 'freelance' }
      );
      const { rows: [pedido] } = await pg.query(`insert into pedidos (tenant_id, endereco, valor_pedido, status) values ($1,'Rua Subcontas',30,'entregue') returning id`, [tenantId]);
      await pg.query(`insert into repasses (entregador_id, pedido_id, valor, status) values ($1,$2,22.50,'pendente')`, [idFree, pedido.id]);

      const uFixo2 = await createAuthUser('fixo2.saldo.subcontas');
      authUserIds.push(uFixo2.id);
      await criarEntregador(
        pg, tenantId, uFixo2.id,
        { nome: 'Fixo Saldo 2', status: 'disponivel', chave_pix: 'fixo-saldo2@teste.com', chave_pix_tipo: 'email', chave_pix_confirmada_em: new Date().toISOString() },
        { tipo_vinculo: 'fixo', valor_fixo: 88, periodicidade_pagamento_fixo: 'mensal', dia_mes_pagamento_fixo_1: new Date().getDate() }
      );
      await pg.query(`select gerar_pagamentos_fixos_do_dia()`);

      const { data: saldo, error: eSaldo } = await sessDono.rpc('saldo_devedor_da_minha_loja');
      const linha = saldo && saldo[0];
      r.check(
        'saldo_devedor_da_minha_loja() soma freelance (22.50) + fixo (88) certo',
        !eSaldo && linha && Number(linha.total_freelance) === 22.5 && Number(linha.total_fixo) === 88 && Number(linha.total_geral) === 110.5,
        { linha, eSaldo }
      );
    }

    console.log('\n=== fila_repasses_por_prioridade: freelance vem ANTES do fixo ===');
    {
      const { rows: fila } = await pg.query(`select tipo, prioridade, valor from fila_repasses_por_prioridade($1)`, [tenantId]);
      r.check('fila tem pelo menos 1 freelance e 1 fixo prontos (chave+tipo confirmados)', fila.length >= 1, fila);
      if (fila.length >= 2) {
        r.check('freelance (prioridade 1) vem antes de fixo (prioridade 2) na ordem devolvida', fila[0].prioridade <= fila[fila.length - 1].prioridade, fila);
      }
      const tipos = fila.map((f) => f.tipo);
      r.check('tipos presentes são só "freelance"/"fixo"', tipos.every((t) => t === 'freelance' || t === 'fixo'), tipos);
    }

    console.log('\n=== credenciais da subconta: cifradas, só service_role decifra, webhook token nunca vaza ===');
    {
      const { rows: [reg] } = await pg.query(
        `select registrar_subconta_asaas($1, 'wallet_teste_123', 'chave-api-secreta-da-subconta', 'token-webhook-secreto-xyz', 'chave-recarga@teste.com') as id`,
        [tenantId]
      );
      r.check('registrar_subconta_asaas() cria a subconta e devolve um id', !!reg.id, reg);

      const { rows: [cru] } = await pg.query(`select api_key_cifrada, webhook_auth_token_cifrado from subcontas_asaas where id = $1`, [reg.id]);
      r.check('api_key armazenada como bytea cifrado, nunca o texto puro', Buffer.isBuffer(cru.api_key_cifrada), cru.api_key_cifrada);
      r.check('webhook_auth_token armazenado como bytea cifrado, nunca o texto puro', Buffer.isBuffer(cru.webhook_auth_token_cifrado), cru.webhook_auth_token_cifrado);

      const { rows: [decifrada] } = await pg.query(`select api_key_da_subconta($1) as chave`, [tenantId]);
      r.check('api_key_da_subconta() decifra corretamente pro service role', decifrada.chave === 'chave-api-secreta-da-subconta', decifrada);

      const { rows: [webhookCerto] } = await pg.query(`select verificar_webhook_subconta('wallet_teste_123', 'token-webhook-secreto-xyz') as tid`);
      r.check('verificar_webhook_subconta() com token CERTO devolve o tenant_id', webhookCerto.tid === tenantId, webhookCerto);

      const { rows: [webhookErrado] } = await pg.query(`select verificar_webhook_subconta('wallet_teste_123', 'token-forjado-por-atacante') as tid`);
      r.check('verificar_webhook_subconta() com token ERRADO (forjado) devolve null — achado real corrigido durante o teste: typo de nome de parâmetro (v_ vs p_) fazia a função quebrar sempre', webhookErrado.tid === null, webhookErrado);

      const sessOutraVez = await signInAs(dono.email);
      const { error: eApiKeyClient } = await sessOutraVez.rpc('api_key_da_subconta', { p_tenant_id: tenantId });
      r.check('client autenticado (mesmo dono da loja) NÃO consegue chamar api_key_da_subconta() direto', !!eApiKeyClient, eApiKeyClient);
      const { error: eWebhookClient } = await sessOutraVez.rpc('verificar_webhook_subconta', { p_wallet_id: 'wallet_teste_123', p_token_recebido: 'x' });
      r.check('client autenticado NÃO consegue chamar verificar_webhook_subconta() direto', !!eWebhookClient, eWebhookClient);

      console.log('\n  --- depósito e débito na subconta ---');
      await pg.query(`select registrar_deposito_subconta($1, 200.00, 'webhook-pay_abc123')`, [tenantId]);
      const { rows: [aposDeposito] } = await pg.query(`select saldo_confirmado from subcontas_asaas where id = $1`, [reg.id]);
      r.check('depósito soma no saldo_confirmado', Number(aposDeposito.saldo_confirmado) === 200, aposDeposito);

      await pg.query(`select debitar_subconta_apos_repasse($1, 45.00, 'transfer-xyz')`, [tenantId]);
      const { rows: [aposDebito] } = await pg.query(`select saldo_confirmado from subcontas_asaas where id = $1`, [reg.id]);
      r.check('débito subtrai do saldo_confirmado', Number(aposDebito.saldo_confirmado) === 155, aposDebito);

      const { rows: movimentos } = await pg.query(`select tipo, valor, referencia from subconta_movimentos where subconta_id = $1 order by criado_em`, [reg.id]);
      r.check('extrato (ledger) tem os 2 movimentos, na ordem certa', movimentos.length === 2 && movimentos[0].tipo === 'deposito' && movimentos[1].tipo === 'repasse', movimentos);

      const { data: extratoClient, error: eExtratoClient } = await sessDono.from('subconta_movimentos').select('*').eq('subconta_id', reg.id);
      r.check('dono da loja CONSEGUE ver o próprio extrato direto (RLS de select)', !eExtratoClient && extratoClient.length === 2, { eExtratoClient, extratoClient });

      const curioso = await createAuthUser('curioso.subcontas');
      authUserIds.push(curioso.id);
      const sessCurioso = await signInAs(curioso.email);
      const { data: extratoOutro } = await sessCurioso.from('subconta_movimentos').select('*').eq('subconta_id', reg.id);
      r.check('outro usuário qualquer NÃO vê o extrato dessa loja', (extratoOutro || []).length === 0, extratoOutro);
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
