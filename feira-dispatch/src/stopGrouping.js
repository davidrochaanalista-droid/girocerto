'use strict';

const { distanciaKm } = require('./geo');

/**
 * PROBLEMA REAL: Maria compra na banca A e na banca B. Flávia compra só
 * na banca B. Se as duas ficam prontas na mesma janela e entram na mesma
 * rota, o motor de dispatch gera duas `rota_parada` tipo 'coleta' na
 * banca B — uma pro pedido da Maria, outra pro da Flávia. Fisicamente
 * é UMA visita só: o entregador não vai na banca B duas vezes.
 *
 * Este módulo agrupa paradas de coleta que ficam no mesmo local físico
 * (mesma banca, tolerância de alguns metros) numa única parada visitável,
 * mantendo os pedidos/tickets individuais dentro do grupo — cada um com
 * seu próprio código de 4 caracteres, conferido separadamente.
 */

const TOLERANCIA_KM_MESMO_LOCAL = 0.015; // ~15 metros

/**
 * @param {Array} paradas - sequência já otimizada (routeOptimizer), cada uma:
 *   { id, tipo, pedidoId, pedidoGrupoId, latitude, longitude, codigoTicket?, clienteNome? }
 * @returns {Array} paradas agrupadas — cada item é uma parada normal (entrega)
 *   OU uma parada consolidada { tipo: 'coleta_consolidada', local, pedidos: [...] }
 */
function agruparParadasMesmoLocal(paradas) {
  const resultado = [];
  const usados = new Set();

  for (let i = 0; i < paradas.length; i++) {
    if (usados.has(i)) continue;
    const atual = paradas[i];

    if (atual.tipo !== 'coleta') {
      resultado.push(atual);
      continue;
    }

    // procura TODAS as outras coletas (não só a vizinha imediata) que
    // caem no mesmo local físico — cobre o caso de pedidos que ficaram
    // prontos em momentos diferentes e não ficaram adjacentes na sequência
    const grupo = [atual];
    usados.add(i);

    for (let j = i + 1; j < paradas.length; j++) {
      if (usados.has(j)) continue;
      const candidata = paradas[j];
      if (candidata.tipo !== 'coleta') continue;

      const d = distanciaKm(atual, candidata);
      if (d <= TOLERANCIA_KM_MESMO_LOCAL) {
        grupo.push(candidata);
        usados.add(j);
      }
    }

    if (grupo.length === 1) {
      resultado.push(atual);
    } else {
      resultado.push({
        tipo: 'coleta_consolidada',
        latitude: atual.latitude,
        longitude: atual.longitude,
        local: atual.local, // nome da banca
        pedidos: grupo.map((p) => ({
          pedidoId: p.pedidoId,
          pedidoGrupoId: p.pedidoGrupoId,
          codigoTicket: p.codigoTicket,
          clienteNome: p.clienteNome,
        })),
      });
    }
  }

  return resultado;
}

/**
 * Verifica se uma parada consolidada está totalmente concluída
 * (todos os pedidos do grupo confirmados na coleta).
 */
function coletaConsolidadaCompleta(paradaConsolidada, statusPorPedidoId) {
  return paradaConsolidada.pedidos.every((p) => statusPorPedidoId[p.pedidoId] === 'concluida');
}

module.exports = { agruparParadasMesmoLocal, coletaConsolidadaCompleta, TOLERANCIA_KM_MESMO_LOCAL };
