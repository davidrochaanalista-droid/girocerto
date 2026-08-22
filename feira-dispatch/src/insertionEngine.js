'use strict';

const { distanciaKm, distanciaTotalRota } = require('./geo');
const { otimizarRota, sequenciaValida } = require('./routeOptimizer');
const { validarAlcanceVeiculo } = require('./vehicleRules');

/**
 * @typedef {Object} PedidoParaDispatch
 * @property {string} pedidoGrupoId
 * @property {string} tipoPerfil - 'feira' | 'restaurante' | 'misto'
 * @property {number} pesoTotal
 * @property {Array} paradasColeta - [{ pedidoId, pedidoGrupoId, latitude, longitude }]
 * @property {Object} paradaEntrega - { pedidoGrupoId, latitude, longitude }
 */

/**
 * @typedef {Object} RotaCandidata
 * @property {string} entregaRotaId
 * @property {string} tipoPerfil
 * @property {string} tipoVeiculo - 'moto' | 'bicicleta', do entregador dono da rota
 * @property {number} pesoTotalAtual
 * @property {Array} paradasAtuais - sequência atual de paradas (coleta/entrega)
 * @property {{latitude:number, longitude:number}} posicaoEntregador
 */

/**
 * Calcula o custo de inserir um pedido numa rota candidata.
 * Retorna null se violar alguma restrição (peso, paradas, detour,
 * ou os raios de coleta/entrega do veículo específico dessa rota).
 */
function calcularCustoInsercao(rota, pedido, config) {
  const pesoResultante = rota.pesoTotalAtual + pedido.pesoTotal;

  const paradasNovas = pedido.paradasColeta.length + 1; // +1 = entrega
  const paradasResultantes = rota.paradasAtuais.length + paradasNovas;
  if (paradasResultantes > config.maxParadas) return null;

  const novasParadas = [
    ...pedido.paradasColeta.map((c) => ({
      id: `coleta-${c.pedidoId}`,
      tipo: 'coleta',
      pedidoId: c.pedidoId,
      pedidoGrupoId: c.pedidoGrupoId,
      latitude: c.latitude,
      longitude: c.longitude,
    })),
    {
      id: `entrega-${pedido.pedidoGrupoId}`,
      tipo: 'entrega',
      pedidoGrupoId: pedido.pedidoGrupoId,
      latitude: pedido.paradaEntrega.latitude,
      longitude: pedido.paradaEntrega.longitude,
    },
  ];

  // ------- validação de alcance do veículo desta rota específica -------
  // distância de coleta = pior caso entre as novas coletas e a posição
  // atual do entregador (cobre tanto abrir rota nova quanto inserir numa
  // rota que já está em andamento, partindo de onde ele está agora)
  const distanciaColetaKm = Math.max(
    ...pedido.paradasColeta.map((c) => distanciaKm(rota.posicaoEntregador, c))
  );
  const distanciaEntregaKm = Math.max(
    ...pedido.paradasColeta.map((c) => distanciaKm(c, pedido.paradaEntrega))
  );

  const alcance = validarAlcanceVeiculo({
    tipoVeiculo: rota.tipoVeiculo,
    tipoPerfil: pedido.tipoPerfil,
    distanciaColetaKm,
    distanciaEntregaKm,
    pesoKg: pesoResultante,
  });
  if (!alcance.valido) return null;
  // -----------------------------------------------------------------

  const distanciaAntes = distanciaTotalRota(rota.paradasAtuais, rota.posicaoEntregador);

  const paradasCombinadas = [...rota.paradasAtuais, ...novasParadas];
  const { sequencia, distanciaKm: distanciaDepois } = otimizarRota(
    paradasCombinadas,
    rota.posicaoEntregador
  );

  if (!sequenciaValida(sequencia)) return null;

  const distanciaExtra = distanciaDepois - distanciaAntes;
  const detourPct = distanciaAntes === 0 ? 0 : distanciaExtra / distanciaAntes;

  // rota vazia (primeira inserção) sempre passa no teste de detour
  if (rota.paradasAtuais.length > 0 && detourPct > config.maxDetourPct) return null;

  return {
    distanciaExtra,
    detourPct,
    sequenciaResultante: sequencia,
    distanciaTotalResultante: distanciaDepois,
  };
}

/**
 * Escolhe a melhor rota candidata (menor custo de inserção) para um pedido.
 * @param {PedidoParaDispatch} pedido
 * @param {RotaCandidata[]} rotasCandidatas
 * @param {Object} config - { pesoMaxKg, maxParadas, maxDetourPct }
 * @returns {{rota: RotaCandidata, resultado: Object} | null}
 */
function encontrarMelhorInsercao(pedido, rotasCandidatas, config) {
  let melhor = null;

  for (const rota of rotasCandidatas) {
    if (rota.tipoPerfil !== pedido.tipoPerfil && rota.tipoPerfil !== 'misto') continue;
    // cada rota já pertence a um entregador com veículo fixo — o filtro
    // de alcance por veículo acontece dentro de calcularCustoInsercao
    const resultado = calcularCustoInsercao(rota, pedido, config);
    if (!resultado) continue;

    if (!melhor || resultado.distanciaExtra < melhor.resultado.distanciaExtra) {
      melhor = { rota, resultado };
    }
  }

  return melhor;
}

module.exports = { calcularCustoInsercao, encontrarMelhorInsercao };
