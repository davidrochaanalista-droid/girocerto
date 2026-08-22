'use strict';

const { agruparParadasMesmoLocal, coletaConsolidadaCompleta } = require('../stopGrouping');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

// ---------------------------------------------------------------------
// Cenário exato do problema: Maria compra em A e B; Flávia compra só em B
// ---------------------------------------------------------------------
const bancaA = { latitude: -23.5010, longitude: -46.6200 };
const bancaB = { latitude: -23.5030, longitude: -46.6220 };
const enderecoMaria = { latitude: -23.5100, longitude: -46.6300 };
const enderecoFlavia = { latitude: -23.5120, longitude: -46.6280 };

const paradas = [
  // pedido da Maria: coleta em A
  { id: 'c1', tipo: 'coleta', pedidoId: 'pedido-maria-A', pedidoGrupoId: 'grupo-maria',
    local: 'Banca A', codigoTicket: 'M1AA', clienteNome: 'Maria',
    latitude: bancaA.latitude, longitude: bancaA.longitude },

  // pedido da Maria: coleta em B
  { id: 'c2', tipo: 'coleta', pedidoId: 'pedido-maria-B', pedidoGrupoId: 'grupo-maria',
    local: 'Banca B', codigoTicket: 'M2BB', clienteNome: 'Maria',
    latitude: bancaB.latitude, longitude: bancaB.longitude },

  // pedido da Flávia: coleta em B (MESMA banca física que o da Maria)
  { id: 'c3', tipo: 'coleta', pedidoId: 'pedido-flavia-B', pedidoGrupoId: 'grupo-flavia',
    local: 'Banca B', codigoTicket: 'F1BB', clienteNome: 'Flávia',
    latitude: bancaB.latitude, longitude: bancaB.longitude },

  // entrega da Maria (grupo dela, pode ter 2 coletas mas 1 entrega só)
  { id: 'e1', tipo: 'entrega', pedidoGrupoId: 'grupo-maria',
    latitude: enderecoMaria.latitude, longitude: enderecoMaria.longitude },

  // entrega da Flávia
  { id: 'e2', tipo: 'entrega', pedidoGrupoId: 'grupo-flavia',
    latitude: enderecoFlavia.latitude, longitude: enderecoFlavia.longitude },
];

const agrupadas = agruparParadasMesmoLocal(paradas);

console.log('Paradas agrupadas:', JSON.stringify(agrupadas, null, 2));

const consolidadas = agrupadas.filter((p) => p.tipo === 'coleta_consolidada');
const coletasSimples = agrupadas.filter((p) => p.tipo === 'coleta');
const entregas = agrupadas.filter((p) => p.tipo === 'entrega');

assert(agrupadas.length === 4, 'total de 4 paradas físicas (A, B-consolidada, entrega Maria, entrega Flávia) em vez de 5');
assert(coletasSimples.length === 1, 'banca A continua como parada simples (só a Maria compra lá)');
assert(consolidadas.length === 1, 'banca B vira UMA parada consolidada');
assert(
  consolidadas[0].pedidos.length === 2,
  'a parada consolidada da banca B carrega os 2 pedidos (Maria e Flávia)'
);
assert(
  consolidadas[0].pedidos.some((p) => p.clienteNome === 'Maria') &&
    consolidadas[0].pedidos.some((p) => p.clienteNome === 'Flávia'),
  'os dois clientes aparecem distintos dentro da mesma parada, cada um com seu ticket'
);
assert(
  new Set(consolidadas[0].pedidos.map((p) => p.codigoTicket)).size === 2,
  'os dois pedidos têm códigos de ticket diferentes (M2BB e F1BB) mesmo na mesma banca'
);
assert(entregas.length === 2, 'as duas entregas continuam separadas (endereços diferentes)');

// ---------------------------------------------------------------------
// Verificação de conclusão parcial: só a Maria confirmou a coleta na banca B
// ---------------------------------------------------------------------
const statusParcial = { 'pedido-maria-B': 'concluida', 'pedido-flavia-B': 'pendente' };
assert(
  !coletaConsolidadaCompleta(consolidadas[0], statusParcial),
  'parada consolidada NÃO fica completa enquanto só 1 dos 2 tickets foi confirmado'
);

const statusCompleto = { 'pedido-maria-B': 'concluida', 'pedido-flavia-B': 'concluida' };
assert(
  coletaConsolidadaCompleta(consolidadas[0], statusCompleto),
  'parada consolidada fica completa quando os 2 tickets são confirmados'
);

console.log('\nTestes de agrupamento concluídos.');
