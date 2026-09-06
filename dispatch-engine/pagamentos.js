// Motor de repasse automático via Pix (item 109-111, 05/09/2026, pedido
// direto do usuário: "máxima integração possível, com máxima segurança").
//
// Desenho combinado com o usuário: freelancer confirma a chave Pix toda
// terça (repasse por entrega, ver repasses/gerar_repasse_ao_entregar no
// schema) e é pago toda quarta a partir das 11h; fixo (salário periódico,
// valor_fixo) confirma no dia anterior e é pago na data que a PRÓPRIA
// LOJA escolheu (item 110: fim de turno/semanal/mensal/quinzenal). Quem
// não confirmou a chave fica de fora do lote daquele ciclo — nunca manda
// pra chave desatualizada (ver precisa_confirmar_chave_pix()/
// confirmar_chave_pix() no schema).
//
// Toda a seleção "quem pagar, quanto, com qual chave" e a trava contra
// pagamento duplicado (unique(entregador_id, referencia_data) em
// pagamentos_fixos; status='pendente' em repasses) vivem no Postgres —
// ver ITEM 111 no schema.sql. Este módulo só chama essas funções e faz a
// ÚNICA parte que só pode ser feita em Node: a chamada HTTP de verdade
// pro provedor de Pix.
//
// AVISO HONESTO, pra quem for ativar isto de verdade: nenhum provedor
// (Mercado Pago/Asaas/Stone) foi testado com credencial real neste
// projeto — não existe conta em nenhum deles ainda. transferirPix()
// abaixo FALHA DE PROPÓSITO (nunca marca nada como pago) até alguém
// confirmar o endpoint/payload exato de transferência PIX-OUT contra a
// documentação oficial ATUAL de cada provedor e testar em sandbox
// primeiro. Um Pix errado não tem "desfazer" — é melhor falhar alto e
// visível do que arriscar um payload adivinhado errar silenciosamente.

'use strict';

/**
 * Tenta transferir um valor via Pix usando o provedor configurado pela
 * loja. Nunca lança exceção — sempre devolve { sucesso, pixTxid, erro }
 * pra quem chamar decidir o que fazer (marcar pago vs. registrar erro).
 */
async function transferirPix({ provider, apiKey, chavePixDestino, valor, referenciaExterna }) {
  if (!provider || !apiKey) {
    return { sucesso: false, erro: 'Loja sem provedor de Pix configurado (Integrações → Pix).' };
  }

  switch (provider) {
    case 'mercado_pago':
      return transferirPixMercadoPago(apiKey, chavePixDestino, valor, referenciaExterna);
    case 'asaas':
      return transferirPixAsaas(apiKey, chavePixDestino, valor, referenciaExterna);
    case 'stone':
      return transferirPixStone(apiKey, chavePixDestino, valor, referenciaExterna);
    default:
      return { sucesso: false, erro: `Provedor de Pix desconhecido: ${provider}` };
  }
}

// PENDÊNCIA (ver aviso no topo do arquivo): endpoint de PIX-OUT (enviar
// pra uma chave arbitrária) precisa ser confirmado contra a doc oficial
// atual da conta Mercado Pago da loja antes de ativar — o produto certo
// (Payments API padrão é pra RECEBER, não enviar) depende do tipo de
// conta/contrato que a loja tiver.
async function transferirPixMercadoPago(_apiKey, _chavePixDestino, _valor, _referenciaExterna) {
  return {
    sucesso: false,
    erro: 'Integração de envio de Pix via Mercado Pago ainda não implementada — confirmar endpoint exato contra a documentação oficial atual antes de ativar (dispatch-engine/pagamentos.js).',
  };
}

// PENDÊNCIA — mesma observação: Asaas tem endpoint de transferência Pix
// (POST /pixTransfers na API deles, no conhecimento usado pra escrever
// isto), mas não foi testado com credencial real nenhuma vez.
async function transferirPixAsaas(_apiKey, _chavePixDestino, _valor, _referenciaExterna) {
  return {
    sucesso: false,
    erro: 'Integração de envio de Pix via Asaas ainda não implementada — confirmar endpoint exato contra a documentação oficial atual antes de ativar (dispatch-engine/pagamentos.js).',
  };
}

// PENDÊNCIA — mesma observação, Stone.
async function transferirPixStone(_apiKey, _chavePixDestino, _valor, _referenciaExterna) {
  return {
    sucesso: false,
    erro: 'Integração de envio de Pix via Stone ainda não implementada — confirmar endpoint exato contra a documentação oficial atual antes de ativar (dispatch-engine/pagamentos.js).',
  };
}

/**
 * Roda o lote de repasse dos FREELANCERS — repasses_freelance_prontos_para_pagar()
 * já filtra por status='pendente' e chave confirmada nos últimos 2 dias
 * (ver item 111 no schema). Idempotente por construção: quem já foi
 * pago não aparece de novo na próxima chamada (status vira 'pago').
 */
async function executarLoteFreelance(admin) {
  const { data: prontos, error } = await admin.rpc('repasses_freelance_prontos_para_pagar');
  if (error) {
    console.error('[pagamentos] falha ao buscar repasses freelance prontos:', error.message);
    return;
  }
  for (const item of prontos || []) {
    const { pix_provider: provider, pix_provider_api_key: apiKey } = await credenciaisDoTenant(admin, item.tenant_id);
    const referenciaExterna = `freelance-${item.pessoa_id}-${item.tenant_id}-${new Date().toISOString().slice(0, 10)}`;
    const resultado = await transferirPix({
      provider, apiKey, chavePixDestino: item.chave_pix, valor: item.valor_total, referenciaExterna,
    });
    if (resultado.sucesso) {
      await admin.rpc('marcar_repasses_pagos', { p_repasse_ids: item.repasse_ids, p_pix_txid: resultado.pixTxid });
      console.log(`[pagamentos] freelance pago: pessoa ${item.pessoa_id}, tenant ${item.tenant_id}, R$ ${item.valor_total}`);
    } else {
      await admin.rpc('marcar_repasses_com_erro', { p_repasse_ids: item.repasse_ids, p_erro: resultado.erro });
      console.error(`[pagamentos] falha ao pagar freelance (pessoa ${item.pessoa_id}, tenant ${item.tenant_id}): ${resultado.erro}`);
    }
  }
}

/**
 * Roda o lote de pagamento do FIXO — gera as linhas pendentes de hoje
 * (idempotente via unique(entregador_id, referencia_data)) e processa
 * as que estão prontas (chave confirmada).
 */
async function executarLoteFixo(admin) {
  const { error: erroGerar } = await admin.rpc('gerar_pagamentos_fixos_do_dia');
  if (erroGerar) {
    console.error('[pagamentos] falha ao gerar pagamentos fixos do dia:', erroGerar.message);
    return;
  }

  const { data: prontos, error } = await admin.rpc('pagamentos_fixos_prontos_para_pagar');
  if (error) {
    console.error('[pagamentos] falha ao buscar pagamentos fixos prontos:', error.message);
    return;
  }
  for (const item of prontos || []) {
    const { pix_provider: provider, pix_provider_api_key: apiKey } = await credenciaisDoTenant(admin, item.tenant_id);
    const referenciaExterna = `fixo-${item.pagamento_id}`;
    const resultado = await transferirPix({
      provider, apiKey, chavePixDestino: item.chave_pix, valor: item.valor, referenciaExterna,
    });
    if (resultado.sucesso) {
      await admin.rpc('marcar_pagamento_fixo_pago', { p_pagamento_id: item.pagamento_id, p_pix_txid: resultado.pixTxid });
      console.log(`[pagamentos] fixo pago: pagamento ${item.pagamento_id}, tenant ${item.tenant_id}, R$ ${item.valor}`);
    } else {
      await admin.rpc('marcar_pagamento_fixo_erro', { p_pagamento_id: item.pagamento_id, p_erro: resultado.erro });
      console.error(`[pagamentos] falha ao pagar fixo (pagamento ${item.pagamento_id}, tenant ${item.tenant_id}): ${resultado.erro}`);
    }
  }
}

async function credenciaisDoTenant(admin, tenantId) {
  const { data, error } = await admin.rpc('credenciais_pix_do_tenant', { p_tenant_id: tenantId });
  if (error || !data || !data[0]) {
    return { pix_provider: null, pix_provider_api_key: null };
  }
  return data[0];
}

/**
 * Checagem periódica (chamada a cada poucos minutos pelo index.js) —
 * freelance só roda quarta a partir das 11h; fixo roda todo dia (a
 * seleção em si já filtra pela política de cada loja, ver
 * hoje_e_dia_pagamento_fixo() no schema).
 */
async function verificarRepassesAutomaticos(admin) {
  const agora = new Date();
  const diaDaSemana = agora.getDay(); // 0=domingo..6=sábado
  const hora = agora.getHours();

  if (diaDaSemana === 3 && hora >= 11) { // quarta, a partir das 11h
    await executarLoteFreelance(admin).catch((e) => console.error('[pagamentos] erro no lote freelance:', e.message));
  }

  await executarLoteFixo(admin).catch((e) => console.error('[pagamentos] erro no lote fixo:', e.message));
}

module.exports = { transferirPix, executarLoteFreelance, executarLoteFixo, verificarRepassesAutomaticos };
