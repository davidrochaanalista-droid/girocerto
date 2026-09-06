// Motor de repasse automático via Pix (item 109-118, 05-06/09/2026,
// pedido direto do usuário: "máxima integração possível, com máxima
// segurança" / "resolve a pendência da transferência automática de
// Pix, atua como especialista" / desenho de subcontas + prioridade
// freelance>fixo + pagamento manual do fixo).
//
// Desenho combinado com o usuário: freelancer confirma a chave Pix toda
// terça (repasse por entrega, ver repasses/gerar_repasse_ao_entregar no
// schema) e é pago toda quarta a partir das 11h; fixo (salário periódico,
// valor_fixo) confirma no dia anterior e é pago na data configurada
// individualmente por entregador (item 110/112). Quem não confirmou a
// chave+tipo (item 116) fica de fora do lote — nunca manda pra chave
// desatualizada/ambígua.
//
// ITEM 118 — duas rotas de pagamento, escolhidas automaticamente por
// tenant:
// - COM subconta Asaas: dinheiro sai do saldo REAL da subconta da
//   própria loja (nunca confia só no webhook — reconfirma via API antes
//   de cada lote, ver consultarSaldoAsaas()). Saldo insuficiente paga
//   quem cabe, priorizando FREELANCER (sem fallback de receber na loja)
//   sobre FIXO (pode ser acertado na mão — ver marcar_pagamento_fixo_manual()
//   no schema, que tira da fila automática assim que a loja confirma).
// - SEM subconta (modelo direto, cada loja com a própria conta/API key):
//   comportamento de sempre, sem orçamento compartilhado — mantido pra
//   não quebrar quem já estivesse usando o modelo anterior.
//
// Pesquisa feita ANTES de codar (nunca adivinhar payload com dinheiro
// real em jogo): Mercado Pago não tem PIX-OUT público pra chave de
// terceiro (stub permanente); Asaas tem (POST /v3/transfers, header
// access_token). GET /v3/finance/balance só devolve o saldo de QUEM
// AUTENTICA — pra saber o saldo de uma subconta específica é obrigatório
// usar a apiKey PRÓPRIA dela (capturada uma vez na criação, cifrada no
// banco), não a chave mestra do GiroCerto. Webhook autentica via header
// "asaas-access-token" (token que O GIROCERTO define, nunca a apiKey da
// Asaas) — ver tratarWebhookAsaas().

'use strict';

/**
 * Tenta transferir um valor via Pix usando o provedor configurado pela
 * loja. Nunca lança exceção — sempre devolve { sucesso, pixTxid, erro }
 * pra quem chamar decidir o que fazer (marcar pago vs. registrar erro).
 */
async function transferirPix({ provider, apiKey, chavePixDestino, chavePixTipo, valor, referenciaExterna }) {
  if (!provider || !apiKey) {
    return { sucesso: false, erro: 'Loja sem provedor de Pix configurado (Integrações → Pix).' };
  }

  switch (provider) {
    case 'mercado_pago':
      return transferirPixMercadoPago(apiKey, chavePixDestino, chavePixTipo, valor, referenciaExterna);
    case 'asaas':
      return transferirPixAsaas(apiKey, chavePixDestino, chavePixTipo, valor, referenciaExterna);
    case 'stone':
      return transferirPixStone(apiKey, chavePixDestino, chavePixTipo, valor, referenciaExterna);
    default:
      return { sucesso: false, erro: `Provedor de Pix desconhecido: ${provider}` };
  }
}

// Confirmado por pesquisa (ver aviso no topo): não existe endpoint
// público de PIX-OUT pra chave de terceiro no Mercado Pago. Ativar isto
// exigiria contato comercial direto — fora do escopo de uma API de
// desenvolvedor pública.
async function transferirPixMercadoPago(_apiKey, _chavePixDestino, _chavePixTipo, _valor, _referenciaExterna) {
  return {
    sucesso: false,
    erro: 'Mercado Pago não expõe endpoint público de envio de Pix pra chave de terceiro (pesquisado em 06/09/2026) — precisa de contato comercial direto com o Mercado Pago pra confirmar alternativa.',
  };
}

// mapa do enum interno (português, ver check constraint em
// pessoas_entregadoras.chave_pix_tipo) pro enum que o Asaas espera.
const TIPO_CHAVE_PIX_ASAAS = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'EMAIL',
  telefone: 'PHONE',
  aleatoria: 'EVP',
};

// Confirmado por pesquisa oficial (docs.asaas.com/reference/
// transferir-para-conta-de-outra-instituicao-ou-chave-pix, 06/09/2026):
// POST /v3/transfers, header "access_token" (NÃO "Authorization:
// Bearer"). Resposta traz "id" (usado como pix_txid) e "status" (pode
// vir PENDING/BANK_PROCESSING mesmo em sucesso — liquidação bancária é
// assíncrona; tratamos resposta 2xx como sucesso pro nosso lado).
async function transferirPixAsaas(apiKey, chavePixDestino, chavePixTipo, valor, referenciaExterna) {
  const tipoAsaas = TIPO_CHAVE_PIX_ASAAS[chavePixTipo];
  if (!tipoAsaas) {
    return { sucesso: false, erro: `Tipo de chave Pix não reconhecido pelo Asaas: "${chavePixTipo}".` };
  }

  let resp;
  try {
    resp = await fetch('https://api.asaas.com/v3/transfers', {
      method: 'POST',
      headers: { 'access_token': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: valor,
        pixAddressKey: chavePixDestino,
        pixAddressKeyType: tipoAsaas,
        externalReference: referenciaExterna,
        description: 'Repasse GiroCerto',
      }),
    });
  } catch (e) {
    return { sucesso: false, erro: 'Falha de rede ao chamar o Asaas: ' + e.message };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { sucesso: false, erro: `Asaas respondeu ${resp.status} sem corpo JSON válido.` };
  }

  if (!resp.ok) {
    const detalhe = Array.isArray(data.errors)
      ? data.errors.map((e) => e.description || e.code).join('; ')
      : JSON.stringify(data);
    return { sucesso: false, erro: `Asaas recusou a transferência (HTTP ${resp.status}): ${detalhe}` };
  }

  return { sucesso: true, pixTxid: data.id };
}

// PENDÊNCIA — Stone não foi pesquisada ainda. Não ativar sem antes
// confirmar endpoint/payload contra a documentação oficial atual.
async function transferirPixStone(_apiKey, _chavePixDestino, _chavePixTipo, _valor, _referenciaExterna) {
  return {
    sucesso: false,
    erro: 'Integração de envio de Pix via Stone ainda não pesquisada/implementada — confirmar endpoint exato contra a documentação oficial atual antes de ativar (dispatch-engine/pagamentos.js).',
  };
}

// ------------------------------------------------------------
// item 118: saldo REAL de uma subconta, direto na API — nunca confiar
// só no webhook/ledger interno antes de soltar dinheiro. Achado da
// pesquisa: só devolve o saldo de quem autentica, por isso recebe a
// apiKey PRÓPRIA da subconta (não a chave mestra do GiroCerto).
// ------------------------------------------------------------
async function consultarSaldoAsaas(apiKeySubconta) {
  try {
    const resp = await fetch('https://api.asaas.com/v3/finance/balance', {
      headers: { 'access_token': apiKeySubconta },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.balance === 'number' ? data.balance : null;
  } catch (e) {
    console.error('[pagamentos] falha ao consultar saldo real da subconta:', e.message);
    return null;
  }
}

/**
 * Processa UM tenant que tem subconta ativa — orçamento limitado ao
 * saldo REAL confirmado na API (nunca o ledger interno sozinho).
 * Prioridade já vem pronta de fila_repasses_por_prioridade() (freelance
 * antes de fixo). Aloca greedily: quem cabe no saldo restante é pago,
 * quem não cabe fica pendente pro próximo ciclo (nunca tudo-ou-nada).
 */
async function processarTenantComSubconta(admin, tenantId, walletId, podeFreelanceHoje) {
  const apiKeySubconta = await admin.rpc('api_key_da_subconta', { p_tenant_id: tenantId }).then((r) => r.data);
  if (!apiKeySubconta) {
    console.error(`[pagamentos] subconta do tenant ${tenantId} sem apiKey registrada — pulando.`);
    return;
  }

  const saldoReal = await consultarSaldoAsaas(apiKeySubconta);
  if (saldoReal === null) {
    // nunca assume saldo se não conseguiu confirmar ao vivo — fail-safe.
    console.error(`[pagamentos] não deu pra confirmar o saldo real da subconta do tenant ${tenantId} — nada pago neste ciclo.`);
    return;
  }

  const { data: fila, error } = await admin.rpc('fila_repasses_por_prioridade', { p_tenant_id: tenantId });
  if (error) {
    console.error(`[pagamentos] falha ao buscar fila do tenant ${tenantId}:`, error.message);
    return;
  }

  let saldoRestante = saldoReal;
  for (const item of (fila || [])) {
    if (item.tipo === 'freelance' && !podeFreelanceHoje) continue; // freelance só quarta 11h+
    if (Number(item.valor) > saldoRestante) continue; // não cabe — fica pendente pro próximo ciclo

    if (item.tipo === 'freelance') {
      await admin.rpc('marcar_tentativa_repasses', { p_repasse_ids: item.repasse_ids });
    } else {
      await admin.rpc('marcar_tentativa_pagamento_fixo', { p_pagamento_id: item.referencia_id });
    }

    const referenciaExterna = `${item.tipo}-${item.referencia_id}-${new Date().toISOString().slice(0, 10)}`;
    const resultado = await transferirPix({
      provider: 'asaas', apiKey: apiKeySubconta, chavePixDestino: item.chave_pix,
      chavePixTipo: item.chave_pix_tipo, valor: item.valor, referenciaExterna,
    });

    if (resultado.sucesso) {
      if (item.tipo === 'freelance') {
        await admin.rpc('marcar_repasses_pagos', { p_repasse_ids: item.repasse_ids, p_pix_txid: resultado.pixTxid });
      } else {
        await admin.rpc('marcar_pagamento_fixo_pago', { p_pagamento_id: item.referencia_id, p_pix_txid: resultado.pixTxid });
      }
      await admin.rpc('debitar_subconta_apos_repasse', { p_tenant_id: tenantId, p_valor: item.valor, p_referencia: resultado.pixTxid });
      saldoRestante -= Number(item.valor);
      console.log(`[pagamentos] (subconta) pago: tenant ${tenantId}, ${item.tipo}, R$ ${item.valor}`);
    } else {
      if (item.tipo === 'freelance') {
        await admin.rpc('marcar_repasses_com_erro', { p_repasse_ids: item.repasse_ids, p_erro: resultado.erro });
      } else {
        await admin.rpc('marcar_pagamento_fixo_erro', { p_pagamento_id: item.referencia_id, p_erro: resultado.erro });
      }
      console.error(`[pagamentos] (subconta) falha ao pagar tenant ${tenantId}, ${item.tipo}: ${resultado.erro}`);
    }
  }
}

/**
 * Modelo antigo (item 109/111) — tenant SEM subconta, cada loja com a
 * própria conta/API key, sem orçamento compartilhado (tenta todo mundo
 * pronto, cada transferência falha/sucede independente).
 */
async function executarLoteFreelanceSemSubconta(admin, tenantIdsComSubconta) {
  const { data: prontos, error } = await admin.rpc('repasses_freelance_prontos_para_pagar');
  if (error) {
    console.error('[pagamentos] falha ao buscar repasses freelance prontos:', error.message);
    return;
  }
  for (const item of prontos || []) {
    if (tenantIdsComSubconta.has(item.tenant_id)) continue; // já tratado pela rota de subconta
    await admin.rpc('marcar_tentativa_repasses', { p_repasse_ids: item.repasse_ids });

    const { pix_provider: provider, pix_provider_api_key: apiKey } = await credenciaisDoTenant(admin, item.tenant_id);
    const referenciaExterna = `freelance-${item.pessoa_id}-${item.tenant_id}-${new Date().toISOString().slice(0, 10)}`;
    const resultado = await transferirPix({
      provider, apiKey, chavePixDestino: item.chave_pix, chavePixTipo: item.chave_pix_tipo,
      valor: item.valor_total, referenciaExterna,
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

async function executarLoteFixoSemSubconta(admin, tenantIdsComSubconta) {
  const { data: prontos, error } = await admin.rpc('pagamentos_fixos_prontos_para_pagar');
  if (error) {
    console.error('[pagamentos] falha ao buscar pagamentos fixos prontos:', error.message);
    return;
  }
  for (const item of prontos || []) {
    if (tenantIdsComSubconta.has(item.tenant_id)) continue; // já tratado pela rota de subconta
    await admin.rpc('marcar_tentativa_pagamento_fixo', { p_pagamento_id: item.pagamento_id });

    const { pix_provider: provider, pix_provider_api_key: apiKey } = await credenciaisDoTenant(admin, item.tenant_id);
    const referenciaExterna = `fixo-${item.pagamento_id}`;
    const resultado = await transferirPix({
      provider, apiKey, chavePixDestino: item.chave_pix, chavePixTipo: item.chave_pix_tipo,
      valor: item.valor, referenciaExterna,
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
 * Checagem periódica (chamada a cada poucos minutos pelo index.js).
 * Gera os pagamentos fixos do dia uma vez, processa tenants COM
 * subconta (orçamento real, prioridade freelance>fixo) e depois os SEM
 * subconta (modelo antigo, sem orçamento compartilhado).
 */
async function verificarRepassesAutomaticos(admin) {
  const agora = new Date();
  const podeFreelanceHoje = agora.getDay() === 3 && agora.getHours() >= 11; // quarta, a partir das 11h

  const { error: erroGerar } = await admin.rpc('gerar_pagamentos_fixos_do_dia');
  if (erroGerar) console.error('[pagamentos] falha ao gerar pagamentos fixos do dia:', erroGerar.message);

  const { data: comSubconta, error: erroSubcontas } = await admin.rpc('tenants_com_subconta_ativa');
  if (erroSubcontas) console.error('[pagamentos] falha ao listar subcontas ativas:', erroSubcontas.message);

  for (const s of comSubconta || []) {
    await processarTenantComSubconta(admin, s.tenant_id, s.wallet_id, podeFreelanceHoje)
      .catch((e) => console.error(`[pagamentos] erro processando subconta do tenant ${s.tenant_id}:`, e.message));
  }

  const tenantIdsComSubconta = new Set((comSubconta || []).map((s) => s.tenant_id));
  if (podeFreelanceHoje) {
    await executarLoteFreelanceSemSubconta(admin, tenantIdsComSubconta).catch((e) => console.error('[pagamentos] erro no lote freelance (sem subconta):', e.message));
  }
  await executarLoteFixoSemSubconta(admin, tenantIdsComSubconta).catch((e) => console.error('[pagamentos] erro no lote fixo (sem subconta):', e.message));
}

// ------------------------------------------------------------
// item 118: webhook da Asaas — confirma DEPÓSITO na subconta ANTES do
// motor liberar qualquer pagamento (ver processarTenantComSubconta(),
// que também reconfirma o saldo ao vivo — o webhook só acelera a
// atualização do ledger interno pra exibição, nunca é a ÚNICA checagem
// antes de soltar dinheiro).
// ------------------------------------------------------------
class ErroWebhook extends Error {
  constructor(mensagem, codigoHttp) {
    super(mensagem);
    this.codigoHttp = codigoHttp;
  }
}

async function tratarWebhookAsaas(admin, walletId, tokenRecebido, body) {
  const { data: tenantId, error } = await admin.rpc('verificar_webhook_subconta', {
    p_wallet_id: walletId, p_token_recebido: tokenRecebido || null,
  });
  if (error) {
    throw new ErroWebhook('falha ao validar webhook: ' + error.message, 500);
  }
  if (!tenantId) {
    // achado real possível: token errado/ausente — pode ser tentativa de
    // forjar um "recebi o Pix" falso. Nunca processa sem validar.
    console.error(`[webhook-asaas] token inválido/ausente pro wallet ${walletId} — rejeitado.`);
    throw new ErroWebhook('token de webhook inválido', 401);
  }

  if (!body || body.event !== 'PAYMENT_RECEIVED') {
    return; // evento que não é depósito confirmado — ignora, responde 200 mesmo assim
  }

  const valor = body.payment && body.payment.value;
  const referencia = body.payment && body.payment.id;
  if (typeof valor !== 'number' || !referencia) {
    console.error(`[webhook-asaas] payload PAYMENT_RECEIVED sem value/id válidos (wallet ${walletId}).`);
    return;
  }

  const { error: erroRegistrar } = await admin.rpc('registrar_deposito_subconta', {
    p_tenant_id: tenantId, p_valor: valor, p_referencia: referencia,
  });
  if (erroRegistrar) {
    console.error(`[webhook-asaas] falha ao registrar depósito (tenant ${tenantId}):`, erroRegistrar.message);
    throw new ErroWebhook('falha ao registrar depósito', 500);
  }
  console.log(`[webhook-asaas] depósito confirmado: tenant ${tenantId}, R$ ${valor}`);
}

module.exports = {
  transferirPix, verificarRepassesAutomaticos, tratarWebhookAsaas, consultarSaldoAsaas,
  processarTenantComSubconta, // exportada pra teste determinístico (evita depender do dia/hora real, ver tests/webhook_asaas.test.js)
};
