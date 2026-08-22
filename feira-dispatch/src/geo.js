'use strict';

const EARTH_RADIUS_KM = 6371;
const VELOCIDADE_MEDIA_KMH = 22; // média urbana moto/bike, ajuste conforme seu perfil de entregador

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Distância em km entre dois pontos (lat/lng) via haversine. */
function distanciaKm(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distância total percorrida por uma sequência ordenada de paradas. */
function distanciaTotalRota(paradas, posicaoInicial) {
  if (paradas.length === 0) return 0;
  let total = 0;
  let atual = posicaoInicial;
  for (const parada of paradas) {
    total += distanciaKm(atual, parada);
    atual = parada;
  }
  return total;
}

/** Estimativa simples de tempo (minutos) a partir da distância. */
function estimarMinutos(km) {
  return (km / VELOCIDADE_MEDIA_KMH) * 60;
}

module.exports = { distanciaKm, distanciaTotalRota, estimarMinutos };
