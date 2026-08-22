'use strict';

const {
  calcularPisoRegulatorio,
  aplicarPisoRegulatorio,
  calcularCompensacaoEspera,
} = require('../regulatoryCompliance');
const { calcularTaxaJusta } = require('../feeCalculator');
const { priorizarOfertaJusta } = require('../fairRotation');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

// =======================================================================
// 1. Piso regulatório (PL 2479/25): R$10 até 4km + R$2,50/km excedente
// =======================================================================
console.log('--- Piso regulatório ---');

assert(calcularPisoRegulatorio(2) === 10, 'até 4km, piso é sempre R$10 fixo (testado com 2km)');
assert(calcularPisoRegulatorio(4) === 10, 'exatamente 4km ainda é R$10');
assert(
  calcularPisoRegulatorio(6) === 15,
  '6km = R$10 + 2km excedente × R$2,50 = R$15'
);

// caso real: banca perto do cliente, taxa calculada por componentes é
// baixa (ex: R$6 do piso antigo) — o piso regulatório precisa subir isso
const bancaPerto = { estabelecimentoId: 'b1', latitude: -23.5000, longitude: -46.6200 };
const enderecoPerto = { latitude: -23.5020, longitude: -46.6220 };
const resultadoBaixo = calcularTaxaJusta([bancaPerto], enderecoPerto);
console.log('Taxa calculada por componentes (sem piso regulatório):', resultadoBaixo.taxaFinal);

const resultadoComPiso = aplicarPisoRegulatorio(resultadoBaixo);
console.log('Taxa após aplicar piso regulatório:', resultadoComPiso.taxaFinal);
assert(
  resultadoComPiso.taxaFinal >= 10,
  'taxa final nunca fica abaixo de R$10, mesmo pra distância curta (alinhado ao PL 2479/25)'
);
assert(
  resultadoComPiso.detalhamento.aplicouPisoRegulatorio === true,
  'detalhamento sinaliza que o piso regulatório foi o que decidiu o valor final'
);

// caso de distância muito longa: componentes reais (manuseio+km) devem
// superar o piso regulatório — testado com trecho maior de verdade
const bancaLonge = { estabelecimentoId: 'b2', latitude: -23.5000, longitude: -46.6200 };
const enderecoLonge = { latitude: -23.6200, longitude: -46.7600 }; // ~18km reais
const resultadoAlto = calcularTaxaJusta([bancaLonge], enderecoLonge);
const resultadoAltoComPiso = aplicarPisoRegulatorio(resultadoAlto);
console.log('Taxa longa, antes/depois do piso:', resultadoAlto.taxaFinal, resultadoAltoComPiso.taxaFinal);
assert(
  resultadoAltoComPiso.taxaFinal >= resultadoAlto.taxaFinal,
  'em qualquer distância, o piso NUNCA reduz a taxa — só pode manter ou subir'
);
console.log(
  'Achado real: como valorKmMoto (R$1,80) < valorKmAdicional regulatório (R$2,50), ' +
    'o piso regulatório tende a dominar mesmo em distâncias longas — sinal de que ' +
    'nossa taxa por km pode estar abaixo do que a regulação em tramitação vai exigir.'
);

// =======================================================================
// 2. Compensação por tempo de espera (R$0,60/min)
// =======================================================================
console.log('\n--- Compensação por tempo de espera ---');

assert(
  calcularCompensacaoEspera(0) === 0,
  'sem espera, sem compensação'
);
assert(
  calcularCompensacaoEspera(300) === 3,
  '5 minutos de espera (300s) = R$3,00 (5 × R$0,60)'
);
assert(
  calcularCompensacaoEspera(600) === 6,
  '10 minutos de espera = R$6,00 — feirante que demora pra confirmar Pix agora custa pro sistema, não só pro entregador'
);

// =======================================================================
// 3. Rodízio justo — bike ociosa é priorizada sobre consolidar em moto
// =======================================================================
console.log('\n--- Rodízio justo (bike vs. moto) ---');

const pedidoPequeno = {
  pedidoGrupoId: 'g1',
  tipoPerfil: 'feira',
  pesoTotal: 3,
  paradasColeta: [{ pedidoId: 'p1', pedidoGrupoId: 'g1', latitude: -23.5000, longitude: -46.6200 }],
  paradaEntrega: { pedidoGrupoId: 'g1', latitude: -23.5010, longitude: -46.6210 }, // bem perto
};

const bikeOciosaPerto = [
  { entregadorId: 'bike-1', latitude: -23.5005, longitude: -46.6205 }, // ~0,07km da coleta
];

const decisaoComBike = priorizarOfertaJusta(pedidoPequeno, bikeOciosaPerto);
console.log(decisaoComBike);
assert(
  decisaoComBike.estrategia === 'ofertar_bike_ociosa',
  'com bike ociosa elegível por perto, o pedido é oferecido a ela ANTES de consolidar em moto'
);
assert(decisaoComBike.destino.entregadorId === 'bike-1', 'a bike específica correta é identificada');

// sem bike disponível — segue fluxo normal (motor de inserção decide)
const decisaoSemBike = priorizarOfertaJusta(pedidoPequeno, []);
assert(
  decisaoSemBike.estrategia === 'seguir_fluxo_normal',
  'sem bike ociosa no momento, segue pro motor de inserção normal (pode consolidar em moto)'
);

// bike existe mas está longe demais (fora do raio de 0,8km de coleta)
const bikeLonge = [{ entregadorId: 'bike-2', latitude: -23.5200, longitude: -46.6500 }];
const decisaoBikeLonge = priorizarOfertaJusta(pedidoPequeno, bikeLonge);
assert(
  decisaoBikeLonge.estrategia === 'seguir_fluxo_normal',
  'bike existe mas está fora do raio dela — não força uma corrida inviável, cai pro fluxo normal'
);

console.log('\nTestes das melhorias da ultra-análise concluídos.');
