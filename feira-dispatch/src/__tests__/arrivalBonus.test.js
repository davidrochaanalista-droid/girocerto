'use strict';

const { calcularBonusChegada, DISTANCIA_MAXIMA_SUBSIDIADA_KM } = require('../arrivalBonus');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

const primeiraParada = { latitude: -23.5000, longitude: -46.6200 };

// entregador bem perto (mesmo bairro da feira)
const perto = { latitude: -23.4995, longitude: -46.6195 };
const bonusPerto = calcularBonusChegada(perto, primeiraParada);
console.log('Entregador perto:', bonusPerto);
assert(bonusPerto.bonus < 1, 'entregador já perto da feira recebe bônus quase zero — justo, não andou quase nada');

// entregador longe (~8km)
const longe = { latitude: -23.560, longitude: -46.680 };
const bonusLonge = calcularBonusChegada(longe, primeiraParada);
console.log('Entregador longe:', bonusLonge);
assert(bonusLonge.bonus > 10, 'entregador longe recebe bônus proporcional real, não mais o fixo R$4 injusto');

// entregador fora do raio subsidiado
const muitoLonge = { latitude: -23.700, longitude: -46.800 };
const bonusMuitoLonge = calcularBonusChegada(muitoLonge, primeiraParada);
console.log('Entregador muito longe:', bonusMuitoLonge);
assert(
  !bonusMuitoLonge.dentroDoLimite,
  `acima de ${DISTANCIA_MAXIMA_SUBSIDIADA_KM}km a plataforma não oferece a corrida pra esse entregador (evita prejuízo)`
);

console.log('\nTestes de bônus de chegada concluídos.');
