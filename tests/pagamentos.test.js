// Testa dispatch-engine/pagamentos.js (item 116, 06/09/2026) — a
// construção do request/parsing da resposta de transferirPixAsaas()
// contra o contrato documentado oficialmente em docs.asaas.com,
// usando um fetch mockado. NUNCA chama a API de verdade (sem
// credencial real neste projeto) — o valor deste teste é garantir que
// o payload que MANDAMOS bate exatamente com o que o Asaas espera
// (header access_token, não Authorization: Bearer; pixAddressKeyType
// no enum certo), e que erros/tipos desconhecidos NUNCA disparam uma
// chamada de rede (falha segura antes de arriscar dinheiro real).
const path = require('path');
const { transferirPix } = require(path.join('..', 'dispatch-engine', 'pagamentos.js'));
const { makeReporter } = require('./lib/helpers');

let ultimaChamada = null;
function mockFetch(respostaSimulada) {
  global.fetch = async (url, opts) => {
    ultimaChamada = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: respostaSimulada.status >= 200 && respostaSimulada.status < 300,
      status: respostaSimulada.status,
      json: async () => respostaSimulada.body,
    };
  };
}

async function run() {
  const r = makeReporter('pagamentos');
  const fetchOriginal = global.fetch;

  try {
    console.log('\n=== Asaas: payload e resposta de sucesso batem com a doc oficial ===');
    mockFetch({ status: 200, body: { id: 'tra_000123456', status: 'PENDING', value: 27.5 } });
    const r1 = await transferirPix({
      provider: 'asaas', apiKey: 'CHAVE-TESTE-FAKE', chavePixDestino: 'joao@teste.com',
      chavePixTipo: 'email', valor: 27.5, referenciaExterna: 'freelance-abc-def-2026-09-10',
    });
    r.check('URL correta (POST /v3/transfers)', ultimaChamada.url === 'https://api.asaas.com/v3/transfers', ultimaChamada.url);
    r.check('método POST', ultimaChamada.opts.method === 'POST', ultimaChamada.opts.method);
    r.check('header access_token (achado real: Asaas NÃO usa Authorization: Bearer)', ultimaChamada.opts.headers.access_token === 'CHAVE-TESTE-FAKE', ultimaChamada.opts.headers);
    r.check('header Authorization NÃO foi usado por engano', !ultimaChamada.opts.headers.Authorization, ultimaChamada.opts.headers);
    r.check('body.value correto', ultimaChamada.body.value === 27.5, ultimaChamada.body);
    r.check('body.pixAddressKey correto', ultimaChamada.body.pixAddressKey === 'joao@teste.com', ultimaChamada.body);
    r.check('body.pixAddressKeyType mapeado email->EMAIL', ultimaChamada.body.pixAddressKeyType === 'EMAIL', ultimaChamada.body);
    r.check('body.externalReference propagado (concilia com nosso repasse/pagamento)', ultimaChamada.body.externalReference === 'freelance-abc-def-2026-09-10', ultimaChamada.body);
    r.check('resultado.sucesso = true', r1.sucesso === true, r1);
    r.check('resultado.pixTxid = id devolvido pelo Asaas', r1.pixTxid === 'tra_000123456', r1);

    console.log('\n=== mapeamento dos 5 tipos internos de chave Pix -> enum do Asaas ===');
    const casos = [['cpf', 'CPF'], ['cnpj', 'CNPJ'], ['email', 'EMAIL'], ['telefone', 'PHONE'], ['aleatoria', 'EVP']];
    for (const [interno, esperado] of casos) {
      mockFetch({ status: 200, body: { id: 'tra_x' } });
      await transferirPix({ provider: 'asaas', apiKey: 'k', chavePixDestino: 'x', chavePixTipo: interno, valor: 1, referenciaExterna: 'ref' });
      r.check(`chave_pix_tipo='${interno}' -> pixAddressKeyType='${esperado}'`, ultimaChamada.body.pixAddressKeyType === esperado, ultimaChamada.body.pixAddressKeyType);
    }

    console.log('\n=== tipo de chave desconhecido: falha limpa, NUNCA chama a API (nunca adivinha) ===');
    ultimaChamada = null;
    const r2 = await transferirPix({ provider: 'asaas', apiKey: 'k', chavePixDestino: 'x', chavePixTipo: 'bitcoin', valor: 1, referenciaExterna: 'ref' });
    r.check('sucesso = false pra tipo não reconhecido', r2.sucesso === false, r2);
    r.check('NUNCA chamou fetch (falha segura antes de arriscar dinheiro)', ultimaChamada === null, ultimaChamada);

    console.log('\n=== erro HTTP do Asaas é mapeado corretamente pro nosso formato ===');
    mockFetch({ status: 400, body: { errors: [{ code: 'invalid_pixAddressKey', description: 'Chave Pix inválida.' }] } });
    const r3 = await transferirPix({ provider: 'asaas', apiKey: 'k', chavePixDestino: 'chave-invalida', chavePixTipo: 'email', valor: 1, referenciaExterna: 'ref' });
    r.check('sucesso = false em erro HTTP', r3.sucesso === false, r3);
    r.check('mensagem de erro inclui a descrição real do Asaas', r3.erro.includes('Chave Pix inválida'), r3.erro);

    console.log('\n=== Mercado Pago e Stone continuam stub seguro (pesquisa confirmou: MP não tem PIX-OUT público; Stone não pesquisada ainda) ===');
    ultimaChamada = null;
    const r4 = await transferirPix({ provider: 'mercado_pago', apiKey: 'k', chavePixDestino: 'x', chavePixTipo: 'cpf', valor: 1, referenciaExterna: 'ref' });
    r.check('mercado_pago: sucesso=false, nunca chama fetch (nenhum endpoint público confirmado)', r4.sucesso === false && ultimaChamada === null, { r4, ultimaChamada });
    const r5 = await transferirPix({ provider: 'stone', apiKey: 'k', chavePixDestino: 'x', chavePixTipo: 'cpf', valor: 1, referenciaExterna: 'ref' });
    r.check('stone: sucesso=false, nunca chama fetch (não pesquisada ainda)', r5.sucesso === false && ultimaChamada === null, { r5, ultimaChamada });

    return r.summary();
  } finally {
    global.fetch = fetchOriginal;
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
