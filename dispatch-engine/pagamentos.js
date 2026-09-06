// Motor de repasse automático via Pix (item 109-116, 05-06/09/2026,
// pedido direto do usuário: "máxima integração possível, com máxima
// segurança" / "resolve a pendência da transferência automática de
// Pix, atua como especialista").
//
// Desenho combinado com o usuário: freelancer confirma a chave Pix toda
// terça (repasse por entrega, ver repasses/gerar_repasse_ao_entregar no
// schema) e é pago toda quarta a partir das 11h; fixo (salário periódico,
// valor_fixo) confirma no dia anterior e é pago na data que a PRÓPRIA
// LOJA escolheu (item 110/112: fim de turno/semanal/mensal/quinzenal,
// por entregador individual). Quem não confirmou a chave (ou não
// declarou o TIPO dela, item 116) fica de fora do lote daquele ciclo —
// nunca manda pra chave desatualizada/ambígua.
//
// Toda a seleção "quem pagar, quanto, com qual chave" e as travas contra
// pagamento duplicado (unique(entregador_id, referencia_data) em
// pagamentos_fixos; status='pendente' em repasses; janela de 10min de
// tentativa_transferencia_em, item 116) vivem no Postgres — ver ITEM
// 111/116 no schema.sql. Este módulo só chama essas funções e faz a
// ÚNICA parte que só pode ser feita em Node: a chamada HTTP de verdade
// pro provedor de Pix.
//
// ITEM 116 — pesquisa feita ANTES de escrever qualquer chamada real
// (nunca adivinhar payload com dinheiro real em jogo):
// - Mercado Pago NÃO tem endpoint público de envio de Pix pra chave de
//   terceiro. O único mecanismo de "saída de dinheiro" documentado
//   (POST /v1/advanced_payments/{id}/disburses) divide um pagamento JÁ
//   recebido entre outras CONTAS Mercado Pago — não aceita uma chave
//   Pix solta de alguém sem conta no MP. Continua como stub.
// - Asaas TEM, documentado oficialmente: POST /v3/transfers, header
//   "access_token" (não "Authorization: Bearer"), payload
//   {value, pixAddressKey, pixAddressKeyType, externalReference}.
//   Implementado abaixo. Pré-requisito de conta (da própria doc): só
//   funciona depois da conta 100% aprovada + prova de vida feita.
// - Stone: não pesquisada ainda — continua como stub.
// - Achado no caminho: nenhum provedor documenta idempotency key. A
//   trava de 10min (tentativa_transferencia_em) é a mitigação: se o
//   processo cair entre a chamada HTTP e marcar o resultado, o item só
//   volta a ser elegível depois da janela, dando tempo da 1ª tentativa
//   resolver (sucesso ou erro) do lado do provedor antes de qualquer
//   novo envio.

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
// público de PIX-OUT pra chave arbitrária no Mercado Pago. Ativar isto
// exigiria contato comercial direto com o Mercado Pago pra confirmar se
// existe um produto bancário/enterprise separado — fora do que a API de
// desenvolvedor pública oferece hoje.
async function transferirPixMercadoPago(_apiKey, _chavePixDestino, _chavePixTipo, _valor, _referenciaExterna) {
  return {
    sucesso: false,
    erro: 'Mercado Pago não expõe endpoint público de envio de Pix pra chave de terceiro (pesquisado em 06/09/2026) — precisa de contato comercial direto com o Mercado Pago pra confirmar alternativa.',
  };
}

// mapa do enum interno (português, ver check constraint em
// pessoas_entregadoras.chave_pix_tipo) pro enum que o Asaas espera —
// nomes em inglês, maiúsculo, "aleatoria" vira "EVP" (nome oficial do
// Banco Central pra chave aleatória, "Endereçamento a Valor por chave
// Pix").
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
// Bearer" — erro comum entre APIs brasileiras de pagamento, cada uma
// tem seu próprio esquema). Resposta de sucesso traz "id" (usado como
// pix_txid) e "status" (pode vir PENDING/BANK_PROCESSING mesmo em
// sucesso — o valor já saiu da fila do Asaas, mas a liquidação bancária
// em si é assíncrona; tratamos a resposta 2xx como sucesso pro nosso
// lado, e status final fica pro webhook de conciliação, ainda não
// construído — ver pendência no CLAUDE.md).
async function transferirPixAsaas(apiKey, chavePixDestino, chavePixTipo, valor, referenciaExterna) {
  const tipoAsaas = TIPO_CHAVE_PIX_ASAAS[chavePixTipo];
  if (!tipoAsaas) {
    return { sucesso: false, erro: `Tipo de chave Pix não reconhecido pelo Asaas: "${chavePixTipo}".` };
  }

  let resp;
  try {
    resp = await fetch('https://api.asaas.com/v3/transfers', {
      method: 'POST',
      headers: {
        'access_token': apiKey,
        'Content-Type': 'application/json',
      },
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

// PENDÊNCIA — Stone não foi pesquisada ainda (fora do escopo da
// pesquisa de 06/09/2026, que priorizou Mercado Pago e Asaas). Não
// ativar sem antes confirmar endpoint/payload contra a documentação
// oficial atual da Stone.
async function transferirPixStone(_apiKey, _chavePixDestino, _chavePixTipo, _valor, _referenciaExterna) {
  return {
    sucesso: false,
    erro: 'Integração de envio de Pix via Stone ainda não pesquisada/implementada — confirmar endpoint exato contra a documentação oficial atual antes de ativar (dispatch-engine/pagamentos.js).',
  };
}

/**
 * Roda o lote de repasse dos FREELANCERS — repasses_freelance_prontos_para_pagar()
 * já filtra por status='pendente', chave+tipo confirmados nos últimos 2
 * dias, e fora da janela de 10min de tentativa recente (item 116).
 * Idempotente por construção: quem já foi pago não aparece de novo na
 * próxima chamada (status vira 'pago').
 */
async function executarLoteFreelance(admin) {
  const { data: prontos, error } = await admin.rpc('repasses_freelance_prontos_para_pagar');
  if (error) {
    console.error('[pagamentos] falha ao buscar repasses freelance prontos:', error.message);
    return;
  }
  for (const item of prontos || []) {
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

/**
 * Roda o lote de pagamento do FIXO — gera as linhas pendentes de hoje
 * (idempotente via unique(entregador_id, referencia_data)) e processa
 * as que estão prontas (chave+tipo confirmados, fora da janela de
 * tentativa recente).
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
 * Checagem periódica (chamada a cada poucos minutos pelo index.js) —
 * freelance só roda quarta a partir das 11h; fixo roda todo dia (a
 * seleção em si já filtra pela política de cada entregador, ver
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
