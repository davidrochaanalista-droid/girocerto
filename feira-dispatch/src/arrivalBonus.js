'use strict';

const { distanciaKm } = require('./geo');

/**
 * PROBLEMA CORRIGIDO AQUI: no checkout, `feeCalculator.js` cobra um
 * "baseDeslocamento" fixo de R$4 do cliente, pensado como "chegar até a
 * feira" — mas isso é chutado, porque no checkout ninguém sabe ainda
 * qual entregador vai pegar a corrida nem de onde ele vai sair. Um
 * entregador a 12km da feira fica subpago; um que já está do lado
 * fica sendo pago por uma distância que não percorreu.
 *
 * Correção: esse componente sai do preço fixo pago pelo CLIENTE e vira
 * um bônus calculado com distância REAL, pago pela PLATAFORMA no
 * momento em que o entregador de fato aceita a corrida — é o único
 * momento em que dá pra saber de onde ele está saindo.
 */

const VALOR_KM_MOTO_CHEGADA = 1.8; // mesma taxa usada no trecho até o cliente, por consistência
const DISTANCIA_MAXIMA_SUBSIDIADA_KM = 15; // acima disso, a plataforma não oferece a corrida pra esse entregador

/**
 * @param {{latitude:number, longitude:number}} posicaoEntregador - no momento do aceite
 * @param {{latitude:number, longitude:number}} primeiraParada - primeira coleta da rota
 * @returns {{distanciaKm:number, bonus:number, dentroDoLimite:boolean}}
 */
function calcularBonusChegada(posicaoEntregador, primeiraParada, valorKm = VALOR_KM_MOTO_CHEGADA) {
  const distancia = distanciaKm(posicaoEntregador, primeiraParada);
  const dentroDoLimite = distancia <= DISTANCIA_MAXIMA_SUBSIDIADA_KM;

  return {
    distanciaKm: Number(distancia.toFixed(3)),
    bonus: Number((distancia * valorKm).toFixed(2)),
    dentroDoLimite,
  };
}

module.exports = { calcularBonusChegada, VALOR_KM_MOTO_CHEGADA, DISTANCIA_MAXIMA_SUBSIDIADA_KM };
