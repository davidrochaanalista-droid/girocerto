// Integrações: CRUD só pro dono, funcionário bloqueado mesmo pedindo o PIN
// certo (a checagem de papel bloqueia antes disso), fluxo completo de PIN
// (set_pin_integracoes, verificar_pin_integracoes com tentativa certa e
// errada, tem_pin_integracoes).
//
// Não existe fluxo client-side de criar funcionário (usuarios_loja só permite
// auto-insert como dono, primeiro vínculo — CLAUDE.md). Pra montar o cenário
// "funcionário existe", inserimos o vínculo via conexão postgres direta
// (equivalente a service role), do mesmo jeito que isso seria feito por um
// backend/admin de verdade.
const crypto = require('crypto');
const { newPgClient, createAuthUser, signInAs, makeReporter, cleanup } = require('./lib/helpers');

async function run() {
  const r = makeReporter('integracoes');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja Integracoes')`, [tenantId]);
    tenantIds.push(tenantId);

    const donoUser = await createAuthUser('dono.integracoes');
    authUserIds.push(donoUser.id);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono','dono')`, [tenantId, donoUser.id]);
    const sessDono = await signInAs(donoUser.email);

    const funcUser = await createAuthUser('funcionario.integracoes');
    authUserIds.push(funcUser.id);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Funcionario','funcionario')`, [tenantId, funcUser.id]);
    const sessFunc = await signInAs(funcUser.email);

    console.log('\n=== CRUD de integracoes: item 109 (05/09/2026) — credenciais cifradas em repouso, só via RPC ===');
    {
      const { error: eSalvarDono } = await sessDono.rpc('salvar_integracoes_seguro', {
        p_campos: {
          brendi_api_key: 'brendi-123', whatsapp_phone_number_id: 'wa-123',
          whatsapp_access_token: 'token-abc', pix_provider: 'mercado_pago', pix_provider_api_key: 'pix-xyz',
        },
      });
      r.check('dono salva integracoes do próprio tenant via salvar_integracoes_seguro()', !eSalvarDono, eSalvarDono);

      const { data: carregado, error: eCarregarDono } = await sessDono.rpc('carregar_integracoes_segura');
      const linhaDono = (carregado || [])[0];
      r.check('dono lê as próprias integracoes decifradas via carregar_integracoes_segura()', !eCarregarDono && linhaDono && linhaDono.brendi_api_key === 'brendi-123', { eCarregarDono, linhaDono });

      const { error: eDireto } = await sessDono.from('integracoes').insert({ tenant_id: tenantId, brendi_api_key: 'tentativa-direta' });
      r.check('dono NÃO consegue inserir direto na tabela (sem policy de insert de propósito, só a RPC escreve)', !!eDireto, eDireto);

      const { rows: linhaCrua } = await pg.query(`select brendi_api_key from integracoes where tenant_id = $1`, [tenantId]);
      r.check('valor armazenado no banco é bytea cifrado, nunca o texto puro "brendi-123"', Buffer.isBuffer(linhaCrua[0].brendi_api_key), linhaCrua[0]);

      const { error: eAtualizarDono } = await sessDono.rpc('salvar_integracoes_seguro', {
        p_campos: { pix_provider: 'asaas', pix_provider_api_key: 'pix-xyz' },
      });
      const { data: aposAtualizar } = await sessDono.rpc('carregar_integracoes_segura');
      r.check('dono atualiza integracoes via RPC (upsert)', !eAtualizarDono && aposAtualizar[0].pix_provider === 'asaas', { eAtualizarDono, aposAtualizar });

      const { data: readFunc, error: eReadFunc } = await sessFunc.from('integracoes').select('brendi_api_key').eq('tenant_id', tenantId);
      r.check('funcionário NÃO consegue ler integracoes direto (0 linhas, RLS bloqueia por papel antes de qualquer PIN)', !eReadFunc && readFunc && readFunc.length === 0, { eReadFunc, readFunc });

      const { error: eSalvarFunc } = await sessFunc.rpc('salvar_integracoes_seguro', { p_campos: { brendi_api_key: 'tentativa-func' } });
      r.check('funcionário NÃO consegue salvar integracoes via RPC (checagem de papel=dono dentro da função)', !!eSalvarFunc, eSalvarFunc);

      const { data: carregarFunc, error: eCarregarFunc } = await sessFunc.rpc('carregar_integracoes_segura');
      r.check('funcionário NÃO consegue carregar integracoes via RPC', !!eCarregarFunc, { eCarregarFunc, carregarFunc });

      const { error: eHelperVazado } = await sessDono.rpc('_chave_criptografia_integracoes');
      r.check('achado real (item 109): helper interno da chave de criptografia não é chamável por nenhum client (revoke explícito de authenticated/anon, não só public)', !!eHelperVazado, eHelperVazado);
    }

    console.log('\n=== Fluxo de PIN: set, verificar (certo e errado), tem_pin ===');
    {
      const { data: temPinAntes } = await sessDono.rpc('tem_pin_integracoes');
      r.check('tem_pin_integracoes() = false antes de definir', temPinAntes === false, temPinAntes);

      const { error: eSet } = await sessDono.rpc('set_pin_integracoes', { novo_pin: '1234' });
      r.check('dono define o PIN via set_pin_integracoes()', !eSet, eSet);

      const { data: temPinDepois } = await sessDono.rpc('tem_pin_integracoes');
      r.check('tem_pin_integracoes() = true depois de definir', temPinDepois === true, temPinDepois);

      const { data: pinCerto, error: eCerto } = await sessDono.rpc('verificar_pin_integracoes', { tentativa: '1234' });
      r.check('verificar_pin_integracoes() com o PIN certo retorna true', !eCerto && pinCerto === true, { eCerto, pinCerto });

      const { data: pinErrado, error: eErrado } = await sessDono.rpc('verificar_pin_integracoes', { tentativa: '0000' });
      r.check('verificar_pin_integracoes() com PIN errado retorna false', !eErrado && pinErrado === false, { eErrado, pinErrado });

      // funcionário: a checagem de papel na função (where ... and papel = 'dono') já
      // bloqueia antes de chegar em qualquer comparação de PIN — mesmo com o PIN
      // certo, funcionário nunca teria como acertar porque nunca definiu PIN próprio
      // (a função sempre filtra por papel='dono', não existe PIN de funcionário).
      const { data: funcTemPin } = await sessFunc.rpc('tem_pin_integracoes');
      r.check('funcionário: tem_pin_integracoes() = false (checagem sempre filtra papel=dono, funcionário não tem PIN próprio)', funcTemPin === false, funcTemPin);

      const { data: funcVerifica } = await sessFunc.rpc('verificar_pin_integracoes', { tentativa: '1234' });
      r.check('funcionário tentando o PIN correto do DONO via verificar_pin_integracoes() ainda retorna false (função só olha papel=dono do PRÓPRIO auth.uid())', funcVerifica === false, funcVerifica);
    }

    console.log('\n=== Fix do item 68 (31/08/2026): trocar PIN existente exige o PIN atual ===');
    {
      const { error: eSemAtual } = await sessDono.rpc('set_pin_integracoes', { novo_pin: '5678' });
      r.check('trocar PIN sem informar o atual falha (PIN já existe, definido acima)', !!eSemAtual, eSemAtual);

      const { error: eAtualErrado } = await sessDono.rpc('set_pin_integracoes', { novo_pin: '5678', pin_atual: '0000' });
      r.check('trocar PIN com o atual errado falha', !!eAtualErrado, eAtualErrado);

      const { data: aindaOAntigo } = await sessDono.rpc('verificar_pin_integracoes', { tentativa: '1234' });
      r.check('PIN antigo continua valendo depois das tentativas falhas', aindaOAntigo === true, aindaOAntigo);

      const { error: eAtualCerto } = await sessDono.rpc('set_pin_integracoes', { novo_pin: '5678', pin_atual: '1234' });
      r.check('trocar PIN com o atual certo funciona', !eAtualCerto, eAtualCerto);

      const { data: novoValeu } = await sessDono.rpc('verificar_pin_integracoes', { tentativa: '5678' });
      r.check('PIN novo passa a valer depois da troca', novoValeu === true, novoValeu);

      const { data: antigoNaoValeMais } = await sessDono.rpc('verificar_pin_integracoes', { tentativa: '1234' });
      r.check('PIN antigo para de valer depois da troca', antigoNaoValeMais === false, antigoNaoValeMais);
    }

    console.log('\n=== Fix do item 68: hash do PIN não vaza mais por SELECT normal de usuarios_loja ===');
    {
      const { rows: colunaSumiu } = await pg.query(
        `select column_name from information_schema.columns where table_name = 'usuarios_loja' and column_name = 'pin_integracoes_hash'`
      );
      r.check('coluna pin_integracoes_hash não existe mais em usuarios_loja', colunaSumiu.length === 0, colunaSumiu);

      // usuarios_loja_pin não tem NENHUMA policy — nem o próprio dono lê direto,
      // só via RPC. Um select comum (mesmo do dono da linha) deve voltar vazio.
      const { data: donoTentaLerDireto } = await sessDono.from('usuarios_loja_pin').select('*');
      r.check('nem o dono consegue ler usuarios_loja_pin direto (sem policy nenhuma de propósito, só as 3 funções tocam)', Array.isArray(donoTentaLerDireto) && donoTentaLerDireto.length === 0, donoTentaLerDireto);
    }

    return r.summary();
  } finally {
    await cleanup(pg, tenantIds, authUserIds);
    await pg.end();
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
