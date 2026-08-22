'use strict';

const { distanciaKm } = require('./geo');

/**
 * Lógica de proximidade: dado a posição atual do entregador e uma lista
 * de entregas pendentes (já notificadas de "saiu para entrega", ainda
 * não notificadas de "chegando"), retorna quais cruzaram o raio de
 * aviso (padrão: 400m, dentro da faixa 300-500m pedida).
 *
 * A versão autoritativa roda em Postgres (verificar_proximidade_entregas,
 * migration 008) — este módulo espelha a mesma regra em JS só para
 * poder testar o comportamento sem precisar de banco.
 */

const DISTANCIA_AVISO_KM_PADRAO = 0.4;

/**
 * @param {{latitude:number, longitude:number}} posicaoEntregador
 * @param {Array} entregasPendentes - [{ pedidoGrupoId, latitude, longitude,
 *   notificadoACaminho, notificadoProximidade }]
 * @returns {Array} entregas que devem disparar a notificação agora
 */
function verificarProximidade(posicaoEntregador, entregasPendentes, distanciaAvisoKm = DISTANCIA_AVISO_KM_PADRAO) {
  const disparar = [];

  for (const entrega of entregasPendentes) {
    // só avisa proximidade depois de já ter avisado "saiu para entrega",
    // e nunca duas vezes pra mesma entrega
    if (!entrega.notificadoACaminho || entrega.notificadoProximidade) continue;

    const distancia = distanciaKm(posicaoEntregador, entrega);

    if (distancia <= distanciaAvisoKm) {
      disparar.push({
        pedidoGrupoId: entrega.pedidoGrupoId,
        distanciaKm: Number(distancia.toFixed(3)),
      });
    }
  }

  return disparar;
}

module.exports = { verificarProximidade, DISTANCIA_AVISO_KM_PADRAO };
