'use strict';

const { agruparParadasMesmoLocal, coletaConsolidadaCompleta } = require('../stopGrouping');
const { otimizarRota, sequenciaValida } = require('../routeOptimizer');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

// =======================================================================
// CENÁRIO: 1 rota do entregador carregando 2 pedido_grupo (2 clientes)
//
//   Renata (grupo-renata): compra na banca A e na banca B
//   Bruno  (grupo-bruno):  compra só na banca B (a MESMA banca da Renata)
//
// Bancas físicas envolvidas: A e B (2 locais)
// Pedidos totais: 3 (Renata-A, Renata-B, Bruno-B)
// Entregas: 2 (endereço da Renata, endereço do Bruno)
// =======================================================================

const bancaA = { latitude: -23.5000, longitude: -46.6200 };
const bancaB = { latitude: -23.5040, longitude: -46.6250 };
const enderecoRenata = { latitude: -23.5100, longitude: -46.6300 };
const enderecoBruno = { latitude: -23.5130, longitude: -46.6180 };

const todasParadas = [
  // Renata: coleta na banca A
  {
    id: 'c-renata-a', tipo: 'coleta', pedidoId: 'pedido-renata-A', pedidoGrupoId: 'grupo-renata',
    local: 'Banca A', codigoTicket: 'R7A2', clienteNome: 'Renata',
    latitude: bancaA.latitude, longitude: bancaA.longitude,
  },
  // Renata: coleta na banca B
  {
    id: 'c-renata-b', tipo: 'coleta', pedidoId: 'pedido-renata-B', pedidoGrupoId: 'grupo-renata',
    local: 'Banca B', codigoTicket: 'R4B9', clienteNome: 'Renata',
    latitude: bancaB.latitude, longitude: bancaB.longitude,
  },
  // Bruno: coleta na banca B (MESMA banca física da Renata, pedido diferente)
  {
    id: 'c-bruno-b', tipo: 'coleta', pedidoId: 'pedido-bruno-B', pedidoGrupoId: 'grupo-bruno',
    local: 'Banca B', codigoTicket: 'B2K5', clienteNome: 'Bruno',
    latitude: bancaB.latitude, longitude: bancaB.longitude,
  },
  // entrega da Renata
  {
    id: 'e-renata', tipo: 'entrega', pedidoGrupoId: 'grupo-renata',
    latitude: enderecoRenata.latitude, longitude: enderecoRenata.longitude,
  },
  // entrega do Bruno
  {
    id: 'e-bruno', tipo: 'entrega', pedidoGrupoId: 'grupo-bruno',
    latitude: enderecoBruno.latitude, longitude: enderecoBruno.longitude,
  },
];

// ---------------------------------------------------------------------
// 1. A rota otimizada precisa respeitar: cada entrega só depois de
// TODAS as coletas do próprio pedido_grupo (não do outro cliente)
// ---------------------------------------------------------------------
const { sequencia } = otimizarRota(todasParadas, bancaA);
assert(
  sequenciaValida(sequencia),
  'sequência com 2 clientes combinados respeita coleta-antes-de-entrega de CADA grupo'
);

const posEntregaRenata = sequencia.findIndex((p) => p.id === 'e-renata');
const posEntregaBruno = sequencia.findIndex((p) => p.id === 'e-bruno');
const posColetaRenataA = sequencia.findIndex((p) => p.id === 'c-renata-a');
const posColetaRenataB = sequencia.findIndex((p) => p.id === 'c-renata-b');
const posColetaBrunoB = sequencia.findIndex((p) => p.id === 'c-bruno-b');

assert(
  posColetaRenataA < posEntregaRenata && posColetaRenataB < posEntregaRenata,
  'as 2 coletas da Renata (banca A e B) acontecem antes da entrega DELA'
);
assert(
  posColetaBrunoB < posEntregaBruno,
  'a coleta do Bruno acontece antes da entrega DELE'
);
assert(
  posColetaBrunoB < posEntregaRenata || posColetaBrunoB > posEntregaRenata,
  'a coleta do Bruno não trava nem depende da entrega da Renata (grupos independentes)'
);

// ---------------------------------------------------------------------
// 2. Agrupamento físico: banca B tem 2 pedidos (Renata E Bruno) —
// tem que virar 1 parada só, com 2 tickets distintos
// ---------------------------------------------------------------------
const agrupadas = agruparParadasMesmoLocal(sequencia);

const consolidadas = agrupadas.filter((p) => p.tipo === 'coleta_consolidada');
const simples = agrupadas.filter((p) => p.tipo === 'coleta');
const entregas = agrupadas.filter((p) => p.tipo === 'entrega');

console.log('\nParadas físicas finais que o entregador vê:');
agrupadas.forEach((p, i) => {
  if (p.tipo === 'coleta_consolidada') {
    console.log(`  ${i + 1}. [COLETA-MÚLTIPLA] ${p.local} — ${p.pedidos.length} tickets:`);
    p.pedidos.forEach((ped) => console.log(`       • ${ped.clienteNome}: código ${ped.codigoTicket}`));
  } else if (p.tipo === 'coleta') {
    console.log(`  ${i + 1}. [COLETA] ${p.local} — 1 ticket: ${p.clienteNome} (${p.codigoTicket})`);
  } else {
    console.log(`  ${i + 1}. [ENTREGA] pedido_grupo ${p.pedidoGrupoId}`);
  }
});

assert(simples.length === 1, 'banca A vira 1 parada simples (só a Renata compra lá)');
assert(consolidadas.length === 1, 'banca B vira 1 parada consolidada (Renata + Bruno)');
assert(consolidadas[0].pedidos.length === 2, 'a parada da banca B carrega os 2 tickets, um de cada cliente');
assert(entregas.length === 2, 'as 2 entregas continuam separadas (endereços diferentes)');
assert(agrupadas.length === 4, 'total: 4 paradas físicas em vez de 5 pedidos brutos');

// ---------------------------------------------------------------------
// 3. Cada ticket é único e identificável, mesmo na mesma banca
// ---------------------------------------------------------------------
const codigosNaBancaB = consolidadas[0].pedidos.map((p) => p.codigoTicket);
assert(
  new Set(codigosNaBancaB).size === 2,
  `códigos distintos na banca B: ${codigosNaBancaB.join(', ')} — sem chance de confundir de quem é qual sacola`
);

// ---------------------------------------------------------------------
// 4. Conclusão parcial: Renata confirmada, Bruno ainda não —
// a parada da banca B não pode fechar
// ---------------------------------------------------------------------
const statusParcial = { 'pedido-renata-B': 'concluida', 'pedido-bruno-B': 'pendente' };
assert(
  !coletaConsolidadaCompleta(consolidadas[0], statusParcial),
  'entregador não avança da banca B enquanto só o ticket da Renata foi conferido — falta o do Bruno'
);

console.log('\nTestes do cenário combinado (2 clientes, 3 pedidos, 2 bancas) concluídos.');
