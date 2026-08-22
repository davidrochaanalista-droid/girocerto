'use strict';

const { validarAlcanceVeiculo } = require('./vehicleRules');
const { distanciaKm } = require('./geo');

/**
 * PROBLEMA DOCUMENTADO (achado na ultra-análise): em plataformas grandes,
 * entregadores de bicicleta relatam ficar horas sem receber pedido porque
 * o sistema prioriza consolidar tudo em rotas de moto (cabe mais peso,
 * mais paradas), mesmo quando o pedido está dentro do raio da bike e ela
 * está disponível e ociosa.
 *
 * Este módulo garante que, antes de oferecer um pedido pra consolidação
 * numa rota de moto já em andamento, o sistema cheque se existe bike
 * disponível, ociosa, dentro do raio dela — e priorize oferecer pra ela.
 */

/**
 * @param {PedidoParaDispatch} pedido
 * @param {Array} bikesDisponiveis - [{ entregadorId, latitude, longitude }]
 *   entregadores de bike com status 'disponivel' e SEM rota em montagem
 * @returns {Object|null} a bike elegível mais próxima, ou null se nenhuma serve
 */
function encontrarBikeOciosaElegivel(pedido, bikesDisponiveis) {
  if (!bikesDisponiveis || bikesDisponiveis.length === 0) return null;

  let melhor = null;
  let melhorDistancia = Infinity;

  for (const bike of bikesDisponiveis) {
    const distColeta = Math.max(...pedido.paradasColeta.map((c) => distanciaKm(bike, c)));
    const distEntrega = Math.max(
      ...pedido.paradasColeta.map((c) => distanciaKm(c, pedido.paradaEntrega))
    );

    const alcance = validarAlcanceVeiculo({
      tipoVeiculo: 'bicicleta',
      tipoPerfil: pedido.tipoPerfil,
      distanciaColetaKm: distColeta,
      distanciaEntregaKm: distEntrega,
      pesoKg: pedido.pesoTotal,
    });

    if (alcance.valido && distColeta < melhorDistancia) {
      melhor = bike;
      melhorDistancia = distColeta;
    }
  }

  return melhor;
}

/**
 * Decide a prioridade de oferta: se existe bike ociosa elegível, o
 * pedido deve ser oferecido a ela ANTES de tentar consolidar numa rota
 * de moto já em andamento — mesmo que a inserção na moto seja
 * "mais eficiente" em termos de distância total da frota.
 *
 * Isso é uma escolha deliberada de justiça operacional sobre a bike,
 * não uma otimização pura de distância — sem essa regra explícita, o
 * algoritmo de menor custo natural sempre favorece consolidar (é
 * "mais barato" pra frota), o que é exatamente o padrão que gerou a
 * reclamação documentada.
 */
function priorizarOfertaJusta(pedido, bikesDisponiveis) {
  const bikeElegivel = encontrarBikeOciosaElegivel(pedido, bikesDisponiveis);

  if (bikeElegivel) {
    return {
      estrategia: 'ofertar_bike_ociosa',
      destino: bikeElegivel,
      motivo: 'bike disponível e ociosa dentro do raio dela — priorizada sobre consolidação em moto',
    };
  }

  return {
    estrategia: 'seguir_fluxo_normal',
    destino: null,
    motivo: bikesDisponiveis?.length
      ? 'bikes disponíveis existem, mas nenhuma dentro do raio/peso — segue pro motor de inserção normal'
      : 'nenhuma bike ociosa no momento — segue pro motor de inserção normal',
  };
}

module.exports = { encontrarBikeOciosaElegivel, priorizarOfertaJusta };
