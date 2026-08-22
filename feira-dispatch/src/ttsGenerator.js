'use strict';

/**
 * Gera áudio de voz PERSONALIZADO (com nome do cliente) sob demanda,
 * via ElevenLabs. Diferente do áudio fixo usado no push_voz (que é
 * genérico e pré-gravado, porque o "som de notificação" do sistema
 * operacional não pode ser gerado dinamicamente por mensagem), este
 * áudio é criado na hora e enviado como NOTA DE VOZ pelo WhatsApp —
 * isso é uma mensagem normal de áudio, então pode ser 100% personalizada.
 *
 * IMPORTANTE — o que isso é e não é:
 * - É uma nota de voz de verdade, com "Olá, [nome]!..." falado,
 *   que o cliente recebe e pode tocar.
 * - NÃO toca sozinha com o celular bloqueado (é uma mensagem de
 *   WhatsApp — o cliente precisa abrir e apertar play, como qualquer
 *   áudio recebido). Pra tocar sozinho com tela bloqueada, só o
 *   push_voz do app nativo resolve (ver notifications.js).
 * - Funciona HOJE, sem precisar de app nativo — só precisa da API key.
 *
 * Requer conta ElevenLabs (plano gratuito cobre ~10.000 caracteres/mês,
 * suficiente pra centenas de notificações curtas como essas).
 */

const ELEVENLABS_VOICE_ID_PADRAO = 'JBFqnCBsd6RMkjVDRZzb'; // troque pela voz PT-BR escolhida no Voice Library

async function gerarAudioPersonalizado(texto, { vozId = ELEVENLABS_VOICE_ID_PADRAO } = {}) {
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vozId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: texto,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.45, // menor = mais expressivo/entusiasmado, maior = mais neutro/formal
        similarity_boost: 0.8,
        style: 0.35, // adiciona entusiasmo perceptível sem exagerar
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`ElevenLabs respondeu ${resp.status}: ${await resp.text()}`);
  }

  return Buffer.from(await resp.arrayBuffer()); // mp3 pronto
}

/**
 * Monta o texto final já com a buzina indicada por tag (o ElevenLabs
 * não gera efeitos sonoros de buzina — isso precisa ser concatenado
 * depois, ver mixarComBuzina() abaixo).
 *
 * Correção (22/08/2026): removido o tratamento formal Sr./Sra. — só
 * buzina + primeiro nome, sem honorífico. `genero` deixou de ser
 * necessário pra esse texto (não tinha outro uso).
 */
function montarTextoSaiuEntrega({ nomeCliente }) {
  return `Olá, ${nomeCliente}! Seu pedido está a caminho.`;
}

function montarTextoProximidade({ nomeCliente }) {
  return `${nomeCliente}, seu pedido está chegando! Vá até a portaria ou o portão, por favor.`;
}

module.exports = {
  gerarAudioPersonalizado,
  montarTextoSaiuEntrega,
  montarTextoProximidade,
  ELEVENLABS_VOICE_ID_PADRAO,
};
