'use strict';

const { calcularTaxaJusta } = require('../feeCalculator');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

const enderecoEntrega = { latitude: -23.510, longitude: -46.630 };

// ---------------------------------------------------------------------
// Cenário A: 3 bancas praticamente vizinhas (~10m entre elas)
// ---------------------------------------------------------------------
const bancasVizinhas = [
  { estabelecimentoId: 'f1', latitude: -23.5020, longitude: -46.6210 },
  { estabelecimentoId: 'f2', latitude: -23.50201, longitude: -46.62101 },
  { estabelecimentoId: 'f3', latitude: -23.50202, longitude: -46.62102 },
];

const resultadoVizinhas = calcularTaxaJusta(bancasVizinhas, enderecoEntrega);
console.log('\n--- Cenário A: bancas vizinhas ---');
console.log(resultadoVizinhas);

assert(
  resultadoVizinhas.detalhamento.trechoAPeKm < 0.05,
  'bancas vizinhas geram trecho a pé quase zero'
);
assert(
  resultadoVizinhas.detalhamento.custoManuseio === 3.6,
  'custo de manuseio fixo (3 bancas x R$1,20) aplicado mesmo com bancas coladas'
);

// ---------------------------------------------------------------------
// Cenário B: 3 bancas espalhadas pela feira (~150-300m entre elas)
// ---------------------------------------------------------------------
const bancasEspalhadas = [
  { estabelecimentoId: 'f1', latitude: -23.5000, longitude: -46.6200 },
  { estabelecimentoId: 'f2', latitude: -23.5020, longitude: -46.6230 },
  { estabelecimentoId: 'f3', latitude: -23.5045, longitude: -46.6180 },
];

const resultadoEspalhadas = calcularTaxaJusta(bancasEspalhadas, enderecoEntrega);
console.log('\n--- Cenário B: bancas espalhadas ---');
console.log(resultadoEspalhadas);

assert(
  resultadoEspalhadas.detalhamento.trechoAPeKm > 0.3,
  'bancas espalhadas geram trecho a pé significativo'
);
assert(
  resultadoEspalhadas.taxaFinal > resultadoVizinhas.taxaFinal,
  'taxa de bancas espalhadas é maior que a de bancas vizinhas (justiça de distância real)'
);

// ---------------------------------------------------------------------
// Cenário C: 1 banca só, bem perto do endereço — deve respeitar o piso mínimo
// ---------------------------------------------------------------------
const umaBancaPerto = [{ estabelecimentoId: 'f1', latitude: -23.5099, longitude: -46.6299 }];
const resultadoPiso = calcularTaxaJusta(umaBancaPerto, enderecoEntrega);
console.log('\n--- Cenário C: 1 banca perto do cliente ---');
console.log(resultadoPiso);

assert(resultadoPiso.taxaFinal >= 6.0, 'taxa nunca fica abaixo do piso mínimo de R$6,00');

console.log('\nTestes de taxa concluídos.');
