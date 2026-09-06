// item 118 (06/09/2026) — webhook da Asaas (confirma depósito antes de
// qualquer pagamento) e alocação por orçamento (freelance > fixo,
// nunca paga além do saldo REAL confirmado ao vivo — nunca confia só
// no webhook/ledger interno). fetch mockado (sem credencial real);
// tudo o mais é real (RLS, RPCs, banco).
const crypto = require('crypto');
const path = require('path');
const { newPgClient, admin, createAuthUser, criarEntregador, cleanup, makeReporter } = require('./lib/helpers');
const { tratarWebhookAsaas, processarTenantComSubconta } = require(path.join('..', 'dispatch-engine', 'pagamentos.js'));

// achado real durante o desenvolvimento deste teste: mockar global.fetch
// sem filtro também intercepta as chamadas HTTP INTERNAS do client
// Supabase (admin.rpc() usa fetch por baixo) — quebrava toda checagem
// de tentativa/marcação que roda ANTES da chamada real à Asaas dentro
// de processarTenantComSubconta(). Filtra por domínio: só api.asaas.com
// é mockado, o resto passa pro fetch de verdade.
const fetchOriginal = global.fetch;
let respostasFetch = [];
function mockFetchSequencia(respostas) {
  respostasFetch = respostas.slice();
  global.fetch = async (url, opts) => {
    if (!String(url).includes('api.asaas.com')) {
      return fetchOriginal(url, opts);
    }
    const proxima = respostasFetch.shift();
    if (!proxima) throw new Error('mockFetch: sem resposta programada pra ' + url);
    return {
      ok: proxima.status >= 200 && proxima.status < 300,
      status: proxima.status,
      json: async () => proxima.body,
    };
  };
}

async function run() {
  const r = makeReporter('webhook_asaas');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja Teste Webhook Asaas')`, [tenantId]);
    tenantIds.push(tenantId);

    const { rows: [subconta] } = await pg.query(
      `select registrar_subconta_asaas($1, 'wallet_webhook_teste', 'apikey-subconta-teste', 'auth-token-webhook-teste', 'chave-recarga@teste.com') as id`,
      [tenantId]
    );

    console.log('\n=== tratarWebhookAsaas(): token válido registra depósito ===');
    {
      await tratarWebhookAsaas(admin, 'wallet_webhook_teste', 'auth-token-webhook-teste', {
        event: 'PAYMENT_RECEIVED', payment: { id: 'pay_teste_001', value: 300 },
      });
      const { rows: [saldo] } = await pg.query(`select saldo_confirmado from subcontas_asaas where id = $1`, [subconta.id]);
      r.check('depósito confirmado via webhook soma no saldo_confirmado', Number(saldo.saldo_confirmado) === 300, saldo);
      const { rows: movimentos } = await pg.query(`select tipo, valor, referencia from subconta_movimentos where subconta_id = $1`, [subconta.id]);
      r.check('ledger grava o movimento com a referência do pagamento Asaas', movimentos.length === 1 && movimentos[0].referencia === 'pay_teste_001', movimentos);
    }

    console.log('\n=== tratarWebhookAsaas(): token FORJADO é rejeitado, nunca registra nada ===');
    {
      let erroCapturado = null;
      try {
        await tratarWebhookAsaas(admin, 'wallet_webhook_teste', 'token-forjado-por-atacante', {
          event: 'PAYMENT_RECEIVED', payment: { id: 'pay_forjado_002', value: 99999 },
        });
      } catch (e) { erroCapturado = e; }
      r.check('token forjado lança erro com código HTTP 401', erroCapturado && erroCapturado.codigoHttp === 401, erroCapturado);
      const { rows: [saldoAposForjado] } = await pg.query(`select saldo_confirmado from subcontas_asaas where id = $1`, [subconta.id]);
      r.check('saldo NÃO mudou com o webhook forjado (continua 300, não 300+99999)', Number(saldoAposForjado.saldo_confirmado) === 300, saldoAposForjado);
    }

    console.log('\n=== tratarWebhookAsaas(): evento que não é PAYMENT_RECEIVED é ignorado, sem erro ===');
    {
      let erroCapturado = null;
      try {
        await tratarWebhookAsaas(admin, 'wallet_webhook_teste', 'auth-token-webhook-teste', { event: 'PAYMENT_CREATED', payment: { id: 'x', value: 50 } });
      } catch (e) { erroCapturado = e; }
      r.check('evento PAYMENT_CREATED (não confirmado ainda) não lança erro nem muda saldo', !erroCapturado, erroCapturado);
      const { rows: [saldoInalterado] } = await pg.query(`select saldo_confirmado from subcontas_asaas where id = $1`, [subconta.id]);
      r.check('saldo continua 300 (evento não relevante ignorado)', Number(saldoInalterado.saldo_confirmado) === 300, saldoInalterado);
    }

    console.log('\n=== alocação por orçamento: freelance > fixo, nunca paga além do saldo REAL da API ===');
    // (sem chaves de bloco de propósito — idFree/idFixo são reaproveitados
    // no cenário seguinte, pra provar que um item que não coube antes é
    // retentado depois, não fica travado pra sempre)
    {
      // freelance: R$ 50 pendente
      const uFree = await createAuthUser('freelance.webhook118');
      authUserIds.push(uFree.id);
      const { entregadorId: idFree } = await criarEntregador(
        pg, tenantId, uFree.id,
        { nome: 'Freelance Webhook', status: 'disponivel', chave_pix: 'freelance-webhook@teste.com', chave_pix_tipo: 'email', chave_pix_confirmada_em: new Date().toISOString() },
        { tipo_vinculo: 'freelance' }
      );
      const { rows: [pedido] } = await pg.query(`insert into pedidos (tenant_id, endereco, valor_pedido, status) values ($1,'Rua Webhook',30,'entregue') returning id`, [tenantId]);
      await pg.query(`insert into repasses (entregador_id, pedido_id, valor, status) values ($1,$2,50.00,'pendente')`, [idFree, pedido.id]);

      // fixo: R$ 80 pendente (hoje é dia de pagamento)
      const uFixo = await createAuthUser('fixo.webhook118');
      authUserIds.push(uFixo.id);
      const { entregadorId: idFixo } = await criarEntregador(
        pg, tenantId, uFixo.id,
        { nome: 'Fixo Webhook', status: 'disponivel', chave_pix: 'fixo-webhook@teste.com', chave_pix_tipo: 'email', chave_pix_confirmada_em: new Date().toISOString() },
        { tipo_vinculo: 'fixo', valor_fixo: 80, periodicidade_pagamento_fixo: 'mensal', dia_mes_pagamento_fixo_1: new Date().getDate() }
      );

      await pg.query(`select gerar_pagamentos_fixos_do_dia()`);

      // saldo real via API mockado = 60 (cobre o freelance de 50, NÃO cobre o fixo de 80)
      mockFetchSequencia([
        { status: 200, body: { balance: 60 } }, // consultarSaldoAsaas
        { status: 200, body: { id: 'transfer_freelance_xyz' } }, // transferirPixAsaas pro freelance
      ]);

      // chama a função diretamente com podeFreelanceHoje=true — determinístico,
      // não depende do dia/hora real em que o teste rodar.
      await processarTenantComSubconta(admin, tenantId, 'wallet_webhook_teste', true);

      const { rows: [repasseFinal] } = await pg.query(`select status, pix_txid from repasses where entregador_id = $1`, [idFree]);
      const { rows: [fixoFinal] } = await pg.query(`select status from pagamentos_fixos where entregador_id = $1`, [idFixo]);

      r.check('freelance pago (coube no saldo de 60)', repasseFinal.status === 'pago' && repasseFinal.pix_txid === 'transfer_freelance_xyz', repasseFinal);
      r.check('fixo NÃO pago (não coube no saldo restante após o freelance)', fixoFinal.status === 'pendente', fixoFinal);

      const { rows: [subcontaAposLote] } = await pg.query(`select saldo_confirmado from subcontas_asaas where wallet_id = 'wallet_webhook_teste'`);
      r.check('ledger interno debitado só do valor pago (300 depósito - 50 repasse = 250, fixo não debitou)', Number(subcontaAposLote.saldo_confirmado) === 250, subcontaAposLote);

    console.log('\n=== freelance fora da janela (quarta 11h+): nunca paga, mesmo com saldo de sobra ===');
      const uFree2 = await createAuthUser('freelance2.webhook118');
      authUserIds.push(uFree2.id);
      const { entregadorId: idFree2 } = await criarEntregador(
        pg, tenantId, uFree2.id,
        { nome: 'Freelance Webhook 2', status: 'disponivel', chave_pix: 'freelance2-webhook@teste.com', chave_pix_tipo: 'email', chave_pix_confirmada_em: new Date().toISOString() },
        { tipo_vinculo: 'freelance' }
      );
      const { rows: [pedido2] } = await pg.query(`insert into pedidos (tenant_id, endereco, valor_pedido, status) values ($1,'Rua Webhook 2',30,'entregue') returning id`, [tenantId]);
      await pg.query(`insert into repasses (entregador_id, pedido_id, valor, status) values ($1,$2,10.00,'pendente')`, [idFree2, pedido2.id]);

      // saldo agora é de sobra (1000) — o fixo de R$80 (bloco anterior,
      // não coube em 60) deve ser retentado e desta vez pago; o
      // freelance2 (R$10) continua fora por causa do dia/hora, não do
      // saldo — prova que a fila não trava, só espera o próprio critério.
      mockFetchSequencia([
        { status: 200, body: { balance: 1000 } }, // consultarSaldoAsaas
        { status: 200, body: { id: 'transfer_fixo_retentado' } }, // transferirPixAsaas pro fixo, agora com orçamento
      ]);
      await processarTenantComSubconta(admin, tenantId, 'wallet_webhook_teste', false);

      const { rows: [repasse2Final] } = await pg.query(`select status from repasses where entregador_id = $1`, [idFree2]);
      r.check('freelance continua pendente fora da janela de quarta 11h+, mesmo com saldo de sobra', repasse2Final.status === 'pendente', repasse2Final);

      const { rows: [fixoRetentado] } = await pg.query(`select status, pix_txid from pagamentos_fixos where entregador_id = $1`, [idFixo]);
      r.check('fixo pendente do ciclo anterior (não coube antes) é retentado e pago quando o saldo permite — nunca fica travado pra sempre', fixoRetentado.status === 'pago' && fixoRetentado.pix_txid === 'transfer_fixo_retentado', fixoRetentado);
    }

    console.log('\n=== saldo real indisponível (API fora do ar/erro): NADA é pago, fail-safe ===');
    {
      const tenantId2 = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome) values ($1,'Loja Teste Webhook Asaas 2')`, [tenantId2]);
      tenantIds.push(tenantId2);
      await pg.query(
        `select registrar_subconta_asaas($1, 'wallet_webhook_teste_2', 'apikey-subconta-teste-2', 'auth-token-webhook-teste-2', null)`,
        [tenantId2]
      );

      const uFixo2 = await createAuthUser('fixo2.webhook118');
      authUserIds.push(uFixo2.id);
      await criarEntregador(
        pg, tenantId2, uFixo2.id,
        { nome: 'Fixo Webhook 2', status: 'disponivel', chave_pix: 'fixo-webhook2@teste.com', chave_pix_tipo: 'email', chave_pix_confirmada_em: new Date().toISOString() },
        { tipo_vinculo: 'fixo', valor_fixo: 40, periodicidade_pagamento_fixo: 'mensal', dia_mes_pagamento_fixo_1: new Date().getDate() }
      );
      await pg.query(`select gerar_pagamentos_fixos_do_dia()`);

      mockFetchSequencia([{ status: 500, body: {} }]); // consultarSaldoAsaas falha
      await processarTenantComSubconta(admin, tenantId2, 'wallet_webhook_teste_2', true);

      const { rows: [fixo2Final] } = await pg.query(
        `select pf.status from pagamentos_fixos pf join entregadores e on e.id = pf.entregador_id where e.tenant_id = $1`,
        [tenantId2]
      );
      r.check('sem confirmação de saldo real, NADA é pago (fail-safe) mesmo com pagamento pendente existindo', fixo2Final.status === 'pendente', fixo2Final);
    }

    return r.summary();
  } finally {
    global.fetch = fetchOriginal;
    await cleanup(pg, tenantIds, authUserIds);
    await pg.end();
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
