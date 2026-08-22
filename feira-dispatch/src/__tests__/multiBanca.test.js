'use strict';

const { calcularTaxaJusta } = require('../feeCalculator');
const { agruparParadasMesmoLocal } = require('../stopGrouping');
const { otimizarRota, sequenciaValida } = require('../routeOptimizer');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

const enderecoRenata = { latitude: -23.5100, longitude: -46.6300 };

// ---------------------------------------------------------------------
// Cenário 1: Renata compra em 2 bancas espalhadas (nenhuma perto da outra)
// ---------------------------------------------------------------------
console.log('\n--- Renata: 2 bancas ---');
const bancas2 = [
  { estabelecimentoId: 'banca-hortalicas', latitude: -23.5000, longitude: -46.6200 },
  { estabelecimentoId: 'banca-queijos', latitude: -23.5040, longitude: -46.6250 },
];

const taxa2 = calcularTaxaJusta(bancas2, enderecoRenata);
console.log(taxa2);
assert(taxa2.detalhamento.qtdBancas === 2, '2 bancas contabilizadas na taxa');
assert(taxa2.taxaFinal > 0, 'taxa calculada com sucesso pra 2 bancas');

// ---------------------------------------------------------------------
// Cenário 2: Renata compra em 3 bancas espalhadas pela feira
// ---------------------------------------------------------------------
console.log('\n--- Renata: 3 bancas ---');
const bancas3 = [
  { estabelecimentoId: 'banca-hortalicas', latitude: -23.5000, longitude: -46.6200 },
  { estabelecimentoId: 'banca-queijos', latitude: -23.5040, longitude: -46.6250 },
  { estabelecimentoId: 'banca-peixes', latitude: -23.5015, longitude: -46.6280 },
];

const taxa3 = calcularTaxaJusta(bancas3, enderecoRenata);
console.log(taxa3);
assert(taxa3.detalhamento.qtdBancas === 3, '3 bancas contabilizadas na taxa');
assert(
  taxa3.taxaFinal > taxa2.taxaFinal,
  'taxa de 3 bancas é maior que a de 2 (mais manuseio + mais deslocamento)'
);
assert(
  taxa3.sequenciaColeta.length === 3,
  'rota otimizada visita as 3 bancas antes de seguir pra entrega'
);

// ---------------------------------------------------------------------
// Cenário 3: montar a rota completa (3 coletas + 1 entrega) e verificar
// que a sequência sempre respeita coleta-antes-de-entrega
// ---------------------------------------------------------------------
console.log('\n--- Renata: sequência completa da rota ---');
const paradasRenata = [
  ...bancas3.map((b, idx) => ({
    id: `c${idx}`,
    tipo: 'coleta',
    pedidoId: `pedido-renata-${b.estabelecimentoId}`,
    pedidoGrupoId: 'grupo-renata',
    local: b.estabelecimentoId,
    latitude: b.latitude,
    longitude: b.longitude,
  })),
  {
    id: 'entrega-renata',
    tipo: 'entrega',
    pedidoGrupoId: 'grupo-renata',
    latitude: enderecoRenata.latitude,
    longitude: enderecoRenata.longitude,
  },
];

const { sequencia } = otimizarRota(paradasRenata, bancas3[0]);
assert(sequenciaValida(sequencia), 'sequência com 3 coletas do mesmo cliente respeita coleta-antes-de-entrega');
assert(sequencia[sequencia.length - 1].tipo === 'entrega', 'entrega é sempre a última parada');
assert(
  sequencia.filter((p) => p.tipo === 'coleta').length === 3,
  'as 3 bancas aparecem como paradas de coleta distintas'
);

// ---------------------------------------------------------------------
// Cenário 4: e se 2 das 3 bancas da Renata ficarem perto uma da outra?
// (mesmo cliente, mesmo pedido_grupo — o agrupador não distingue por
// cliente, só por local físico, então ele consolida do mesmo jeito)
// ---------------------------------------------------------------------
console.log('\n--- Renata: 2 das 3 bancas ficam vizinhas entre si ---');
const paradasComVizinhas = [
  { id: 'c0', tipo: 'coleta', pedidoId: 'pedido-renata-A', pedidoGrupoId: 'grupo-renata',
    local: 'Banca A', codigoTicket: 'R1AA', clienteNome: 'Renata',
    latitude: -23.5000, longitude: -46.6200 },
  // banca B fica a poucos metros da banca A
  { id: 'c1', tipo: 'coleta', pedidoId: 'pedido-renata-B', pedidoGrupoId: 'grupo-renata',
    local: 'Banca B', codigoTicket: 'R2BB', clienteNome: 'Renata',
    latitude: -23.50001, longitude: -46.62001 },
  { id: 'c2', tipo: 'coleta', pedidoId: 'pedido-renata-C', pedidoGrupoId: 'grupo-renata',
    local: 'Banca C', codigoTicket: 'R3CC', clienteNome: 'Renata',
    latitude: -23.5040, longitude: -46.6280 },
  { id: 'e0', tipo: 'entrega', pedidoGrupoId: 'grupo-renata',
    latitude: enderecoRenata.latitude, longitude: enderecoRenata.longitude },
];

const agrupadas = agruparParadasMesmoLocal(paradasComVizinhas);
const consolidadas = agrupadas.filter((p) => p.tipo === 'coleta_consolidada');
const simples = agrupadas.filter((p) => p.tipo === 'coleta');

assert(
  consolidadas.length === 1 && consolidadas[0].pedidos.length === 2,
  'mesmo sendo a mesma cliente, bancas A e B (vizinhas) viram 1 parada com 2 tickets — economiza uma parada física'
);
assert(simples.length === 1, 'banca C, mais distante, continua como parada separada');
assert(agrupadas.length === 3, 'total: 3 paradas físicas (A+B consolidada, C, entrega) em vez de 4');

console.log('\nTestes de múltiplas bancas (mesmo cliente) concluídos.');
