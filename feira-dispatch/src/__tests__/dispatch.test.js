'use strict';

// Teste manual sem framework — rode com: node src/__tests__/dispatch.test.js
const { otimizarRota, sequenciaValida } = require('../routeOptimizer');
const { encontrarMelhorInsercao } = require('../insertionEngine');
const { distanciaKm } = require('../geo');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

// ---------------------------------------------------------------------
// Cenário 1: feira com 3 feirantes, 1 consumidor comprando dos 3
// ---------------------------------------------------------------------
const posicaoEntregador = { latitude: -23.5010, longitude: -46.6200 };

const paradasFeira = [
  { id: 'c1', tipo: 'coleta', pedidoId: 'p1', pedidoGrupoId: 'g1', latitude: -23.5020, longitude: -46.6210 },
  { id: 'c2', tipo: 'coleta', pedidoId: 'p2', pedidoGrupoId: 'g1', latitude: -23.5015, longitude: -46.6195 },
  { id: 'c3', tipo: 'coleta', pedidoId: 'p3', pedidoGrupoId: 'g1', latitude: -23.5025, longitude: -46.6205 },
  { id: 'e1', tipo: 'entrega', pedidoGrupoId: 'g1', latitude: -23.5100, longitude: -46.6300 },
];

const { sequencia, distanciaKm: distTotal } = otimizarRota(paradasFeira, posicaoEntregador);

assert(sequencia.length === 4, 'sequência otimizada retorna todas as 4 paradas');
assert(sequenciaValida(sequencia), 'sequência respeita coleta-antes-de-entrega');
assert(
  sequencia[sequencia.length - 1].tipo === 'entrega',
  'entrega é a última parada (único dropoff do grupo)'
);
console.log(`   distância total otimizada: ${distTotal.toFixed(2)}km`);

// ---------------------------------------------------------------------
// Cenário 2: inserção de novo pedido numa rota existente vs. limite de peso
// ---------------------------------------------------------------------
const config = { pesoMaxKg: 15, maxParadas: 5, maxDetourPct: 0.4 };

const rotaExistente = {
  entregaRotaId: 'rota-1',
  tipoPerfil: 'feira',
  tipoVeiculo: 'moto',
  pesoTotalAtual: 10,
  posicaoEntregador,
  paradasAtuais: [
    { id: 'c1', tipo: 'coleta', pedidoId: 'p1', pedidoGrupoId: 'g1', latitude: -23.502, longitude: -46.621 },
    { id: 'e1', tipo: 'entrega', pedidoGrupoId: 'g1', latitude: -23.510, longitude: -46.630 },
  ],
};

const pedidoLeve = {
  pedidoGrupoId: 'g2',
  tipoPerfil: 'feira',
  pesoTotal: 3, // 10 + 3 = 13kg, dentro do limite de 15kg
  paradasColeta: [{ pedidoId: 'p4', pedidoGrupoId: 'g2', latitude: -23.503, longitude: -46.622 }],
  paradaEntrega: { pedidoGrupoId: 'g2', latitude: -23.511, longitude: -46.631 },
};

const pedidoPesado = {
  ...pedidoLeve,
  pedidoGrupoId: 'g3',
  pesoTotal: 8, // 10 + 8 = 18kg, ULTRAPASSA o limite de 15kg
};

const resultadoLeve = encontrarMelhorInsercao(pedidoLeve, [rotaExistente], config);
assert(resultadoLeve !== null, 'pedido leve (13kg total) é aceito na rota existente');

const resultadoPesado = encontrarMelhorInsercao(pedidoPesado, [rotaExistente], config);
assert(resultadoPesado === null, 'pedido pesado (18kg total) é REJEITADO por exceder 15kg');

// ---------------------------------------------------------------------
// Cenário 3: distância sanity-check (haversine)
// ---------------------------------------------------------------------
const d = distanciaKm(
  { latitude: -23.5505, longitude: -46.6333 }, // Praça da Sé, SP
  { latitude: -23.5613, longitude: -46.6565 }  // Av. Paulista, SP
);
assert(d > 2 && d < 4, `distância Sé -> Paulista plausível (calculada: ${d.toFixed(2)}km)`);

console.log('\nTestes concluídos.');
