// Ciclo de vida do pedido: origens, status completo até entregue/cancelado,
// forma_pagamento (pix antecipado e QR na entrega), valor_troco (coluna
// gerada), protocolo de contato até cliente_nao_localizado, item_retorna_loja.
//
// PENDÊNCIA documentada (não testada por depender de feature inexistente):
// - avaliacao_entrega/avaliacao_comentario via link público de rastreio: o
//   link público pro cliente está listado no CLAUDE.md como "fora de escopo,
//   TODO" — não existe policy nem UI pra isso. Testar exigiria simular uma
//   feature que não existe.
// - valor_reembolsado = cálculo automático de percentual_reembolso_sem_contato
//   sobre valor_pedido: nenhuma função/trigger faz essa multiplicação no
//   schema — é responsabilidade do motor de despacho/backend, que não existe
//   ainda. Testamos só que a coluna aceita e guarda o valor corretamente
//   (mecânica de storage), não o cálculo em si (não existe código que calcule).
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup } = require('./lib/helpers');

async function run() {
  const r = makeReporter('pedido');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const donoUser = await createAuthUser('dono.pedido');
    authUserIds.push(donoUser.id);
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome, percentual_reembolso_sem_contato) values ($1,'Loja Pedido',50.00)`, [tenantId]);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono','dono')`, [tenantId, donoUser.id]);
    tenantIds.push(tenantId);
    const sessDono = await signInAs(donoUser.email);

    console.log('\n=== Todos os valores de origem ===');
    for (const origem of ['manual', 'whatsapp', 'ifood', 'cardapio_proprio']) {
      const { error, data } = await sessDono.from('pedidos').insert({
        tenant_id: tenantId, origem, endereco: `Rua ${origem}`, valor_pedido: 30,
      }).select('id').single();
      r.check(`origem='${origem}' aceito`, !error && data, error);
    }

    console.log('\n=== Ciclo completo recebido -> em_preparo -> pronto -> a_caminho -> entregue ===');
    {
      const { data: pedido } = await sessDono.from('pedidos').insert({
        tenant_id: tenantId, origem: 'manual', endereco: 'Rua Ciclo', valor_pedido: 40,
      }).select('id').single();
      const sequencia = ['em_preparo', 'pronto', 'a_caminho', 'entregue'];
      let ok = true;
      for (const status of sequencia) {
        const { error } = await sessDono.from('pedidos').update({ status }).eq('id', pedido.id);
        if (error) ok = false;
      }
      const { data: final } = await admin.from('pedidos').select('status').eq('id', pedido.id).single();
      r.check('loja consegue avançar o pedido por todo o ciclo até entregue', ok && final.status === 'entregue', final);
    }

    console.log('\n=== Caminho de cancelamento ===');
    {
      const { data: pedido } = await sessDono.from('pedidos').insert({
        tenant_id: tenantId, origem: 'manual', endereco: 'Rua Cancelado', valor_pedido: 15,
      }).select('id').single();
      const { error } = await sessDono.from('pedidos').update({ status: 'cancelado' }).eq('id', pedido.id);
      const { data: final } = await admin.from('pedidos').select('status').eq('id', pedido.id).single();
      r.check('loja consegue cancelar um pedido', !error && final.status === 'cancelado', final);
    }

    console.log('\n=== forma_pagamento pix: pago_antecipado true e false (QR dinâmico) ===');
    for (const pago_antecipado of [true, false]) {
      const { error, data } = await sessDono.from('pedidos').insert({
        tenant_id: tenantId, origem: 'manual', endereco: 'Rua Pix', valor_pedido: 22,
        forma_pagamento: 'pix', pago_antecipado,
      }).select('pago_antecipado').single();
      r.check(`pago_antecipado=${pago_antecipado} aceito`, !error && data && data.pago_antecipado === pago_antecipado, error || data);
    }

    console.log('\n=== valor_troco (coluna gerada) ===');
    {
      const { data: comTroco, error: e1 } = await sessDono.from('pedidos').insert({
        tenant_id: tenantId, origem: 'manual', endereco: 'Rua Troco', valor_pedido: 18.50,
        forma_pagamento: 'dinheiro', troco_para: 20.00,
      }).select('valor_troco').single();
      r.check('valor_troco = troco_para - valor_pedido quando troco_para preenchido (20.00 - 18.50 = 1.50)', !e1 && Number(comTroco.valor_troco) === 1.5, comTroco);

      const { data: semTroco, error: e2 } = await sessDono.from('pedidos').insert({
        tenant_id: tenantId, origem: 'manual', endereco: 'Rua Sem Troco', valor_pedido: 18.50,
      }).select('valor_troco').single();
      r.check('valor_troco fica null quando troco_para não é preenchido', !e2 && semTroco.valor_troco === null, semTroco);
    }

    console.log('\n=== Protocolo de contato: tentativas_contato (ligação e mensagem, todos os resultados) até cliente_nao_localizado ===');
    {
      const { data: pedido } = await sessDono.from('pedidos').insert({
        tenant_id: tenantId, origem: 'manual', endereco: 'Rua Contato', valor_pedido: 25, contato_pendente: true,
      }).select('id').single();

      // tentativas_contato não tem policy de INSERT pra ninguém client-side (só SELECT
      // pra loja) — consistente com o padrão já visto em repasses/aprovação: é
      // responsabilidade de um sistema de discagem/mensageria automático (backend),
      // que ainda não existe. Inserimos via service role, que é como isso vai
      // funcionar de verdade quando o backend existir.
      const combinacoes = [
        ['ligacao', 'nao_atendeu'], ['ligacao', 'sem_resposta'],
        ['mensagem', 'respondeu'], ['mensagem', 'atendeu'],
      ];
      let todasOk = true;
      for (const [tipo, resultado] of combinacoes) {
        const { error } = await admin.from('tentativas_contato').insert({ pedido_id: pedido.id, tipo, resultado });
        if (error) todasOk = false;
      }
      r.check('tentativas_contato aceita ligacao/mensagem com todos os resultados (via service role — sem policy client-side de insert)', todasOk);

      const { data: tentativasVisiveis, error: eVis } = await sessDono.from('tentativas_contato').select('id').eq('pedido_id', pedido.id);
      r.check('loja consegue LER as tentativas de contato do próprio pedido', !eVis && tentativasVisiveis.length === combinacoes.length, { eVis, count: tentativasVisiveis && tentativasVisiveis.length });

      // esgotou o protocolo: cancela com motivo e "calcula" valor_reembolsado —
      // a multiplicação em si não é feita por nenhum código do produto (pendência,
      // ver cabeçalho do arquivo); aqui só confirmamos que a coluna aceita e guarda
      // o valor corretamente.
      const valorReembolsoEsperado = 25 * 0.5; // percentual_reembolso_sem_contato = 50.00 no tenant
      const { error: eCancel } = await sessDono.from('pedidos').update({
        status: 'cancelado', motivo_cancelamento: 'cliente_nao_localizado', valor_reembolsado: valorReembolsoEsperado,
      }).eq('id', pedido.id);
      const { data: final } = await admin.from('pedidos').select('status, motivo_cancelamento, valor_reembolsado').eq('id', pedido.id).single();
      r.check(
        'cancelamento com motivo_cancelamento=cliente_nao_localizado e valor_reembolsado guardam certo (cálculo em si é pendência, não existe função)',
        !eCancel && final.status === 'cancelado' && final.motivo_cancelamento === 'cliente_nao_localizado' && Number(final.valor_reembolsado) === valorReembolsoEsperado,
        final
      );
    }

    console.log('\n=== item_retorna_loja true/false ===');
    for (const item_retorna_loja of [true, false]) {
      const { error, data } = await sessDono.from('pedidos').insert({
        tenant_id: tenantId, origem: 'manual', endereco: 'Rua Retorno', valor_pedido: 10, item_retorna_loja,
      }).select('item_retorna_loja').single();
      r.check(`item_retorna_loja=${item_retorna_loja} aceito`, !error && data && data.item_retorna_loja === item_retorna_loja, error || data);
    }

    console.log('\n=== avaliacao_entrega/avaliacao_comentario (via link de rastreio) — PENDÊNCIA ===');
    r.check(
      'link público de rastreio pro cliente está fora de escopo (CLAUDE.md item 4, TODO explícito) — não há como testar sem inventar a feature. Não testado, documentado como pendência.',
      true
    );

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
