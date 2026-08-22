'use strict';

const { verificarProximidade, DISTANCIA_AVISO_KM_PADRAO } = require('../proximityNotifier');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

const enderecoCliente = { latitude: -23.5100, longitude: -46.6300 };

// ---------------------------------------------------------------------
// 1. Entregador longe (2km) — não dispara nada ainda
// ---------------------------------------------------------------------
console.log('--- Entregador longe (2km) ---');
const posicaoLonge = { latitude: -23.4950, longitude: -46.6150 };
const entregaBase = {
  pedidoGrupoId: 'g1',
  latitude: enderecoCliente.latitude,
  longitude: enderecoCliente.longitude,
  notificadoACaminho: true,
  notificadoProximidade: false,
};

const resultado1 = verificarProximidade(posicaoLonge, [entregaBase]);
assert(resultado1.length === 0, 'a 2km de distância, nenhuma notificação dispara ainda');

// ---------------------------------------------------------------------
// 2. Entregador a ~350m — dentro da faixa pedida (300-500m), dispara
// ---------------------------------------------------------------------
console.log('\n--- Entregador a ~350m ---');
const posicaoPerto = { latitude: -23.5100 - 0.0032, longitude: -46.6300 };
const resultado2 = verificarProximidade(posicaoPerto, [entregaBase]);
console.log(resultado2);
assert(resultado2.length === 1, 'a ~350m, a notificação de proximidade dispara');
assert(resultado2[0].pedidoGrupoId === 'g1', 'dispara pro pedido_grupo certo');
assert(
  resultado2[0].distanciaKm <= DISTANCIA_AVISO_KM_PADRAO,
  `distância calculada (${resultado2[0].distanciaKm}km) está dentro do raio configurado (${DISTANCIA_AVISO_KM_PADRAO}km)`
);

// ---------------------------------------------------------------------
// 3. Não dispara duas vezes — já notificado antes
// ---------------------------------------------------------------------
console.log('\n--- Já notificado antes (não deve repetir) ---');
const entregaJaNotificada = { ...entregaBase, notificadoProximidade: true };
const resultado3 = verificarProximidade(posicaoPerto, [entregaJaNotificada]);
assert(resultado3.length === 0, 'entrega já notificada de proximidade não dispara de novo');

// ---------------------------------------------------------------------
// 4. Não dispara proximidade se "saiu para entrega" nunca foi enviado
// ---------------------------------------------------------------------
console.log('\n--- Sem aviso de "saiu para entrega" ainda ---');
const entregaSemSaida = { ...entregaBase, notificadoACaminho: false };
const resultado4 = verificarProximidade(posicaoPerto, [entregaSemSaida]);
assert(
  resultado4.length === 0,
  'sem ter avisado "saiu para entrega" antes, a notificação de proximidade não dispara sozinha'
);

// ---------------------------------------------------------------------
// 5. Múltiplos clientes na mesma rota — cada um dispara independente
// ---------------------------------------------------------------------
console.log('\n--- Múltiplas entregas na mesma rota, distâncias diferentes ---');
const enderecoRenata = { latitude: -23.5100, longitude: -46.6300 };
const enderecoBruno = { latitude: -23.5300, longitude: -46.6500 };

const entregas = [
  { pedidoGrupoId: 'renata', ...enderecoRenata, notificadoACaminho: true, notificadoProximidade: false },
  { pedidoGrupoId: 'bruno', ...enderecoBruno, notificadoACaminho: true, notificadoProximidade: false },
];

const resultado5 = verificarProximidade(posicaoPerto, entregas);
console.log(resultado5);
assert(
  resultado5.length === 1 && resultado5[0].pedidoGrupoId === 'renata',
  'só a Renata (que está perto) recebe o aviso agora — o Bruno ainda está longe'
);

console.log('\nTestes de notificação de proximidade concluídos.');
