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

    console.log('\n=== CRUD de integracoes: só dono ===');
    {
      const { error: eInsertDono, data: insertDono } = await sessDono.from('integracoes').insert({
        tenant_id: tenantId, brendi_api_key: 'brendi-123', whatsapp_phone_number_id: 'wa-123',
        whatsapp_access_token: 'token-abc', pix_provider: 'mercado_pago', pix_provider_api_key: 'pix-xyz',
      }).select('id').single();
      r.check('dono cria integracoes do próprio tenant', !eInsertDono && insertDono, eInsertDono);

      const { data: readDono, error: eReadDono } = await sessDono.from('integracoes').select('brendi_api_key').eq('tenant_id', tenantId).single();
      r.check('dono lê as próprias integracoes', !eReadDono && readDono && readDono.brendi_api_key === 'brendi-123', { eReadDono, readDono });

      const { error: eUpdateDono } = await sessDono.from('integracoes').update({ pix_provider: 'asaas' }).eq('tenant_id', tenantId);
      const { data: afterUpdate } = await sessDono.from('integracoes').select('pix_provider').eq('tenant_id', tenantId).single();
      r.check('dono atualiza integracoes', !eUpdateDono && afterUpdate.pix_provider === 'asaas', afterUpdate);

      const { data: readFunc, error: eReadFunc } = await sessFunc.from('integracoes').select('brendi_api_key').eq('tenant_id', tenantId);
      r.check('funcionário NÃO consegue ler integracoes (0 linhas, RLS bloqueia por papel antes de qualquer PIN)', !eReadFunc && readFunc && readFunc.length === 0, { eReadFunc, readFunc });

      const { error: eInsertFunc, data: insertFunc } = await sessFunc.from('integracoes').insert({
        tenant_id: tenantId, brendi_api_key: 'tentativa-func',
      }).select('id');
      r.check('funcionário NÃO consegue criar integracoes de outro tenant/mesmo tenant', (!!eInsertFunc || !insertFunc || insertFunc.length === 0), { eInsertFunc, insertFunc });
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
